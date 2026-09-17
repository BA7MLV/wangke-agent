/* eslint-disable no-console */
// E2E：题卡解析（explanation）的 Markdown + Mermaid 渲染链路
//   1. 解析里的 ```mermaid 围栏 → 渲染成 SVG，工具条齐全
//   2. 解析里的 [mm:ss] → 可点击跳转，点一下播放器真的动
//   3. 解析里的 markdown（粗体 / 列表）正常渲染，不留 ** 星号
//   4. 非法图语法 → 回退源码 + 错误提示（不吞信息）
//   5. 普通代码块不建图块，且块内的时间戳不被 linkify 改写（图/码源码不被破坏）
//
// 用法：node scripts/e2e-quiz-mermaid.mjs
//   BASE_URL 默认 http://localhost:5173（dev / preview 均可：按「播种子库 → 整页重载」驱动）
//   TEST_FILE 不传时用 ffmpeg 现造一段 20s 带音轨的样片
//   不调真实 API：题卡由自播种的 chats 行（quiz 字段）直接喂给组件
//
// 为什么渲染契约放在这里而不是单测：XMarkdown 依赖 DOMPurify + window，Node 里既不产出内容
// 也 import 不进来（CJS 构建顶层 require 一个 .css）。见 scripts/test-quiz.mjs 顶部的替身说明。
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const TEST_FILE = process.env.TEST_FILE || '/tmp/wangke-quiz-mermaid-test.mp4';
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

// 第 1 题的解析：正文 + 合法图 + 列表 + 两处时间戳（围栏外一处、围栏内一处）
const GOOD_EXPLAIN = [
  '进程是资源分配单位 [00:10]，线程是调度单位。',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[00:30] --> B[结束]',
  '```',
  '',
  '要点：',
  '- 资源归**进程**',
  '- 执行归**线程**',
].join('\n');

// 第 2 题：图语法不合法（少一个右括号）
const BAD_EXPLAIN = '这段图的语法不合法，应该能一眼看出问题：\n\n```mermaid\nflowchart LR\n  A[开始 --> B\n```';

// 第 3 题：普通代码块，且块内的时间戳不该被 linkify 改写
const JS_EXPLAIN = '普通代码块照旧：\n\n```js\nconst t = "[00:20]"; // 代码里的时间戳不该变成链接\n```';

const QUESTIONS = [
  {
    stem: '进程与线程的主要区别是什么？',
    options: ['资源分配 vs 调度单位', '编译期 vs 运行期', '同步 vs 异步', '静态 vs 动态'],
    answer: 0,
    explanation: GOOD_EXPLAIN,
    time: '00:10',
  },
  {
    stem: '下面哪段图语法有问题？',
    options: ['A', 'B', 'C', 'D'],
    answer: 1,
    explanation: BAD_EXPLAIN,
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
const fail = (msg) => { failed++; console.error(`   ❌ ${msg}`); };
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
  // 1 段字幕 + 1 条向量即可让「问答」面板解锁（不调真实 API）
  const segId = await put('segments', { videoId, idx: 0, start: 0, end: 20, text: '这是一段用来解锁问答面板的测试字幕。', status: 1 });
  await put('embeddings', { videoId, segmentId: segId, vector: new Float32Array(8).buffer });
  const sid = await put('chatSessions', { videoId, title: '题卡解析出图验收', createdAt: now });
  await put('chats', { role: 'user', videoId, sessionId: sid, content: '考考我', createdAt: now });
  // picks 全 -1：题卡进来是未作答态，答案由 E2E 点击产生
  await put('chats', {
    role: 'assistant',
    videoId,
    sessionId: sid,
    content: '这 3 道题覆盖了本节的核心概念。',
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
  await page.waitForTimeout(300);
}
// 等 mermaid chunk 拉取 + SVG 渲染
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="quiz-explain-md"] [data-testid="mermaid-block"][data-phase="ok"]').length >= 1,
  null,
  { timeout: 30000 },
).catch(() => null);
await page.waitForTimeout(500);

console.log('5. 断言');
const state = await page.evaluate(() => {
  const explains = [...document.querySelectorAll('[data-testid="quiz-explain-md"]')];
  const blocksIn = (el) => [...el.querySelectorAll('[data-testid="mermaid-block"]')];
  const tsLinks = (el) => [...el.querySelectorAll('a.quiz-ts')];
  const [e0, e1, e2] = explains;
  const okBlock = blocksIn(e0)[0] ?? null;
  const errBlock = blocksIn(e1)[0] ?? null;
  return {
    explainCount: explains.length,
    q1: {
      blocks: blocksIn(e0).length,
      phase: okBlock?.getAttribute('data-phase') ?? null,
      hasSvg: !!okBlock?.querySelector('[data-testid="mermaid-canvas"] svg'),
      nodeLabels: [...(okBlock?.querySelectorAll('foreignObject span') ?? [])].map((s) => s.textContent?.trim()).filter(Boolean),
      toolbars: {
        copy: !!okBlock?.querySelector('[data-testid="mermaid-copy"]'),
        zoom: !!okBlock?.querySelector('[data-testid="mermaid-zoom"]'),
        download: !!okBlock?.querySelector('[data-testid="mermaid-download"]'),
      },
      tsTexts: tsLinks(e0).map((a) => a.textContent?.trim()),
      listItems: e0.querySelectorAll('li').length,
      strong: e0.querySelectorAll('strong').length,
      rawStars: (e0.innerText.match(/\*\*/g) || []).length,
    },
    q2: {
      blocks: blocksIn(e1).length,
      phase: errBlock?.getAttribute('data-phase') ?? null,
      errText: errBlock?.querySelector('[data-testid="mermaid-error"]')?.textContent ?? null,
      errSource: errBlock?.querySelector('[data-testid="mermaid-source"]')?.textContent ?? null,
    },
    q3: {
      blocks: blocksIn(e2).length,
      codeText: e2.querySelector('pre code')?.textContent ?? null,
      anchorsInCode: e2.querySelectorAll('pre code a').length,
      tsLinks: tsLinks(e2).length,
    },
    totalBlocks: document.querySelectorAll('[data-testid="quiz-card"] [data-testid="mermaid-block"]').length,
  };
});

check(state.explainCount === 3, `3 道题的解析都展开（实得 ${state.explainCount}）`);
check(state.totalBlocks === 2, `只对 mermaid 围栏建块（2 个：1 正常 + 1 失败，实得 ${state.totalBlocks}）`);

check(state.q1.blocks === 1 && state.q1.phase === 'ok', `合法围栏渲染成功（phase=${state.q1.phase}）`);
check(state.q1.hasSvg, '解析里的图渲染出 SVG');
check(state.q1.toolbars.copy && state.q1.toolbars.zoom && state.q1.toolbars.download, '图块工具条齐全（复制/大图/下载）');
check(state.q1.listItems >= 2, `markdown 列表正常渲染（li=${state.q1.listItems}）`);
check(state.q1.strong >= 2, `markdown 粗体正常渲染（strong=${state.q1.strong}）`);
check(state.q1.rawStars === 0, `没有残留 ** 星号（实得 ${state.q1.rawStars}）`);
check(state.q1.tsTexts.length === 1 && state.q1.tsTexts[0] === '[00:10]',
  `解析里的时间戳渲染成 1 个跳转链接（实得 ${JSON.stringify(state.q1.tsTexts)}）`);

check(state.q2.blocks === 1 && state.q2.phase === 'error', `非法语法回退为错误态（phase=${state.q2.phase}）`);
check(!!state.q2.errText?.includes('图表渲染失败'), '失败态给出错误提示');
check(!!state.q2.errSource?.includes('A[开始 --> B'), '失败态仍给出源码（不吞信息）');

check(state.q3.blocks === 0, '普通代码块不建图块');
check(!!state.q3.codeText?.includes('const t = "[00:20]"'), '普通代码块内容原样保留');
check(state.q3.anchorsInCode === 0 && state.q3.tsLinks === 0, '代码块内的时间戳没有被 linkify');

await page.screenshot({ path: `${SHOTS}/quiz-mermaid.png`, fullPage: true });
await page.locator('[data-testid="quiz-explain-md"] [data-testid="mermaid-block"][data-phase="ok"]').scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/quiz-mermaid-flow.png` });

console.log('6. 交互：时间戳跳转 / 源码预览是否被 linkify 破坏');
const tsLink = page.locator('[data-testid="quiz-explain-md"] a.quiz-ts').first();
check((await tsLink.count()) > 0, '解析里的时间戳是可点击链接');
await tsLink.click();
await page.waitForTimeout(800);
const ct = await page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
check(ct >= 9 && ct <= 12, `点解析里的 [00:10] 跳到 10s（实得 ${Number(ct).toFixed(1)}s）`);

// 展开图块源码：围栏内的 A[00:30] 必须逐字保留（被 linkify 改写成 [00:30](#seek-30) 的话，
// 图源码当场损坏 —— 这是围栏保护那条规则在题卡场景的回归位）
await page.locator('[data-testid="quiz-explain-md"] [data-testid="mermaid-source-toggle"]').first().click();
await page.waitForTimeout(300);
const src = await page.locator('[data-testid="quiz-explain-md"] [data-testid="mermaid-source"]').first().innerText();
check(src.includes('A[00:30] --> B[结束]'), `图源码里的时间戳未被改写（${JSON.stringify(src.slice(0, 60))}…）`);
check(!src.includes('](#seek-'), '图源码里没有混进 markdown 链接');
await page.screenshot({ path: `${SHOTS}/quiz-mermaid-source.png` });

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
