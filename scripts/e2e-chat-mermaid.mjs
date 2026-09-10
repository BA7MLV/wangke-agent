/* eslint-disable no-console */
// E2E：问答面板的 Mermaid 渲染链路
//   1. 合法的 ```mermaid 围栏 → 渲染成 SVG，中文标签可见，不被 <pre> 包住，工具条齐全
//   2. 非法语法 → 回退源码 + 错误提示（不吞信息）
//   3. 未闭合围栏（流式半截）→ 停在「图表生成中」，不 parse
//   4. 普通代码块不受影响，且内部的时间戳标记不被 linkify 改写
//
// 用法：node scripts/e2e-chat-mermaid.mjs
//   BASE_URL 默认 http://localhost:5173（dev 或 preview 均可：这里按「播种子库 → 整页重载」驱动，
//   不依赖 Dexie liveQuery，故两种模式都行）
//   TEST_FILE 不传时用 ffmpeg 现造一段 20s 带音轨的样片
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const TEST_FILE = process.env.TEST_FILE || '/tmp/wangke-mermaid-test.mp4';
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

const FLOW =
  '```mermaid\ngraph TD\n  A[输入网络课程视频] --> B{是否已有字幕}\n  B -->|否| C[调用 ASR 转写]\n  B -->|是| D[建立向量索引]\n```';
const BAD = '```mermaid\ngraph TD\n  A[开始 --> B\n```';
const JSBLOCK = '```js\nconst start = "[03:25]"; // 代码里的时间戳不该变成链接\n```';
const OPEN = '```mermaid\ngraph LR\n  X[未写完的图] --> Y';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
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

console.log('2. 播种子库（字幕 + 向量索引 + 含 mermaid 的会话历史）');
await page.evaluate(async ({ videoId, FLOW, BAD, JSBLOCK, OPEN }) => {
  const req = indexedDB.open('wangke');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
  const put = (store, value) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const q = tx.objectStore(store).add(value);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  const now = Date.now();
  // 1 段字幕即可让「问答」面板解锁
  const segId = await put('segments', { videoId, idx: 0, start: 0, end: 20, text: '这是一段用来解锁问答面板的测试字幕。', status: 1 });
  // embeddings 数量 >= 已完成的段数时直接判定索引就绪，不会去调真实 API
  await put('embeddings', { videoId, segmentId: segId, vector: new Float32Array(8).buffer });
  const sid = await put('chatSessions', { videoId, title: 'Mermaid 渲染验收', createdAt: now });
  const rows = [
    { role: 'user', content: '讲一下这个课程的流程' },
    { role: 'assistant', content: `课程的整体流程如下，本节定义见 [03:25]。\n\n${FLOW}\n\n以上就是全流程。` },
    { role: 'assistant', content: `下面这段图语法不合法：\n\n${BAD}` },
    { role: 'assistant', content: `普通代码块：\n\n${JSBLOCK}` },
    { role: 'assistant', content: `流式没写完的图：\n\n${OPEN}` },
  ];
  for (let i = 0; i < rows.length; i++) {
    await put('chats', { videoId, sessionId: sid, role: rows[i].role, content: rows[i].content, createdAt: now + i * 1000 });
  }
  db.close();
}, { videoId, FLOW, BAD, JSBLOCK, OPEN });

console.log('3. 重载并进入播放页的问答面板');
await page.goto(`${BASE}/#/player/${videoId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('video', { timeout: 20000 });
await page.getByRole('tab', { name: '问答', exact: true }).click();
await page.waitForSelector('[data-testid="mermaid-block"]', { timeout: 20000 });
// 等 mermaid chunk 拉取 + SVG 渲染
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="mermaid-block"][data-phase="ok"]').length >= 1,
  null,
  { timeout: 30000 },
).catch(() => null);
await page.waitForTimeout(500);

console.log('4. 断言');
const state = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('[data-testid="mermaid-block"]')];
  const byPhase = (p) => blocks.find((b) => b.getAttribute('data-phase') === p) ?? null;
  const okBlock = byPhase('ok');
  const svg = okBlock?.querySelector('[data-testid="mermaid-canvas"] svg') ?? null;
  const errBlock = byPhase('error');
  const waitBlock = byPhase('waiting');
  // 普通代码块：取面板里所有 <pre><code> 的文本
  const codeText = [...document.querySelectorAll('[data-testid="chat-msg-ai"] pre code')].map((e) => e.textContent ?? '').join('\n');
  const codeHasAnchor = [...document.querySelectorAll('[data-testid="chat-msg-ai"] pre code a')].length;
  return {
    blockCount: blocks.length,
    phases: blocks.map((b) => b.getAttribute('data-phase')),
    wrappedInPre: blocks.filter((b) => b.parentElement?.tagName === 'PRE').length,
    hasSvg: !!svg,
    hasForeignObject: !!okBlock?.querySelector('foreignObject'),
    nodeLabels: [...(okBlock?.querySelectorAll('foreignObject span') ?? [])].map((s) => s.textContent?.trim()).filter(Boolean),
    toolbars: {
      copy: !!okBlock?.querySelector('[data-testid="mermaid-copy"]'),
      zoom: !!okBlock?.querySelector('[data-testid="mermaid-zoom"]'),
      download: !!okBlock?.querySelector('[data-testid="mermaid-download"]'),
    },
    seekLinkTexts: [...document.querySelectorAll('[data-testid="chat-msg-ai"] a')].map((a) => a.textContent?.trim()),
    errText: errBlock?.querySelector('[data-testid="mermaid-error"]')?.textContent ?? null,
    errSource: errBlock?.querySelector('[data-testid="mermaid-source"]')?.textContent ?? null,
    waitPending: !!waitBlock?.querySelector('[data-testid="mermaid-pending"]'),
    waitSource: waitBlock?.querySelector('[data-testid="mermaid-source"]')?.textContent ?? null,
    codeText,
    codeHasAnchor,
  };
});

check(state.blockCount === 3, `只对 mermaid 围栏建块（3 个，实得 ${state.blockCount}：${state.phases.join('/')}）`);
check(state.hasSvg, '合法围栏渲染出 SVG');
check(state.wrappedInPre === 0, 'mermaid 块没有被 <pre> 包住');
check(state.hasForeignObject, '流程图走 htmlLabels（foreignObject）分支');
check(state.nodeLabels.includes('输入网络课程视频'), `中文节点标签完整（实得 ${JSON.stringify(state.nodeLabels).slice(0, 120)}）`);
check(state.toolbars.copy && state.toolbars.zoom && state.toolbars.download, '工具条含 复制/大图/下载');
check(state.seekLinkTexts.includes('[03:25]'), `正文时间戳仍被 linkify（${JSON.stringify(state.seekLinkTexts)}）`);
check(!!state.errText?.includes('图表渲染失败'), '非法语法回退到错误提示');
check(!!state.errSource?.includes('A[开始 --> B'), '失败态仍给出源码');
check(state.waitPending, '未闭合围栏停在「图表生成中」');
check(!!state.waitSource?.includes('X[未写完的图]'), '未闭合围栏给出源码预览');
check(state.codeText.includes('const start = "[03:25]"'), '普通代码块内容原样保留');
check(state.codeHasAnchor === 0, '代码块内的时间戳没有被 linkify'); 

await page.screenshot({ path: `${SHOTS}/chat-mermaid.png`, fullPage: true });
// 图示区单独出一张：新消息会自动滚到底，先把渲染好的那块滚进视口
await page.locator('[data-testid="mermaid-block"][data-phase="ok"]').scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/chat-mermaid-flow.png` });

console.log('5. 交互：复制源码 / 查看大图');
const copyBtn = page.locator('[data-testid="mermaid-copy"]').first();
await copyBtn.click();
await page.waitForTimeout(300);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
check(clip.includes('graph TD'), `复制源码写入剪贴板（${JSON.stringify(clip.slice(0, 24))}…）`);
await page.locator('[data-testid="mermaid-zoom"]').first().click();
await page.waitForSelector('.xmd-mermaid-zoom', { timeout: 5000 });
await page.waitForTimeout(800); // 等 antd Modal 的进场动画结束再断言/截图
const zoomSvg = await page.locator('.xmd-mermaid-zoom-inner svg').count();
const zoomBox = await page.locator('[data-testid="mermaid-zoom-dialog"][open]').first().boundingBox();
const zoomVisible = await page.locator('.xmd-mermaid-zoom-inner svg').first().isVisible();
check(zoomSvg === 1 && zoomVisible && !!zoomBox, '大图弹层内渲染出 SVG');
// 缩放档位：放大后宽度应变化，复位后回到初值（按钮用 data-testid 定位：antd 6 可能给两字中文按钮插空格）
const inner = page.locator('.xmd-mermaid-zoom-inner').first();
const w0 = await inner.evaluate((el) => el.getBoundingClientRect().width);
await page.locator('[data-testid="mermaid-zoom-dialog"][open] [data-testid="mermaid-zoom-in"]').click();
await page.waitForTimeout(250);
const wZoom = await inner.evaluate((el) => el.getBoundingClientRect().width);
await page.locator('[data-testid="mermaid-zoom-dialog"][open] [data-testid="mermaid-zoom-reset"]').click();
await page.waitForTimeout(250);
const w1 = await inner.evaluate((el) => el.getBoundingClientRect().width);
check(wZoom > w0 * 1.2, `放大 25% 后宽度增加（${Math.round(w0)} → ${Math.round(wZoom)}px）`);
check(Math.abs(w1 - w0) < 2, `复位后宽度回到初值（${Math.round(w1)}px）`);
await page.screenshot({ path: `${SHOTS}/chat-mermaid-zoom.png` });

// 下载 SVG：文件要能独立打开且内容完整（含中文标签）
const [dl] = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }),
  page.locator('[data-testid="mermaid-zoom-dialog"][open] [data-testid="mermaid-zoom-download"]').click(),
]);
const svgPath = await dl.path();
const svgText = svgPath ? readFileSync(svgPath, 'utf8') : '';
check(/\.svg$/.test(dl.suggestedFilename()), `下载文件名为 .svg（${dl.suggestedFilename()}）`);
check(svgText.startsWith('<?xml') && svgText.includes('<svg'), '导出内容带 xml 头与 svg 根');
check(/<svg[^>]*width="\d+"/.test(svgText), '导出 svg 有显式宽度（独立打开不会缩成 0）');
check(svgText.includes('输入网络课程视频'), '导出 svg 含中文标签');
if (svgPath) {
  const viewer = await context.newPage();
  await viewer.goto(`file://${svgPath}`);
  const rendered = await viewer.evaluate(() => document.documentElement.textContent ?? '');
  check(rendered.includes('输入网络课程视频'), '导出的 svg 能被浏览器独立打开并渲染出文字');
  await viewer.close();
}

await page.keyboard.press('Escape');
await page.waitForTimeout(400);

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
