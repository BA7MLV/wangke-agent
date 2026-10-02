/* eslint-disable no-console */
// 探针：模型直出 SVG 的净化器（src/components/mermaid/svgRender.ts）
//
// 为什么用真浏览器而不是单测：DOMPurify 要 window，而且「HTML 解析器会不会把 viewBox
// 的大小写吃掉」「foreignObject / image / url() 到底被丢还是被留」这类问题只有真解析器说了算。
//
// 用法：node scripts/probe-svg-sanitize.mjs   （需先 npm run dev）
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

const run = (raw) =>
  page.evaluate(async (input) => {
    const { sanitizeSvg } = await import('/src/components/mermaid/svgRender.ts');
    try {
      return { ok: true, out: sanitizeSvg(input) };
    } catch (e) {
      return { ok: false, err: e instanceof Error ? e.message : String(e) };
    }
  }, raw);

console.log('=== 1. 正常图形：元素、viewBox 大小写、中文标签 ===');
const good = `<svg viewBox="0 0 240 120" width="240" height="120" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>
  <marker id="m" markerWidth="6" markerHeight="6" refX="8" refY="5" orient="auto"><path d="M2 1L8 5L2 9"/></marker>
  <rect x="10" y="10" width="100" height="40" rx="6" fill="url(#g)" stroke="#333" stroke-width="1.5"/>
  <circle cx="180" cy="40" r="20" fill="#e6f4ff"/>
  <text x="60" y="90" text-anchor="middle" font-size="12" dominant-baseline="central">定义域</text>
  <path d="M10 100 L230 100" stroke="#888" marker-end="url(#m)"/>
</svg>`;
const r1 = await run(good);
check(r1.ok, `正常 SVG 通过净化${r1.ok ? '' : `：${r1.err}`}`);
if (r1.ok) {
  check(/viewBox="0 0 240 120"/.test(r1.out), 'viewBox 大小写与取值被保留');
  check(/<linearGradient/.test(r1.out), 'linearGradient 保留');
  check(/url\(#g\)/.test(r1.out) && /url\(#m\)/.test(r1.out), '同文档 url(#id) 引用保留');
  check(/定义域/.test(r1.out), '中文标签保留');
  check(/<path/.test(r1.out) && /marker-end/.test(r1.out), 'path 与 marker-end 保留');
  check(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(r1.out), 'xmlns 保留（下载/独立打开要用）');
}

console.log('\n=== 2. 脚本面：on* 事件 / script / javascript: ===');
const r2 = await run('<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><rect width="5" height="5" onclick="alert(3)"/></svg>');
check(r2.ok, '净化本身不报错（静默剥离脚本面）');
if (r2.ok) {
  check(!/onload/i.test(r2.out), 'onload 被剥离');
  check(!/onclick/i.test(r2.out), 'onclick 被剥离');
  check(!/<script/i.test(r2.out) && !/alert/.test(r2.out), 'script 元素与其内容被剥离');
  check(/<rect/.test(r2.out), '同标签内的正常图形保留');
}
const r2b = await run('<svg viewBox="0 0 10 10"><a href="javascript:alert(1)"><text x="0" y="0">点我</text></a></svg>');
check(r2b.ok && !/<a\b/.test(r2b.out) && !/javascript:/i.test(r2b.out), 'javascript: 链接（<a>）被剥离');

console.log('\n=== 3. 外部引用：image / href / 外部 url() ===');
const r3 = await run('<svg viewBox="0 0 10 10"><image href="https://evil.example/x.png" width="10" height="10"/></svg>');
check(r3.ok && !/<image/i.test(r3.out) && !/evil\.example/.test(r3.out), '<image> 外部图片被剥离');
const r3b = await run('<svg viewBox="0 0 10 10"><rect width="5" height="5" fill="url(https://evil.example/x.svg#a)"/></svg>');
check(!r3b.ok && /外部资源/.test(r3b.err ?? ''), `外部 url() 直接拒绝（${r3b.err}）`);
const r3c = await run('<svg viewBox="0 0 10 10"><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject></svg>');
check(r3c.ok && !/foreignObject/i.test(r3c.out), 'foreignObject 被剥离（不引入 HTML 面）');
const r3d = await run('<svg viewBox="0 0 10 10"><style>@import url("https://evil.example/x.css");</style><rect width="5" height="5"/></svg>');
check(r3d.ok && !/<style/i.test(r3d.out) && !/evil\.example/.test(r3d.out), '<style> 被剥离（不引入 CSS 外链面）');

console.log('\n=== 4. 输入形态：缺外壳 / 未闭合 / 带前后话术 ===');
const r4 = await run('<rect width="5" height="5"/>');
check(!r4.ok && /没有找到 <svg/.test(r4.err ?? ''), `缺 <svg> 外壳时明确报错（${r4.err}）`);
const r4b = await run('<svg viewBox="0 0 10 10"><rect width="5" height="5"/>');
check(!r4b.ok && /没有闭合/.test(r4b.err ?? ''), `未闭合时明确报错（${r4b.err}）`);
const r4c = await run('这是函数图像：\n<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>\n（横轴为 x）');
check(r4c.ok && /^<svg/.test(r4c.out), '围栏里多写一句说明仍能切出 SVG 本体');
const r4d = await run('   ');
check(!r4d.ok && /为空/.test(r4d.err ?? ''), `空内容报错（${r4d.err}）`);

console.log('\n=== 5. 净化结果真的能渲染 ===');
const rendered = await page.evaluate(async () => {
  const { sanitizeSvg } = await import('/src/components/mermaid/svgRender.ts');
  const out = sanitizeSvg('<svg viewBox="0 0 100 50"><rect width="100" height="50" fill="#e6f4ff"/><text x="50" y="25" text-anchor="middle" font-size="10">能画出来</text></svg>');
  const host = document.createElement('div');
  host.innerHTML = out;
  document.body.appendChild(host);
  const el = host.querySelector('svg');
  const box = el?.getBoundingClientRect();
  const textEl = el?.querySelector('text');
  const textLen = textEl ? textEl.getComputedTextLength() : 0;
  const res = { hasSvg: !!el, w: box?.width ?? 0, h: box?.height ?? 0, textLen };
  host.remove();
  return res;
});
check(rendered.hasSvg, '插入 DOM 后确实是一个 <svg> 元素');
check(rendered.w > 0 && rendered.h > 0, `有非零尺寸（${rendered.w}×${rendered.h}）`);
check(rendered.textLen > 0, `文字有实际宽度（${rendered.textLen.toFixed(1)}px，说明 font-size / text-anchor 生效）`);

// ── 6. show_widget 走的是同一个净化函数 ──────────────────────────────────────
// 这才是 show_widget 的全部价值所在：它必须复用渲染层的 sanitizeSvg，
// 否则「预检通过」与「渲染成功」两件事会分叉，工具就成了只会说「没问题」的摆设。
// 这里直接打工具执行器，验证通过回执里那段围栏**再过一次净化仍然干净**。
console.log('\n=== 6. show_widget 的预检与渲染层同源 ===');
const widget = await page.evaluate(async () => {
  const { sanitizeSvg } = await import('/src/components/mermaid/svgRender.ts');
  const { validateWidgetArgs, widgetAcceptedText, widgetRejectedText } = await import(
    '/src/harness/widget.ts'
  );
  const good = '<svg viewBox="0 0 240 120"><rect x="1" y="1" width="10" height="10" fill="#e6f4ff"/></svg>';
  // 净化器是「剔除」不是「全否」：带 script 的 SVG 会被剥掉脚本后照常通过
  const strippy = '<svg viewBox="0 0 10 10"><script>alert(1)</script><rect width="5" height="5"/></svg>';
  // 剥完只剩空壳：根 <svg> 还在，图元没了
  const emptyish = '<svg viewBox="0 0 10 10"><foreignObject><div>x</div></foreignObject></svg>';
  // 缺外壳：真的会被拒
  const noshell = '<rect width="5" height="5"/>';
  // 外链资源直接被拒
  const external = '<svg viewBox="0 0 10 10"><rect width="5" height="5" fill="url(https://evil.example/x)"/></svg>';

  const runOne = (raw) => {
    const v = validateWidgetArgs(raw);
    if (!v.ok) return { stage: 'args', text: v.error };
    try {
      // 与 tools.ts 的 show_widget 分支保持一致：svg 回净化后的源码
      return { stage: 'ok', text: widgetAcceptedText({ format: 'svg', code: sanitizeSvg(v.args.code) }) };
    } catch (e) {
      return { stage: 'reject', text: widgetRejectedText(e) };
    }
  };

  const grab = (res) => {
    const m = res.text.match(/```svg\n([\s\S]*?)\n```/);
    return m?.[1] ?? '';
  };

  const okRes = runOne({ format: 'svg', code: good });
  const stripRes = runOne({ format: 'svg', code: strippy });
  let refenceClean = false;
  if (okRes.stage === 'ok') {
    try {
      refenceClean = sanitizeSvg(grab(okRes)).startsWith('<svg');
    } catch {
      refenceClean = false;
    }
  }

  return {
    okRes,
    stripRes,
    stripCode: grab(stripRes),
    refenceClean,
    emptyRes: runOne({ format: 'svg', code: emptyish }),
    emptyCode: grab(runOne({ format: 'svg', code: emptyish })),
    rejectRes: runOne({ format: 'svg', code: noshell }),
    extRes: runOne({ format: 'svg', code: external }),
  };
});

check(widget.okRes.stage === 'ok', `合规 SVG 通过预检（${widget.okRes.text.slice(0, 24)}…）`);
check(widget.okRes.text.includes('还没有上屏'), '通过回执提醒「还没上屏、需放进正文」');
check(widget.refenceClean, '回执里那段围栏再过一次净化仍然干净（同源验证）');

// 净化器是「剔除」不是「全否」，所以带 script 的**会通过** ——
// 关键不是拒它，而是回执里给的必须是**净化后**那份，不能是原样带毒的源码。
check(
  widget.stripRes.stage === 'ok',
  '带 <script> 的 SVG 被剔除后通过（净化器语义，不是校验器）',
);
check(!widget.stripCode.includes('<script'), '⚠️ 回执里的围栏已不含 script —— 回的是净化后的源码');
check(widget.stripCode.includes('rect'), '剔除 script 后图元仍在');

// 只剩外壳、没有可绘制内容时**会通过**：sanitizeSvg 的「还剩东西吗」只验根 <svg> 标签在不在，
// 标签在就算过，于是空图会被放行、渲染成一个空白框。这是净化器既有的宽松处，
// 不是 show_widget 引入的。工具刻意不复刻这条判断 —— 它的价值恰恰来自「与渲染层同一个函数」，
// 这里额外收紧就会与渲染结果分叉。记在这里是为了别把它当成新引入的回归。
check(
  widget.emptyRes.stage === 'ok' && /<svg/.test(widget.emptyCode) && !/rect|circle|path/.test(widget.emptyCode),
  '⚠️ 只剩空壳时也会通过（净化器只看根标签）—— 已知宽松处，工具不额外收紧',
);

// 真正会被拒的两类
check(widget.rejectRes.stage === 'reject', `缺 <svg> 外壳被拒（${widget.rejectRes.text.slice(0, 30)}…）`);
check(/以 <svg 开头/.test(widget.rejectRes.text), '缺外壳的归因可执行');
check(widget.extRes.stage === 'reject', '外链资源被拒');
check(/外部资源/.test(widget.extRes.text), '外链的归因不是「脚本」而是「外部资源」');
check(!widget.extRes.text.includes('evil.example'), '拒绝回执不回显源码（避免污染上下文）');

await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
