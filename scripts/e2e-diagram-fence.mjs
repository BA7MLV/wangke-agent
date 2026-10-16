/* eslint-disable no-console */
// E2E：```diagram 围栏（JSON 中间层）在题卡解析里的渲染链路
//   1. 合法 diagram JSON → 校验 + 渲染成图，工具条齐全（复制 / 大图 / 下载），中文标签保留
//   2. 围栏内的 [mm:ss] 不被 linkify 改写（与 mermaid 同一条围栏保护）
//   3. 坏 JSON / 坏 schema → 拒绝渲染 + 回退源码（不静默吞掉，也不给重试按钮）
//   4. 同一条解析里 mermaid / diagram / 历史 svg 三种围栏共存，各建各的块
//   5. 普通代码块照旧不建块
//   6. 围栏参数里的 title 显示在块头（图种标签之后）、进弹层标题；没写的退回图种标签
//
// 用法：node scripts/e2e-diagram-fence.mjs
//   BASE_URL 默认 http://localhost:5173（dev / preview 均可：按「播种子库 → 整页重载」驱动）
//   TEST_FILE 不传时用 ffmpeg 现造一段 20s 带音轨的样片
//   不调真实 API：题卡由自播种的 chats 行（quiz 字段）直接喂给组件
//
// 为什么净化/校验本身的正确性不在这里验：那属于纯函数契约，见
// scripts/test-json-diagram.mjs（Node）与 scripts/probe-json-diagram.mjs（真浏览器）。
// 这里只验「接进渲染链路之后」的行为。
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const TEST_FILE = process.env.TEST_FILE || '/tmp/wangke-diagram-fence-test.mp4';
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

// 第 1 题：合法 diagram（坐标轴 + 抛物线 + 中文标签），围栏参数里带 title，
// 埋一处 [00:30] 在标注里验围栏保护
const GOOD_DIAGRAM = [
  '抛物线开口向上 [00:10]，顶点在原点附近。',
  '',
  '```diagram title="抛物线开口方向"',
  '{"type":"plot","x":[-3,3],"y":[-1,5],"curves":[{"fn":"x^2","label":"y=x²"}],"points":[{"at":[0,0],"label":"顶点"}],"labels":[{"at":[2.2,4],"text":"[00:30] 开口向上"}]}',
  '```',
].join('\n');

// 第 2 题：JSON 语法错误（多一个逗号）—— 闭合后必须报错并回退源码
const BAD_JSON = '这张图的 JSON 多了一个逗号：\n\n```diagram\n{"type":"plot","x":[-3,3],"y":[-1,5],}\n```';

// 第 3 题：schema 锁字段（colour 不在 schema 里）
const BAD_SCHEMA = '这个字段名是发明出来的：\n\n```diagram\n{"type":"graph","nodes":[{"id":"a","label":"客户端","colour":"#1677ff"}]}\n```';

// 第 4 题：三种围栏共存，各建各的块（svg 是历史数据兼容路径）
const THREE_KINDS = [
  '先看流程，再看函数图像，最后是历史数据里的原生 SVG。',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[开始] --> B[结束]',
  '```',
  '',
  '```diagram',
  '{"type":"graph","direction":"LR","nodes":[{"id":"c","label":"客户端"},{"id":"s","label":"服务端"}],"edges":[{"from":"c","to":"s","label":"请求"}]}',
  '```',
  '',
  '```svg',
  '<svg viewBox="0 0 100 50"><circle cx="50" cy="25" r="20" fill="#e6f4ff"/></svg>',
  '```',
].join('\n');

// 第 5 题：普通代码块（对照组）
const JS_EXPLAIN = '普通代码块照旧：\n\n```js\nconst t = "[00:20]"; // 代码里的时间戳不该变成链接\n```';

const QUESTIONS = [
  {
    stem: '抛物线开口向上的图像长什么样？',
    options: ['开口向上', '开口向下', '开口向左', '开口向右'],
    answer: 0,
    explanation: GOOD_DIAGRAM,
    time: '00:10',
  },
  {
    stem: '这张图为什么画不出来？',
    options: ['JSON 语法错误', '节点太多', '颜色太浅', '标签太长'],
    answer: 0,
    explanation: BAD_JSON,
  },
  {
    stem: '哪个字段名是 schema 里没有的？',
    options: ['label', 'colour', 'id', 'shape'],
    answer: 1,
    explanation: BAD_SCHEMA,
  },
  {
    stem: '同一条解析里可以放几种图？',
    options: ['只能一种', '三种都可以', '只能 mermaid', '只能 diagram'],
    answer: 1,
    explanation: THREE_KINDS,
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
// 应用默认落在「课程助手」页，导入控件在课程库页 —— 已在导入页就原地等，没在就点过去
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

console.log('2. 播种子库（字幕 + 带 quiz 的会话历史）');
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
  await put('segments', { videoId, idx: 0, start: 0, end: 20, text: '这是一段用来解锁问答面板的测试字幕。', status: 1 });
  const sid = await put('chatSessions', { videoId, title: 'diagram 围栏验收', createdAt: now });
  await put('chats', { role: 'user', videoId, sessionId: sid, content: '考考我', createdAt: now });
  await put('chats', {
    role: 'assistant',
    videoId,
    sessionId: sid,
    content: '这 5 道题覆盖了本节的核心概念。',
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
// diagram 是同步校验 + 同步渲染，不需要等 chunk；等一拍让 React 落定
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="quiz-explain-md"] [data-testid="diagram-block"]').length >= 3,
  null,
  { timeout: 20000 },
).catch(() => null);
await page.waitForTimeout(400);

console.log('5. 断言');
const state = await page.evaluate(() => {
  const explains = [...document.querySelectorAll('[data-testid="quiz-explain-md"]')];
  const blocksIn = (el, id) => [...el.querySelectorAll(`[data-testid="${id}-block"]`)];
  const [e0, e1, e2, e3, e4] = explains;
  const b0 = blocksIn(e0, 'diagram')[0] ?? null;
  const canvas = b0?.querySelector('[data-testid="diagram-canvas"]');
  return {
    explainCount: explains.length,
    q1: {
      diagramBlocks: blocksIn(e0, 'diagram').length,
      mmBlocks: blocksIn(e0, 'mermaid').length,
      svgBlocks: blocksIn(e0, 'svg').length,
      phase: b0?.getAttribute('data-phase') ?? null,
      paths: canvas?.querySelectorAll('path').length ?? 0,
      circles: canvas?.querySelectorAll('circle').length ?? 0,
      texts: [...(canvas?.querySelectorAll('text') ?? [])].map((t) => t.textContent?.trim()).filter(Boolean),
      toolbars: {
        copy: !!b0?.querySelector('[data-testid="diagram-copy"]'),
        zoom: !!b0?.querySelector('[data-testid="diagram-zoom"]'),
        download: !!b0?.querySelector('[data-testid="diagram-download"]'),
      },
      retryBtn: !!b0?.querySelector('[data-testid="diagram-retry"]'),
      // 围栏参数里的标题（```diagram title="…"）：与图种标签一起在块头，超长时靠 title 属性悬停看全
      tag: b0?.querySelector('.xmd-mermaid-tag')?.textContent ?? null,
      title: b0?.querySelector('[data-testid="diagram-title"]')?.textContent ?? null,
      titleAttr: b0?.querySelector('[data-testid="diagram-title"]')?.getAttribute('title') ?? null,
      tsLinks: [...e0.querySelectorAll('a.quiz-ts')].map((a) => a.textContent?.trim()),
      // 围栏内的 [00:30] 必须原样留在图里，不能被 linkify 改成链接
      anchorsInCanvas: canvas?.querySelectorAll('a').length ?? 0,
      hasLiteralTs: [...(canvas?.querySelectorAll('text') ?? [])].some((t) => (t.textContent ?? '').includes('[00:30]')),
    },
    q2: {
      diagramBlocks: blocksIn(e1, 'diagram').length,
      phase: blocksIn(e1, 'diagram')[0]?.getAttribute('data-phase') ?? null,
      errText: blocksIn(e1, 'diagram')[0]?.querySelector('[data-testid="diagram-error"]')?.textContent ?? null,
      source: blocksIn(e1, 'diagram')[0]?.querySelector('[data-testid="diagram-source"]')?.textContent ?? null,
    },
    q3: {
      diagramBlocks: blocksIn(e2, 'diagram').length,
      phase: blocksIn(e2, 'diagram')[0]?.getAttribute('data-phase') ?? null,
      errText: blocksIn(e2, 'diagram')[0]?.querySelector('[data-testid="diagram-error"]')?.textContent ?? null,
      source: blocksIn(e2, 'diagram')[0]?.querySelector('[data-testid="diagram-source"]')?.textContent ?? null,
    },
    q4: {
      mmBlocks: blocksIn(e3, 'mermaid').length,
      diagramBlocks: blocksIn(e3, 'diagram').length,
      svgBlocks: blocksIn(e3, 'svg').length,
      mmPhase: blocksIn(e3, 'mermaid')[0]?.getAttribute('data-phase') ?? null,
      diagramPhase: blocksIn(e3, 'diagram')[0]?.getAttribute('data-phase') ?? null,
      svgPhase: blocksIn(e3, 'svg')[0]?.getAttribute('data-phase') ?? null,
      // 这三条围栏都没写 title：块头只该有图种标签（老内容不变样）。
      // 返回布尔而不是元素 —— 元素过不了 page.evaluate 的序列化。
      titleEls: [
        blocksIn(e3, 'mermaid')[0],
        blocksIn(e3, 'diagram')[0],
        blocksIn(e3, 'svg')[0],
      ].map((b) => !!b?.querySelector('[data-testid$="-title"]')),
    },
    q5: {
      mmBlocks: blocksIn(e4, 'mermaid').length,
      diagramBlocks: blocksIn(e4, 'diagram').length,
      svgBlocks: blocksIn(e4, 'svg').length,
      codeText: e4.querySelector('pre code')?.textContent ?? null,
    },
    totalDiagram: document.querySelectorAll('[data-testid="quiz-card"] [data-testid="diagram-block"]').length,
    totalMm: document.querySelectorAll('[data-testid="quiz-card"] [data-testid="mermaid-block"]').length,
    totalSvg: document.querySelectorAll('[data-testid="quiz-card"] [data-testid="svg-block"]').length,
  };
});

check(state.explainCount === 5, `5 道题的解析都展开（实得 ${state.explainCount}）`);
// 4 个 diagram 围栏：合法图 / 坏 JSON / 坏 schema / 与另两种共存。
// 数的是「建出了块」，不是「渲染成功」—— 坏的两个也必须各建各的块（错了要看得见）。
check(state.totalDiagram === 4, `diagram 围栏建出 4 个块（实得 ${state.totalDiagram}）`);
check(state.totalMm === 1, `mermaid 围栏仍建 1 个块（实得 ${state.totalMm}）`);
check(state.totalSvg === 1, `历史 svg 围栏仍建 1 个块（实得 ${state.totalSvg}）`);

check(state.q1.diagramBlocks === 1 && state.q1.mmBlocks === 0 && state.q1.svgBlocks === 0, '只对 diagram 围栏建 diagram 块');
check(state.q1.phase === 'ok', `合法 diagram 渲染成功（phase=${state.q1.phase}）`);
check(state.q1.paths >= 1, `曲线真的画出来了（${state.q1.paths} 条 path）`);
check(state.q1.circles >= 1, `关键点真的画出来了（${state.q1.circles} 个 circle）`);
check(state.q1.texts.some((t) => t?.includes('顶点')) && state.q1.texts.some((t) => t?.includes('y=x²')),
  `中文标签保留（${JSON.stringify(state.q1.texts)}）`);
check(state.q1.toolbars.copy && state.q1.toolbars.zoom && state.q1.toolbars.download, 'diagram 块工具条齐全（复制/大图/下载）');
check(state.q1.title === '抛物线开口方向', `围栏参数里的标题显示在块头（实得 ${JSON.stringify(state.q1.title)}）`);
check(state.q1.tag === 'DIAGRAM', `图种标签仍在标题之前（实得 ${JSON.stringify(state.q1.tag)}）`);
check(state.q1.titleAttr === '抛物线开口方向', '标题同时挂在 title 属性上（截断时悬停看全）');
check(!state.q1.retryBtn, '成功态没有重试按钮');
check(state.q1.anchorsInCanvas === 0, '画布内没有混进链接（围栏内的时间戳未被 linkify）');
check(state.q1.hasLiteralTs, '围栏里的 [00:30] 原样留在图层文字里');
check(state.q1.tsLinks.length === 1 && state.q1.tsLinks[0] === '[00:10]', `围栏外的时间戳正常成链接（${JSON.stringify(state.q1.tsLinks)}）`);

check(state.q2.diagramBlocks === 1 && state.q2.phase === 'error', `坏 JSON 被拒绝渲染（phase=${state.q2.phase}）`);
check(!!state.q2.errText?.includes('JSON'), `错误提示点明 JSON 问题（${JSON.stringify(state.q2.errText?.slice(0, 40))}）`);
check(!!state.q2.source?.includes('"type":"plot"'), '失败态仍给出源码（不吞信息）');

check(state.q3.diagramBlocks === 1 && state.q3.phase === 'error', `坏 schema 被拒绝渲染（phase=${state.q3.phase}）`);
check(!!state.q3.errText?.includes('colour'), `错误提示点名到字段（${JSON.stringify(state.q3.errText?.slice(0, 40))}）`);

check(state.q4.mmBlocks === 1 && state.q4.diagramBlocks === 1 && state.q4.svgBlocks === 1, '三种围栏共存时各建各的块');
check(state.q4.mmPhase === 'ok' && state.q4.diagramPhase === 'ok' && state.q4.svgPhase === 'ok',
  `三种块都渲染成功（mermaid=${state.q4.mmPhase} diagram=${state.q4.diagramPhase} svg=${state.q4.svgPhase}）`);
check(state.q4.titleEls.every((v) => v === false), '没写 title 的三条围栏都不冒标题元素（退回图种标签）');

check(state.q5.diagramBlocks === 0 && state.q5.mmBlocks === 0 && state.q5.svgBlocks === 0, '普通代码块不建图表块');
check(!!state.q5.codeText?.includes('const t = "[00:20]"'), '普通代码块内容原样保留');

await page.screenshot({ path: `${SHOTS}/diagram-fence.png`, fullPage: true });
await page.locator('[data-testid="quiz-explain-md"] [data-testid="diagram-canvas"]').first().scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/diagram-fence-figure.png` });

console.log('6. 交互：查看大图 / 源码折叠');
await page.locator('[data-testid="quiz-explain-md"] [data-testid="diagram-zoom"]').first().click();
await page.waitForTimeout(500);
const zoom = await page.evaluate(() => {
  const dialog = document.querySelector('[data-testid="diagram-zoom-dialog"]');
  const inner = dialog?.querySelector('.xmd-mermaid-zoom');
  const label = document.querySelector('[data-testid="diagram-zoom-label"]');
  const svg = inner?.querySelector('svg');
  return {
    visible: !!inner && inner.getBoundingClientRect().height > 0,
    label: label?.textContent ?? null,
    hasSvg: !!svg,
    // 弹层标题带上图的标题，放大之后仍然知道这是哪张图
    heading: dialog?.textContent ?? '',
  };
});
check(zoom.visible && zoom.hasSvg, '「查看大图」弹层打开且里面有图');
check(zoom.heading.includes('抛物线开口方向') && zoom.heading.includes('查看大图'),
  `弹层标题带上图的标题（${JSON.stringify(zoom.heading.slice(0, 30))}）`);
check(zoom.label === '100%', `缩放档位初始为 100%（实得 ${zoom.label}）`);
await page.screenshot({ path: `${SHOTS}/diagram-fence-zoom.png` });
await page.keyboard.press('Escape');
// 等弹层**真的退场**，别用固定 sleep。
// 已知问题（mdui→HeroUI 迁移期间）：Base UI 的 Modal 退场时 backdrop 会一直挂在 DOM 上
// （data-exiting="true"），并吃掉后续点击的 pointer event —— 同一个坑也让 e2e-svg-fence 失败。
// 这里不替迁移兜底：退场没结束就如实报出来，并把残留节点摘掉，好让本脚本其余断言跑完。
// 注意别用 force 绕：force 只是跳过命中测试，点击仍落在 backdrop 上，折叠根本不会触发。
const stuck = await page.locator('[data-slot="modal-backdrop"]').waitFor({ state: 'detached', timeout: 4000 })
  .then(() => false, () => true);
if (stuck) {
  console.log('   ⚠ 弹层 backdrop 未退场（data-exiting 残留），已摘除以免吞掉后续点击');
  await page.evaluate(() => {
    document.querySelectorAll('[data-slot="modal-backdrop"]').forEach((e) => e.remove());
  });
}

await page.locator('[data-testid="quiz-explain-md"] [data-testid="diagram-source-toggle"]').first().click();
await page.waitForTimeout(300);
const src = await page.locator('[data-testid="quiz-explain-md"] [data-testid="diagram-source"]').first().innerText();
check(src.includes('"type": "plot"') || src.includes('"type":"plot"'), '源码折叠展开后是围栏里的 JSON 原文');
check(src.includes('[00:30] 开口向上'), '源码里的时间戳未被改写成 markdown 链接');
check(!src.includes('](#seek-'), '源码里没有混进 markdown 链接');

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
