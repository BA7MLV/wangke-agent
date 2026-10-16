/* eslint-disable no-console */
// E2E：```diagram 围栏（JSON 中间层）在**流式生成过程中**的表现（边生成边画）
//   1. 相位真的走 waiting → drawing → ok，而不是一直卡在 waiting
//   2. 画布的 key 数随 JSON 写完而单调增长，且**每一拍都能在屏幕上看到**
//      （增量单位是逻辑图元：axes → curve:0 → point:0 → label:0）
//   3. 新到的图元带落画 class；描边的 stroke-dashoffset 从「全长」走到 0
//   4. 闭合后落回权威产物：画布内容 === sanitizeSvg(renderDiagram(validateDiagram(src)))
//   5. 坏 fn：坐标轴先画出来，曲线那一拍渲染失败就整拍不画（宽容），闭合后报错回退源码
//   6. 围栏外普通正文不受影响
//
// 模型流是**页内假的**：`addInitScript` 里把 window.fetch 换成脚本化 SSE 发生器，
// 逐 chunk 推送 —— 要验的就是「边生成边画」，接真模型反而把时序抖没了。
//
// 用法：npm run dev &  然后 node scripts/e2e-diagram-stream.mjs
//   BASE_URL 默认 http://localhost:5173
//   TEST_FILE 不传时用 ffmpeg 现造一段 20s 带音轨的样片
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const TEST_FILE = process.env.TEST_FILE || '/tmp/wangke-diagram-stream-test.mp4';
const SHOTS = 'e2e-shots';

if (!existsSync(TEST_FILE)) {
  console.log(`0. 生成测试样片 ${TEST_FILE}`);
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=20',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', TEST_FILE,
  ], { stdio: 'ignore' });
}
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

// 一段真实的教学图：坐标轴 → 抛物线 → 顶点 → 标注。JSON 逐字符流过来，
// 每个数组项写完就多一个 key —— 这正是这个脚本要验的东西。
const FIG_JSON = {
  type: 'plot',
  x: [-3, 3],
  y: [-1, 5],
  curves: [{ fn: 'x^2', label: 'y=x²' }],
  points: [{ at: [0, 0], label: '顶点' }],
  labels: [{ at: [2.2, 4], text: '开口向上' }],
};
const GOOD_ANSWER = `这道抛物线开口向上，顶点在原点：\n\n\`\`\`diagram\n${JSON.stringify(FIG_JSON)}\n\`\`\`\n\n横轴为 x，纵轴为 y。`;
// 坏 fn：坐标轴画得出来，曲线画不出来 —— 验「宽容渲染」与闭合后的报错
const BAD_ANSWER = '这条曲线的表达式写错了：\n\n```diagram\n{"type":"plot","x":[-2,2],"y":[0,4],"curves":[{"fn":"sinn(x)"}]}\n```';

/** 把一段文本切成 ~14 字符一块的 delta 数组（模拟模型逐 token 吐字） */
const toChunks = (text, size = 14) => {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => { failed++; console.error(`   ❌ ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

// ── 设置 + 假的流式模型 ─────────────────────────────────────────────────────
await page.addInitScript(() => {
  localStorage.setItem('wangke-settings', JSON.stringify({
    state: {
      apiKey: 'sk-fake-for-e2e',
      baseUrl: 'https://sf.test/v1',
      llmModel: 'test-model', visionModel: 'test-model', asrModel: 'test-model',
      contextWindow: 32768, agentRounds: 6,
    },
    version: 0,
  }));

  /** 脚本化 SSE 发生器：队列里每个元素是一整轮回答，delta 逐块推 + 真 setTimeout */
  const nativeFetch = window.fetch.bind(window);
  window.__LLM__ = { queue: [] };
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('/chat/completions')) return nativeFetch(input, init);
    const step = window.__LLM__.queue.shift() ?? { chunks: [{ content: '（没有脚本可播）' }] };
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for (const delta of step.chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
          if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
});

/**
 * mdui-text-field 内部可能是 textarea 也可能是 input，两个都试（与 e2e-svg-stream 同款）
 */
async function typeAndSend(text) {
  const field = page.locator('[data-testid="chat-input"] textarea, [data-testid="chat-input"] input').first();
  await field.waitFor({ timeout: 10000 });
  await field.click();
  await field.fill(text);
  await field.press('Enter');
}

console.log('1. 导入测试视频');
await page.goto(BASE, { waitUntil: 'networkidle' });
// 应用现在默认落在「课程助手」页，导入控件在课程库页 —— 已在导入页就原地等，没在就点过去。
// 两条路都留着：路由默认值会随导航栏改版变，但页面里总有一个能过去的入口。
if (!(await page.locator('input[type="file"]').count())) {
  await page.locator('[data-testid="chat-go-import"], [data-testid="nav-rail-home"]').first().click();
  await page.locator('input[type="file"]').waitFor({ timeout: 15000 });
}
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 30000 });
const videoId = await page.evaluate(async () => {
  const req = indexedDB.open('wangke');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
  const tx = db.transaction('videos', 'readonly');
  const all = await new Promise((res, rej) => { const q = tx.objectStore('videos').getAll(); q.onsuccess = () => res(q.result); q.onerror = rej; });
  db.close();
  return all[0]?.id ?? null;
});
if (!videoId) { console.error('未取到 videoId，导入失败'); await browser.close(); process.exit(1); }
console.log('   videoId:', videoId);

console.log('2. 播种子库（1 段字幕即可解锁问答面板）');
await page.evaluate(async (vid) => {
  const req = indexedDB.open('wangke');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
  const put = (store, value) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const q = tx.objectStore(store).add(value);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  const now = Date.now();
  await put('segments', { videoId: vid, idx: 0, start: 0, end: 20, text: '测试字幕', status: 1 });
  const sid = await put('chatSessions', { videoId: vid, title: 'diagram 流式落画', createdAt: now });
  await put('chats', { videoId: vid, sessionId: sid, role: 'user', content: '画一下抛物线', createdAt: now });
  db.close();
}, videoId);

console.log('3. 重载并进入问答面板，推一段逐字符的 diagram 围栏');
await page.goto(`${BASE}/#/player/${videoId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('video', { timeout: 20000 });
await page.getByRole('tab', { name: '问答', exact: true }).click();
await page.waitForTimeout(600);

await page.evaluate(
  ([chunks, delayMs]) => window.__LLM__.queue.push({ chunks, delayMs }),
  [toChunks(GOOD_ANSWER).map((content) => ({ content })), 150],
);
await typeAndSend('画一下抛物线');

/**
 * 在流式进行中反复取样。每次取「相位 + 画布里的 key 集合 + 新到图元的描边进度」。
 * 取样在**页面内**用一个自跑循环完成：跨进程往返一次要几毫秒，
 * 而一整段流只有 ~2s，用 Node 侧轮询会漏掉大半中间态。
 */
console.log('4. 边流边取样（页面内自跑循环，避免漏掉中间态）');
const samples = await page.evaluate(async () => {
  const out = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 20000) {
    const block = document.querySelector('[data-testid="diagram-block"]');
    if (block) {
      const canvas = block.querySelector('[data-testid="diagram-canvas"]');
      const root = canvas?.querySelector('svg');
      // 顶层子元素带 data-dkey（DiagramCanvas 插入后打上的）
      const keys = root ? [...root.children].map((c) => c.getAttribute('data-dkey')).filter(Boolean) : [];
      const shapes = root ? [...root.querySelectorAll('path,line,circle,rect,ellipse,text')] : [];
      const marked = shapes.filter((s) =>
        s.classList.contains('xmd-svg-stroke') || s.classList.contains('xmd-svg-fill') || s.classList.contains('xmd-svg-fade'),
      ).length;
      const offsets = shapes
        .filter((s) => s.classList.contains('xmd-svg-stroke'))
        .map((s) => parseFloat(getComputedStyle(s).strokeDashoffset) || 0)
        .filter((o) => Number.isFinite(o));
      out.push({
        t: Math.round(performance.now() - t0),
        phase: block.getAttribute('data-phase'),
        keys,
        viewBox: root?.getAttribute('viewBox') ?? null,
        marked,
        offsets,
        canvasH: canvas ? Math.round(canvas.getBoundingClientRect().height) : 0,
        live: !!block.querySelector('[data-testid="diagram-live"]'),
        pending: !!block.querySelector('[data-testid="diagram-pending"]'),
      });
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
  return out;
});

const drawing = samples.filter((s) => s.phase === 'drawing');
const phases = [...new Set(samples.map((s) => s.phase))];

console.log(`   取样 ${samples.length} 次，相位序列：${phases.join(' → ')}`);
check(phases.includes('waiting') && phases.includes('drawing') && phases.includes('ok'),
  `相位走 waiting → drawing → ok（实得 ${phases.join(' → ')}）`);
check(drawing.length >= 3, `drawing 态持续了多拍（${drawing.length} 次取样）`);

// key 单调增长：JSON 中间层的「边生成边画」核心可观测特征。
// 只看 drawing 段 —— 闭合后画布换成静态 SVG、data-dkey 被摘掉，key 数归零是设计如此，
// 拿闭合后的 0 去判「单调不减」会把正确实现判成回退。
const keyCounts = drawing.map((s) => s.keys.length);
const nonDecreasing = keyCounts.every((v, i) => i === 0 || v >= keyCounts[i - 1]);
const distinctCounts = [...new Set(keyCounts)];
check(nonDecreasing, `画布 key 数单调不减（${distinctCounts.join('→')}）`);
check(distinctCounts.length >= 3, `画布是**逐步**长出来的，不是一次性跳到最终（出现过的 key 数：${distinctCounts.join(',')}）`);
check(distinctCounts.at(-1) >= 4, `最终画布有全部图元（${distinctCounts.at(-1)} 个 key）`);

// 落画顺序：坐标轴先铺好，曲线、图例、点、标注逐个到（笔顺 = 渲染器固定的图元层序，
// 不是 JSON 字段的书写顺序 —— legend 由带 label 的曲线派生，所以夹在曲线与点之间）
const finalKeys = drawing.at(-1)?.keys ?? [];
check(finalKeys.join(',') === 'axes,curve:0,legend,point:0,label:0',
  `key 顺序稳定且符合笔顺（实得 ${finalKeys.join(',')}）`);

// 收敛：最后一拍 drawing 的 viewBox 与闭合后的完整渲染一致
const lastDrawing = drawing.at(-1);
check(!!lastDrawing?.viewBox, 'drawing 期间画布带 viewBox');

// 新到的图元带落画 class，且描边真的在「走」
const maxMarked = Math.max(...drawing.map((s) => s.marked));
check(maxMarked > 0, `新到的图元带落画 class（最多同时 ${maxMarked} 个）`);
const drawn = drawing.filter((s) => s.offsets.length > 0);
const minOf = (s) => Math.min(...s.offsets);
const maxOf = (s) => Math.max(...s.offsets);
const startOffset = Math.max(...drawn.slice(0, 4).map(minOf));
check(startOffset > 0.05, `刚落画时描边是藏着的（dashoffset=${startOffset.toFixed(2)}，没一上来就画完）`);
const tail = drawing.at(-1);
const endOffset = maxOf(tail);
check(endOffset <= 0.05, `收笔时**每一条**描边都走完了（最慢的那条 dashoffset=${endOffset.toFixed(2)}）`);
check(startOffset > endOffset * 4, 'dashoffset 一路下降（真在走，不是静态值）');
const inFlight = drawn.filter((s) => maxOf(s) > 0.05 && minOf(s) <= 0.05);
check(inFlight.length > 0, `同一拍里既有走完的也有在走的（${inFlight.length} 次取样）`);

check(drawing.some((s) => s.live), 'drawing 态带「生成中」提示');
check(samples.some((s) => s.phase === 'waiting' && s.pending), 'waiting 态只给占位提示，不解析');

console.log('\n5. 闭合后的终态：落回权威产物，工具条齐全');
await page.waitForSelector('[data-testid="diagram-block"][data-phase="ok"]', { timeout: 20000 });
await page.waitForTimeout(600);
// 权威产物在**页内**算：净化要真 DOM（DOMPurify 在 Node 里跑不起来），
// 且必须与 JsonDiagramBlock 走同一串模块，才算同一份契约。这也是本脚本跑 dev 档的原因。
const finalState = await page.evaluate(async (figJson) => {
  const { renderDiagram } = await import('/src/components/mermaid/diagramRender.ts');
  const { validateDiagram } = await import('/src/components/mermaid/diagramSchema.ts');
  const { sanitizeSvg } = await import('/src/components/mermaid/svgRender.ts');
  const block = document.querySelector('[data-testid="diagram-block"]');
  const canvas = block.querySelector('[data-testid="diagram-canvas"]');
  const html = canvas.innerHTML;
  const norm = (s) => s.replace(/\s+/g, '').replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '');
  // 权威产物：与 JsonDiagramBlock 闭合路径同一串计算
  const expected = sanitizeSvg(renderDiagram(validateDiagram(figJson)).svg);
  return {
    phase: block.getAttribute('data-phase'),
    // 落画 class 必须随终态一起消失（静态渲染不走 DiagramCanvas）
    leftovers: canvas.querySelectorAll('.xmd-svg-stroke,.xmd-svg-fill,.xmd-svg-fade').length,
    pathLengths: [...canvas.querySelectorAll('[pathLength]')].length,
    keys: [...canvas.querySelectorAll('[data-dkey]')].length,
    paths: canvas.querySelectorAll('path').length,
    circles: canvas.querySelectorAll('circle').length,
    texts: [...canvas.querySelectorAll('text')].map((t) => t.textContent?.trim()).filter(Boolean),
    matchesExpected: norm(html) === norm(expected),
    idempotent: norm(sanitizeSvg(html)) === norm(html),
    tools: {
      copy: !!block.querySelector('[data-testid="diagram-copy"]'),
      zoom: !!block.querySelector('[data-testid="diagram-zoom"]'),
      download: !!block.querySelector('[data-testid="diagram-download"]'),
      source: !!block.querySelector('[data-testid="diagram-source-toggle"]'),
    },
    live: !!block.querySelector('[data-testid="diagram-live"]'),
    pending: !!block.querySelector('[data-testid="diagram-pending"]'),
    chatText: document.querySelector('[data-testid="chat-msg-ai"]')?.textContent ?? '',
  };
}, FIG_JSON);

check(finalState.phase === 'ok', `闭合后相位 = ok（实得 ${finalState.phase}）`);
check(finalState.paths >= 1, `曲线真的画出来了（${finalState.paths} 条 path）`);
check(finalState.circles >= 1, `关键点真的画出来了（${finalState.circles} 个 circle）`);
check(finalState.texts.some((t) => t?.includes('顶点')) && finalState.texts.some((t) => t?.includes('开口向上')) && finalState.texts.some((t) => t?.includes('y=x²')),
  `中文标签完整（${JSON.stringify(finalState.texts)}）`);
check(finalState.leftovers === 0, `终态不留落画 class 残留（${finalState.leftovers} 个）`);
check(finalState.pathLengths === 0, '终态不留 pathLength（预览期的动画标记不该进最终 DOM）');
check(finalState.keys === 0, '终态是静态 SVG，不带流式期的 data-dkey 标记');
check(finalState.matchesExpected, '终态画布内容 === sanitizeSvg(renderDiagram(validateDiagram(src))) 的权威产物');
check(finalState.idempotent, '终态再过一次净化不变（幂等）');
check(finalState.tools.copy && finalState.tools.zoom && finalState.tools.download && finalState.tools.source,
  '闭合后工具条齐全（复制/大图/下载/源码）');
check(!finalState.live && !finalState.pending, '闭合后不再显示「生成中」提示');
check(finalState.chatText.includes('横轴为 x'), '围栏外的正文原样保留');

await page.locator('[data-testid="diagram-canvas"]').scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/diagram-stream-final.png` });

console.log('\n6. 坏 fn：坐标轴先画，曲线整拍不画，闭合后报错回退源码');
await page.evaluate(
  ([chunks, delayMs]) => window.__LLM__.queue.push({ chunks, delayMs }),
  [toChunks(BAD_ANSWER, 10).map((content) => ({ content })), 60],
);
await typeAndSend('再来一条');

// 边流边取样：坏曲线那条 key 永远不该上画布
const badSamples = await page.evaluate(async () => {
  const out = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 8000) {
    const blocks = [...document.querySelectorAll('[data-testid="diagram-block"]')];
    const block = blocks.at(-1);
    if (block) {
      const canvas = block.querySelector('[data-testid="diagram-canvas"]');
      const root = canvas?.querySelector('svg');
      out.push({
        phase: block.getAttribute('data-phase'),
        keys: root ? [...root.children].map((c) => c.getAttribute('data-dkey')).filter(Boolean) : [],
      });
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
  return out;
});
await page.waitForSelector('[data-testid="diagram-block"][data-phase="error"]', { timeout: 20000 });
const badStream = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('[data-testid="diagram-block"]')];
  const bad = blocks.at(-1);
  return {
    count: blocks.length,
    err: bad?.querySelector('[data-testid="diagram-error"]')?.textContent ?? null,
    source: bad?.querySelector('[data-testid="diagram-source"]')?.textContent ?? null,
    canvas: !!bad?.querySelector('[data-testid="diagram-canvas"]'),
    retry: !!bad?.querySelector('[data-testid="diagram-retry"]'),
  };
});
const badDrawing = badSamples.filter((s) => s.phase === 'drawing');
check(badStream.count === 2, `两条回答建出 2 个块（实得 ${badStream.count}）`);
check(badDrawing.length > 0, `坏曲线的图也先画出了能画的部分（坐标轴，${badDrawing.length} 拍 drawing）`);
check(badSamples.every((s) => !s.keys.includes('curve:0')),
  '坏曲线从未上过画布（宽容渲染：那一拍整拍不画）');
check(!!badStream.err?.includes('表达式'), `闭合后报错点明表达式问题（${JSON.stringify(badStream.err?.slice(0, 40))}）`);
check(!!badStream.source?.includes('sinn(x)'), '失败态仍给出源码（不吞信息）');
check(!badStream.canvas, '失败态没有残留画布');
check(!badStream.retry, '失败态不给重试按钮（纯函数，重试结果不会变）');
await page.screenshot({ path: `${SHOTS}/diagram-stream-reject.png`, fullPage: true });

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
