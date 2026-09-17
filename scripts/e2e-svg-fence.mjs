/* eslint-disable no-console */
// E2E：```svg 围栏（模型直出的原生 SVG）在题卡解析里的渲染链路
//   1. 合法 SVG → 净化后渲染成图，工具条齐全（复制 / 大图 / 下载），中文标签与 viewBox 保留
//   2. 围栏内的 [mm:ss] 不被 linkify 改写（与 mermaid 同一条围栏保护）
//   3. 含外部资源引用的 SVG → 拒绝渲染 + 回退源码（安全闸门，不静默吞掉）
//   4. 同一条解析里 mermaid 与 svg 两种围栏共存，各建各的块
//   5. 普通代码块照旧不建块
//
// 用法：node scripts/e2e-svg-fence.mjs
//   BASE_URL 默认 http://localhost:5173（dev / preview 均可：按「播种子库 → 整页重载」驱动）
//   TEST_FILE 不传时用 ffmpeg 现造一段 20s 带音轨的样片
//   不调真实 API：题卡由自播种的 chats 行（quiz 字段）直接喂给组件
//
// 为什么净化本身的正确性不在这里验：那属于纯函数契约，见 scripts/probe-svg-sanitize.mjs
// （用例更密）。这里只验「接进渲染链路之后」的行为。
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const TEST_FILE = process.env.TEST_FILE || '/tmp/wangke-svg-fence-test.mp4';
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

// 第 1 题：合法 SVG（坐标轴 + 抛物线 + 中文标签），围栏内埋一处 [00:30] 验围栏保护
const GOOD_SVG = [
  '抛物线开口向上 [00:10]，顶点在原点附近。',
  '',
  '```svg',
  '<svg viewBox="0 0 220 140" xmlns="http://www.w3.org/2000/svg">',
  '  <line x1="20" y1="120" x2="200" y2="120" stroke="#888" stroke-width="1"/>',
  '  <line x1="20" y1="120" x2="20" y2="20" stroke="#888" stroke-width="1"/>',
  '  <path d="M30 30 Q110 200 190 30" fill="none" stroke="#1677ff" stroke-width="2"/>',
  '  <text x="110" y="134" font-size="10" text-anchor="middle">[00:30] 顶点</text>',
  '</svg>',
  '```',
].join('\n');

// 第 2 题：SVG 引用了外部资源 —— 安全闸门必须拒绝渲染并回退源码
const EXTERNAL_SVG = '这张图的填充引用了外部资源：\n\n```svg\n<svg viewBox="0 0 100 50"><rect width="100" height="50" fill="url(https://evil.example/x.svg#a)"/></svg>\n```';

// 第 3 题：两种围栏共存，各建各的块
const BOTH_KINDS = [
  '先看流程，再看图形。',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[开始] --> B[结束]',
  '```',
  '',
  '```svg',
  '<svg viewBox="0 0 100 50"><circle cx="50" cy="25" r="20" fill="#e6f4ff"/></svg>',
  '```',
].join('\n');

// 第 4 题：普通代码块（对照组）
const JS_EXPLAIN = '普通代码块照旧：\n\n```js\nconst t = "[00:20]"; // 代码里的时间戳不该变成链接\n```';

const QUESTIONS = [
  {
    stem: '抛物线开口向上的图像长什么样？',
    options: ['开口向上', '开口向下', '开口向左', '开口向右'],
    answer: 0,
    explanation: GOOD_SVG,
    time: '00:10',
  },
  {
    stem: '这张图为什么画不出来？',
    options: ['语法错误', '引用了外部资源', '尺寸太小', '颜色不对'],
    answer: 1,
    explanation: EXTERNAL_SVG,
  },
  {
    stem: '同一条解析里可以放几种图？',
    options: ['只能一种', '两种都可以', '只能 mermaid', '只能 svg'],
    answer: 1,
    explanation: BOTH_KINDS,
  },
  {
    stem: '解析里的代码块会被渲染成图吗？',
    options: ['会', '不会', '看语言', '看长度'],
    answer: 1,
    explanation: JS_EXPLAIN,
  },
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => {
  failed++;
  console.error(`   ❌ ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

await page.addInitScript(() => {
  localStorage.setItem('wangke-settings', JSON.stringify({
    state: { apiKey: 'sk-fake-for-e2e', baseUrl: 'https://api.siliconflow.cn/v1' },
    version: 0,
  }));
});

console.log('1. 导入测试视频');
await page.goto(BASE, { waitUntil: 'networkidle' });
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

console.log('2. 播种子库（字幕 + 向量索引 + 带 quiz 的会话历史）');
await page.evaluate(async ({ videoId, questions }) => {
  const req = indexedDB.open('wangke');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
  const put = (store, value) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const q = tx.objectStore(store).add(value);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  const now = Date.now();
  const segId = await put('segments', { videoId, idx: 0, start: 0, end: 20, text: '这是一段用来解锁问答面板的测试字幕。', status: 1 });
  await put('embeddings', { videoId, segmentId: segId, vector: new Float32Array(8).buffer });
  const sid = await put('chatSessions', { videoId, title: 'svg 围栏验收', createdAt: now });
  await put('chats', { role: 'user', videoId, sessionId: sid, content: '考考我', createdAt: now });
  await put('chats', {
    role: 'assistant',
    videoId,
    sessionId: sid,
    content: '这 4 道题覆盖了本节的核心概念。',
    quiz: { data: { questions }, picks: questions.map(() => -1) },
    createdAt: now + 1000,
  });
  db.close();
}, { videoId, questions: QUESTIONS });

console.log('3. 重载并进入播放页的问答面板');
await page.goto(`${BASE}/#/player/${videoId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('video', { timeout: 20000 });
await page.getByRole('tab', { name: '问答', exact: true }).click();
await page.waitForSelector('[data-testid="quiz-card"]', { timeout: 20000 });

console.log('4. 逐题作答（解析只在作答后展开）');
const qs = page.locator('[data-testid="quiz-card"] .quiz-q');
const qCount = await qs.count();
check(qCount === QUESTIONS.length, `题卡渲染出 ${QUESTIONS.length} 道题（实得 ${qCount}）`);
for (let i = 0; i < qCount; i++) {
  await qs.nth(i).locator('button').first().click();
  await page.waitForTimeout(250);
}
// svg 是同步净化，不需要等 chunk；等一拍让 React 落定
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="quiz-explain-md"] [data-testid="svg-block"]').length >= 3,
  null,
  { timeout: 20000 },
).catch(() => null);
await page.waitForTimeout(400);

console.log('5. 断言');
const state = await page.evaluate(() => {
  const explains = [...document.querySelectorAll('[data-testid="quiz-explain-md"]')];
  const svgBlocksIn = (el) => [...el.querySelectorAll('[data-testid="svg-block"]')];
  const mmBlocksIn = (el) => [...el.querySelectorAll('[data-testid="mermaid-block"]')];
  const [e0, e1, e2, e3] = explains;
  const b0 = svgBlocksIn(e0)[0] ?? null;
  const b1 = svgBlocksIn(e1)[0] ?? null;
  const canvas = b0?.querySelector('[data-testid="svg-canvas"]');
  const svgEl = canvas?.querySelector('svg');
  return {
    explainCount: explains.length,
    q1: {
      svgBlocks: svgBlocksIn(e0).length,
      mmBlocks: mmBlocksIn(e0).length,
      phase: b0?.getAttribute('data-phase') ?? null,
      hasSvg: !!svgEl,
      viewBox: svgEl?.getAttribute('viewBox') ?? null,
      // 净化后元素与属性是否真的活下来
      lines: canvas?.querySelectorAll('line').length ?? 0,
      paths: canvas?.querySelectorAll('path').length ?? 0,
      textLabels: [...(canvas?.querySelectorAll('text') ?? [])].map((t) => t.textContent?.trim()).filter(Boolean),
      strokeWidth: canvas?.querySelector('path')?.getAttribute('stroke-width') ?? null,
      toolbars: {
        copy: !!b0?.querySelector('[data-testid="svg-copy"]'),
        zoom: !!b0?.querySelector('[data-testid="svg-zoom"]'),
        download: !!b0?.querySelector('[data-testid="svg-download"]'),
      },
      // svg 的净化是纯函数：失败态不该给一个按不出变化的重试按钮
      retryBtn: !!b0?.querySelector('[data-testid="svg-retry"]'),
      tsLinks: [...e0.querySelectorAll('a.quiz-ts')].map((a) => a.textContent?.trim()),
      // 围栏内的 [00:30] 必须原样留在图里，不能被 linkify 改成链接
      anchorsInCanvas: canvas?.querySelectorAll('a').length ?? 0,
    },
    q2: {
      svgBlocks: svgBlocksIn(e1).length,
      phase: b1?.getAttribute('data-phase') ?? null,
      errText: b1?.querySelector('[data-testid="svg-error"]')?.textContent ?? null,
      source: b1?.querySelector('[data-testid="svg-source"]')?.textContent ?? null,
    },
    q3: {
      svgBlocks: svgBlocksIn(e2).length,
      mmBlocks: mmBlocksIn(e2).length,
      svgPhase: svgBlocksIn(e2)[0]?.getAttribute('data-phase') ?? null,
      mmPhase: mmBlocksIn(e2)[0]?.getAttribute('data-phase') ?? null,
    },
    q4: {
      svgBlocks: svgBlocksIn(e3).length,
      mmBlocks: mmBlocksIn(e3).length,
      codeText: e3.querySelector('pre code')?.textContent ?? null,
    },
    totalSvg: document.querySelectorAll('[data-testid="quiz-card"] [data-testid="svg-block"]').length,
    totalMm: document.querySelectorAll('[data-testid="quiz-card"] [data-testid="mermaid-block"]').length,
  };
});

check(state.explainCount === 4, `4 道题的解析都展开（实得 ${state.explainCount}）`);
check(state.totalSvg === 3, `svg 围栏建出 3 个块（实得 ${state.totalSvg}）`);
check(state.totalMm === 1, `mermaid 围栏仍建 1 个块（实得 ${state.totalMm}）`);

check(state.q1.svgBlocks === 1 && state.q1.mmBlocks === 0, '只对 svg 围栏建 svg 块');
check(state.q1.phase === 'ok', `合法 SVG 渲染成功（phase=${state.q1.phase}）`);
check(state.q1.hasSvg, '净化后的 SVG 真的插进了画布');
check(state.q1.viewBox === '0 0 220 140', `viewBox 未被 HTML 解析器改写（实得 ${state.q1.viewBox}）`);
check(state.q1.lines === 2 && state.q1.paths === 1, `图元保留（line=${state.q1.lines} path=${state.q1.paths}）`);
check(state.q1.strokeWidth === '2', `描边属性保留（stroke-width=${state.q1.strokeWidth}）`);
check(state.q1.textLabels.length === 1 && state.q1.textLabels[0].includes('顶点'), `中文标签保留（${JSON.stringify(state.q1.textLabels)}）`);
check(state.q1.toolbars.copy && state.q1.toolbars.zoom && state.q1.toolbars.download, 'svg 块工具条齐全（复制/大图/下载）');
check(!state.q1.retryBtn, 'svg 失败态才不给重试按钮，成功态自然也没有');
check(state.q1.anchorsInCanvas === 0, '画布内没有混进链接（围栏内的时间戳未被 linkify）');
check(state.q1.tsLinks.length === 1 && state.q1.tsLinks[0] === '[00:10]', `围栏外的时间戳正常成链接（${JSON.stringify(state.q1.tsLinks)}）`);

check(state.q2.svgBlocks === 1 && state.q2.phase === 'error', `外部引用被拒绝渲染（phase=${state.q2.phase}）`);
check(!!state.q2.errText?.includes('外部资源'), `错误提示点明原因（${JSON.stringify(state.q2.errText?.slice(0, 40))}）`);
check(!!state.q2.source?.includes('evil.example'), '失败态仍给出源码（不吞信息）');

check(state.q3.svgBlocks === 1 && state.q3.mmBlocks === 1, '两种围栏共存时各建各的块');
check(state.q3.svgPhase === 'ok' && state.q3.mmPhase === 'ok', `两种块都渲染成功（svg=${state.q3.svgPhase} mermaid=${state.q3.mmPhase}）`);

check(state.q4.svgBlocks === 0 && state.q4.mmBlocks === 0, '普通代码块不建图表块');
check(!!state.q4.codeText?.includes('const t = "[00:20]"'), '普通代码块内容原样保留');

await page.screenshot({ path: `${SHOTS}/svg-fence.png`, fullPage: true });
await page.locator('[data-testid="quiz-explain-md"] [data-testid="svg-canvas"]').first().scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/svg-fence-figure.png` });

console.log('6. 交互：查看大图 / 源码折叠');
await page.locator('[data-testid="quiz-explain-md"] [data-testid="svg-zoom"]').first().click();
await page.waitForTimeout(500);
const zoom = await page.evaluate(() => {
  const inner = document.querySelector('[data-testid="svg-zoom-dialog"] .xmd-mermaid-zoom');
  const label = document.querySelector('[data-testid="svg-zoom-label"]');
  const svg = inner?.querySelector('svg');
  return { visible: !!inner && inner.getBoundingClientRect().height > 0, label: label?.textContent ?? null, hasSvg: !!svg };
});
check(zoom.visible && zoom.hasSvg, '「查看大图」弹层打开且里面有图');
check(zoom.label === '100%', `缩放档位初始为 100%（实得 ${zoom.label}）`);
await page.screenshot({ path: `${SHOTS}/svg-fence-zoom.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

await page.locator('[data-testid="quiz-explain-md"] [data-testid="svg-source-toggle"]').first().click();
await page.waitForTimeout(300);
const src = await page.locator('[data-testid="quiz-explain-md"] [data-testid="svg-source"]').first().innerText();
check(src.includes('viewBox="0 0 220 140"'), '源码折叠展开后是围栏原文（不是净化后的串）');
check(src.includes('[00:30] 顶点'), '源码里的时间戳未被改写成 markdown 链接');
check(!src.includes('](#seek-'), '源码里没有混进 markdown 链接');

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
