/* eslint-disable no-console */
// 探针：```diagram（JSON 中间层）渲染链路的**真浏览器**契约
//   1. 渲染器产物过**同一道白名单**（sanitizeSvg）—— 纵深防御那一挡真的存在
//   2. 产物被做脏时闸门真的会动作（外部 url() 拒、<script> 剥）
//   3. 流式预览的每个 shape 单独过 sanitizeSvgFragment；key 单调、末拍收敛到完整渲染
//   4. show_widget 的 diagram 预检与渲染层同源（回执里的 JSON round-trip 仍干净）
//   5. 插进真 DOM：尺寸非零、文字有宽度、恶意标签按纯文本显示（不执行）
//
// 为什么用真浏览器：DOMPurify 要 window；「HTML 解析器会不会把 viewBox 的大小写吃掉」
// 「渲染器多吐一个白名单外标签时会被谁拦下」这些问题只有真解析器说了算。
//
// 用法：node scripts/probe-json-diagram.mjs   （需先 npm run dev）
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => {
  failed++;
  console.error(`   ❌ ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(BASE, { waitUntil: 'networkidle' });

// 页面内一次跑完：模块句柄复用，且能直接操作 DOM
const result = await page.evaluate(async () => {
  const { renderDiagram } = await import('/src/components/mermaid/diagramRender.ts');
  const { validateDiagram } = await import('/src/components/mermaid/diagramSchema.ts');
  const { peekDiagramProgress } = await import('/src/components/mermaid/diagramStream.ts');
  const { sanitizeSvg, sanitizeSvgFragment } = await import('/src/components/mermaid/svgRender.ts');
  const { validateWidgetArgs, widgetAcceptedText, widgetRejectedText } = await import(
    '/src/harness/widget.ts'
  );

  const out = {};
  const attempt = (fn) => {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      return { ok: false, err: e instanceof Error ? e.message : String(e) };
    }
  };

  // ── 1. 正常产物过白名单 + 确定性 ──
  const plotDoc = {
    type: 'plot',
    x: [-3, 3],
    y: [-1, 5],
    curves: [{ fn: 'x^2', label: 'y=x²' }],
    points: [{ at: [0, 0], label: '顶点' }],
    labels: [{ at: [2.2, 4], text: '开口向上' }],
  };
  const graphDoc = {
    type: 'graph',
    direction: 'LR',
    nodes: [
      { id: 'c', label: '客户端' },
      { id: 's', label: '服务端' },
    ],
    edges: [{ from: 'c', to: 's', label: '请求' }],
  };
  const plotSvg = renderDiagram(validateDiagram(plotDoc)).svg;
  const graphSvg = renderDiagram(validateDiagram(graphDoc)).svg;

  out.plotSanitize = attempt(() => sanitizeSvg(plotSvg));
  out.graphSanitize = attempt(() => sanitizeSvg(graphSvg));
  // 确定性：同一份 JSON 渲染两次，逐字节一致（无时钟/随机的契约）
  out.deterministic =
    renderDiagram(validateDiagram(plotDoc)).svg === plotSvg &&
    renderDiagram(validateDiagram(graphDoc)).svg === graphSvg;

  // ── 2. 纵深防御：产物被做脏时闸门真的会动作 ──
  const withScript = plotSvg.replace('</svg>', '<script>alert(1)</script></svg>');
  const withExternal = plotSvg.replace(
    /fill="#ffffff"/,
    'fill="url(https://evil.example/x.svg#a)"',
  );
  out.injectedScript = attempt(() => sanitizeSvg(withScript));
  out.injectedExternal = attempt(() => sanitizeSvg(withExternal));
  // 单个 shape 走 fragment 净化（JsonDiagramBlock 的流式路径）
  const shapes = renderDiagram(validateDiagram(graphDoc)).shapes;
  out.shapeCount = shapes.length;
  out.shapeFragmentOk = shapes.every((s) => {
    try {
      return sanitizeSvgFragment(s.svg).length > 0;
    } catch {
      return false;
    }
  });
  out.shapeExternal = attempt(() =>
    sanitizeSvgFragment('<g><rect width="5" height="5" fill="url(https://evil.example/x#a)"/></g>'),
  );
  out.shapeScript = attempt(() =>
    sanitizeSvgFragment('<g><script>alert(1)</script><rect width="5" height="5"/></g>'),
  );

  // ── 3. 流式预览：逐字符喂半截 JSON ──
  const fullJson = JSON.stringify(plotDoc);
  const streamTrace = [];
  for (let i = 1; i <= fullJson.length; i++) {
    const p = peekDiagramProgress(fullJson.slice(0, i));
    if (!p) {
      streamTrace.push(null);
      continue;
    }
    let shapesOk = true;
    try {
      p.shapes.forEach((s) => sanitizeSvgFragment(s.svg));
    } catch {
      shapesOk = false;
    }
    streamTrace.push({ viewBox: p.viewBox, keys: p.shapes.map((s) => s.key), shapesOk });
  }
  const valid = streamTrace.filter(Boolean);
  out.stream = {
    nullTicks: streamTrace.length - valid.length,
    total: streamTrace.length,
    // key 集合单调只增（收敛不变量在真 sanitize 路径下也成立）
    monotonic: (() => {
      let prev = [];
      for (const v of valid) {
        const set = new Set(v.keys);
        if (set.size < prev.length) return false;
        for (const k of prev) if (!set.has(k)) return false;
        prev = v.keys;
      }
      return true;
    })(),
    shapesAllClean: valid.every((v) => v.shapesOk),
    // 最后一拍与闭合后完整渲染一致（key 集合 + viewBox）
    lastKeys: valid.at(-1)?.keys.join(',') ?? null,
    finalKeys: renderDiagram(validateDiagram(plotDoc))
      .shapes.map((s) => s.key)
      .join(','),
    lastViewBox: valid.at(-1)?.viewBox ?? null,
    finalViewBox: renderDiagram(validateDiagram(plotDoc)).viewBox,
    distinctKeyCounts: [...new Set(valid.map((v) => v.keys.length))].length,
  };

  // ── 4. show_widget 的 diagram 预检 ──
  const goodJson = '{"type":"plot","x":[-2,2],"y":[0,4],"curves":[{"fn":"x^2","label":"y=x²"}]}';
  // 与 tools.ts 的 diagram 分支逐行同构：JSON.parse 失败要包成「不是合法的 JSON」+ 提示，
  // 否则回执里只有浏览器原生的 SyntaxError，归因分支一个都匹配不上。
  const runWidget = (format, code) => {
    const v = validateWidgetArgs({ format, code });
    if (!v.ok) return { stage: 'args', text: v.error };
    try {
      let doc;
      try {
        doc = JSON.parse(v.args.code);
      } catch (e) {
        const hint = /^\s*</.test(v.args.code)
          ? '内容以 < 开头，看起来是 SVG 而不是 JSON —— diagram 围栏里只放 JSON 对象'
          : '请检查多余的逗号、缺引号、或把说明文字写进了围栏';
        throw new Error(`diagram 围栏里不是合法的 JSON：${e instanceof Error ? e.message : String(e)}。${hint}`);
      }
      renderDiagram(validateDiagram(doc));
      return { stage: 'ok', text: widgetAcceptedText(v.args) };
    } catch (e) {
      return { stage: 'reject', text: widgetRejectedText(e) };
    }
  };
  const grabFence = (t) => {
    const m = t.match(/```diagram\n([\s\S]*?)\n```/);
    return m?.[1] ?? '';
  };
  const widgetOk = runWidget('diagram', goodJson);
  const fenced = grabFence(widgetOk.text);
  out.widget = {
    okStage: widgetOk.stage,
    hasFence: !!fenced,
    fenceIsOriginal: fenced === goodJson,
    remindsPending: /还没有上屏/.test(widgetOk.text),
    // round-trip：回执里那段 JSON 再过一遍「渲染层同款」全链路仍然干净
    roundTripClean: attempt(() => {
      const doc = JSON.parse(fenced);
      return sanitizeSvg(renderDiagram(validateDiagram(doc)).svg).startsWith('<svg');
    }).ok,
    badFn: runWidget('diagram', '{"type":"plot","curves":[{"fn":"sinn(x)"}]}'),
    unknownField: runWidget('diagram', '{"type":"graph","nodes":[{"id":"a","label":"甲","colour":"#fff"}]}'),
    svgInFence: runWidget('diagram', '<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>'),
    badType: runWidget('diagram', '{"type":"mindmap","root":"x"}'),
  };

  // 大图不再因可读性建议被拒；DOM 与流式路径都保留全部节点、边和长术语。
  out.largeGraphs = [12, 30].map(count => {
    const nodes = Array.from({ length: count }, (_, i) => ({
      id: `n${i}`, label: i === 0 ? '课程资料检索与问答处理流程中的完整术语\n分支处理' : `节点${i}`,
    }));
    const edges = Array.from({ length: count - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` }))
      .concat(Array.from({ length: count - 2 }, (_, i) => ({ from: `n${i}`, to: `n${i + 2}` })));
    const code = JSON.stringify({ type: 'graph', nodes, edges });
    const rendered = renderDiagram(validateDiagram(JSON.parse(code)));
    const progress = peekDiagramProgress(code.slice(0, -1));
    const host = document.createElement('div');
    host.innerHTML = sanitizeSvg(rendered.svg);
    document.body.appendChild(host);
    const texts = [...host.querySelectorAll('text')].map(el => el.textContent);
    const result = {
      count, edges: edges.length, stage: runWidget('diagram', code).stage,
      allLabels: nodes.every(node => texts.includes(node.label.replace(/\n/g, ''))),
      domNodes: texts.length,
      domEdges: host.querySelectorAll('path[marker-end]').length,
      streamMatches: JSON.stringify(progress?.shapes) === JSON.stringify(rendered.shapes),
      fragmentsClean: progress?.shapes.every(shape => sanitizeSvgFragment(shape.svg).length > 0),
    };
    host.remove();
    return result;
  });

  // ── 5. 插进真 DOM：尺寸、文字宽度、恶意标签不执行 ──
  const hostileDoc = {
    type: 'plot',
    x: [-2, 2],
    y: [0, 4],
    curves: [{ fn: 'x^2', label: '<script>alert(1)</script>&' }],
  };
  const hostileSvg = sanitizeSvg(renderDiagram(validateDiagram(hostileDoc)).svg);
  const host = document.createElement('div');
  window.__alerted = false;
  const prevAlert = window.alert;
  window.alert = () => {
    window.__alerted = true;
  };
  host.innerHTML = hostileSvg;
  document.body.appendChild(host);
  const el = host.querySelector('svg');
  const box = el?.getBoundingClientRect();
  const texts = [...(el?.querySelectorAll('text') ?? [])].map((t) => t.textContent ?? '');
  out.dom = {
    hasSvg: !!el,
    w: box?.width ?? 0,
    h: box?.height ?? 0,
    textLen: el?.querySelector('text') ? el.querySelector('text').getComputedTextLength() : 0,
    // 恶意标签必须原样成为**文本**，而不是一个 script 元素、更不能执行
    scriptCount: host.querySelectorAll('script').length,
    labelText: texts.find((t) => t.includes('alert')) ?? null,
    alerted: window.__alerted,
    viewBox: el?.getAttribute('viewBox') ?? null,
  };
  window.alert = prevAlert;
  host.remove();

  return out;
});

// ── 断言 ──
console.log('=== 1. 渲染器产物过同一道白名单，且渲染确定 ===');
check(result.plotSanitize.ok, `plot 产物通过净化${result.plotSanitize.ok ? '' : `：${result.plotSanitize.err}`}`);
check(result.graphSanitize.ok, `graph 产物通过净化${result.graphSanitize.ok ? '' : `：${result.graphSanitize.err}`}`);
check(
  result.graphSanitize.ok && /viewBox="0 0/.test(result.graphSanitize.value),
  'viewBox 大小写与取值被保留（HTML 解析器没吃掉它）',
);
check(
  result.graphSanitize.ok && /<tspan/.test(result.graphSanitize.value) && /客户端/.test(result.graphSanitize.value),
  'tspan 与中文标签保留',
);
check(
  result.graphSanitize.ok && /<marker /.test(result.graphSanitize.value) && /url\(#xmd-ar\)/.test(result.graphSanitize.value),
  '箭头 marker 与同文档 url(#id) 引用保留',
);
check(result.deterministic, '同一份 JSON 两次渲染逐字节一致（无时钟/随机）');

console.log('\n=== 2. 纵深防御：产物被做脏时闸门真的会动作 ===');
check(
  result.injectedScript.ok &&
    !/<script/i.test(result.injectedScript.value) &&
    !/alert/.test(result.injectedScript.value),
  '注入的 <script> 被白名单剥掉（净化器是剔除语义，与模型直出 SVG 同一条路）',
);
check(!result.injectedExternal.ok && /外部资源/.test(result.injectedExternal.err ?? ''),
  `注入外部 url() 被拒（${result.injectedExternal.err}）`);
check(result.shapeFragmentOk, `${result.shapeCount} 个 shape 逐个过 fragment 净化全部通过`);
check(!result.shapeExternal.ok && /外部资源/.test(result.shapeExternal.err ?? ''),
  `shape 里带外部 url() 会被 fragment 净化拒掉（流式路径的闸门：${result.shapeExternal.err}）`);
check(
  result.shapeScript.ok && !/script|alert/i.test(result.shapeScript.value),
  'shape 里带 <script> 被剥掉（剔除语义，与完整源码一致）',
);

console.log('\n=== 3. 流式预览：key 单调、每拍干净、末拍收敛 ===');
check(result.stream.shapesAllClean, '每一拍预览的每个 shape 都过 sanitizeSvgFragment');
check(result.stream.monotonic, 'key 集合单调只增（半截 JSON 越写越全）');
check(result.stream.nullTicks > 0, `字段没成形前有等待拍（${result.stream.nullTicks}/${result.stream.total} 拍返回 null）`);
check(result.stream.distinctKeyCounts >= 3, `画布是逐步长出来的（出现过的 key 数：${result.stream.distinctKeyCounts} 种）`);
check(result.stream.lastKeys === result.stream.finalKeys,
  `最后一拍的 key 集合 === 完整渲染的 key 集合（${result.stream.lastKeys} vs ${result.stream.finalKeys}）`);
check(result.stream.lastViewBox === result.stream.finalViewBox,
  `最后一拍的 viewBox === 完整渲染的 viewBox（${result.stream.lastViewBox} vs ${result.stream.finalViewBox}）`);

console.log('\n=== 4. show_widget 的 diagram 预检与渲染层同源 ===');
check(result.widget.okStage === 'ok', `合规 JSON 通过预检（${result.widget.okStage}）`);
check(result.widget.hasFence && result.widget.fenceIsOriginal, '回执里带回原样 JSON 的 ```diagram 围栏');
check(result.widget.remindsPending, '通过回执提醒「还没上屏、需放进正文」');
check(result.widget.roundTripClean, '回执里那段 JSON round-trip 再过全链路仍然干净');
check(result.widget.badFn.stage === 'reject' && /白名单函数/.test(result.widget.badFn.text),
  `fn 拼错归因到表达式白名单（${result.widget.badFn.text.slice(0, 24)}…）`);
check(result.widget.unknownField.stage === 'reject' && /schema 是锁死的/.test(result.widget.unknownField.text),
  '未知字段归因到 schema 锁死');
check(result.widget.svgInFence.stage === 'reject' && /JSON 对象/.test(result.widget.svgInFence.text),
  '把 SVG 塞进 diagram 围栏归因到「只放 JSON」');
check(result.widget.badType.stage === 'reject' && /只能取/.test(result.widget.badType.text),
  'type 写错归因到两种合法值');
for (const graph of result.largeGraphs) {
  check(graph.stage === 'ok' && graph.domNodes === graph.count && graph.domEdges === graph.edges && graph.allLabels,
    `${graph.count} 节点 / ${graph.edges} 条边大图通过预检与净化，DOM 保留全部结构和完整术语`);
  check(graph.streamMatches && graph.fragmentsClean, `${graph.count} 节点大图的流式预览干净且收敛到完整渲染`);
}

console.log('\n=== 5. 插进真 DOM：尺寸、文字、恶意标签不执行 ===');
check(result.dom.hasSvg, '插入 DOM 后确实是一个 <svg> 元素');
check(result.dom.w > 0 && result.dom.h > 0, `有非零尺寸（${result.dom.w}×${result.dom.h}）`);
check(result.dom.textLen > 0, `文字有实际宽度（${result.dom.textLen.toFixed(1)}px，说明 font-size / text-anchor 生效）`);
check(result.dom.scriptCount === 0, '恶意标签没有变成 script 元素');
check(result.dom.labelText === '<script>alert(1)</script>&',
  `标签按纯文本原样显示（${JSON.stringify(result.dom.labelText)}）`);
check(!result.dom.alerted, 'alert 没有被执行');

await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
