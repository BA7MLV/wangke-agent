/* eslint-disable no-console */
// E2E：问答会话「一键复制 Markdown / 导出 .md」（无需 API key）。
// 种入视频记录 + 字幕 + 索引 + 会话历史，验证：
// 1) 复制按钮把整会话 Markdown 写入剪贴板（安全上下文 navigator.clipboard 路径）
// 2) 导出按钮下载 .md 文件，文件名含课程名与会话标题
// 3) 非安全上下文（navigator.clipboard 缺失，模拟 iPad 局域网 http）走 execCommand 降级
// 用法：npm run preview &  然后 node scripts/e2e-chat-export.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const VIDEO_ID = 'e2e-export-vid';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const fail = (msg) => { console.error(`❌ ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`✅ ${msg}`);

/** 种入一条已转写视频 + 一条字幕 + 一条 embedding + 一个带历史的会话 */
async function seed(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15000 });
  await page.evaluate(async (videoId) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('wangke');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const tx = db.transaction(['videos', 'segments', 'embeddings', 'chatSessions', 'chats'], 'readwrite');
    tx.objectStore('videos').put({
      id: videoId,
      name: '测试课程.mp4',
      size: 1,
      mimeType: 'video/mp4',
      duration: 100,
      createdAt: Date.now(),
      status: 'transcribed',
    });
    tx.objectStore('segments').add({ videoId, idx: 0, start: 0, end: 5, text: '这是字幕内容', status: 1 });
    const sid = await new Promise((res, rej) => {
      const req = tx.objectStore('chatSessions').add({ videoId, title: '极限的定义', createdAt: Date.now() });
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const chats = tx.objectStore('chats');
    chats.add({
      videoId,
      sessionId: sid,
      role: 'user',
      content: '[截图@01:05]这道题怎么做？',
      createdAt: Date.now(),
    });
    chats.add({
      videoId,
      sessionId: sid,
      role: 'assistant',
      content: '见 [03:25] 的定义，画面 [图@04:10]。',
      reasoning: '先定位定义，再套公式',
      createdAt: Date.now() + 1,
      quiz: {
        data: {
          questions: [
            {
              stem: '极限存在的充要条件是？',
              options: ['左右极限存在', '左右极限存在且相等', '函数连续', '函数有界'],
              answer: 1,
              explanation: '见 [02:10] 的定理。',
              time: '02:10',
            },
          ],
        },
        picks: [2],
      },
    });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    // embedding 计数 >= 字幕数 → 索引视为就绪，不触发真实 API 建索引
    const seg = await new Promise((res, rej) => {
      const req = db.transaction('segments', 'readonly').objectStore('segments').getAll();
      req.onsuccess = () => res(req.result[0]);
      req.onerror = () => rej(req.error);
    });
    const tx2 = db.transaction('embeddings', 'readwrite');
    tx2.objectStore('embeddings').add({ videoId, segmentId: seg.id, vector: new ArrayBuffer(4) });
    await new Promise((res, rej) => {
      tx2.oncomplete = res;
      tx2.onerror = () => rej(tx2.error);
    });
    db.close();
  }, VIDEO_ID);
}

/** 进入问答页并等待面板就绪（复制按钮出现且可用） */
async function openChat(page) {
  await page.goto(`${BASE}/#/player/${VIDEO_ID}`, { waitUntil: 'networkidle' });
  await page.click('.ant-tabs-tab:has-text("问答")');
  const btn = page.locator('[data-testid="copy-session-btn"]');
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="copy-session-btn"]');
    return el && !el.disabled;
  }, { timeout: 15000 });
  return btn;
}

// ── 场景 1：安全上下文，navigator.clipboard 路径 ─────────────────────────────
const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
await seed(page);
console.log('1. 进入问答面板（含历史消息）');
await openChat(page);

console.log('2. 点击「复制整个会话」，读取剪贴板');
await page.click('[data-testid="copy-session-btn"]');
await page.waitForSelector('.ant-message-success', { timeout: 5000 });
const clip = await page.evaluate(() => navigator.clipboard.readText());
const checks = [
  ['标题', '# 极限的定义'],
  ['课程', '- 课程：测试课程.mp4'],
  ['用户轮', '## 我\n\n[截图@01:05]这道题怎么做？'],
  ['助手轮', '## 助手\n\n见 [03:25] 的定义，画面 [图@04:10]。'],
  ['思考折叠', '<summary>思考过程</summary>\n\n先定位定义，再套公式'],
  ['题卡选项', '- A. 左右极限存在\n- B. 左右极限存在且相等'],
  ['答案折叠', '**正确答案：B**'],
  ['作答标记', '我的作答：C（错误）'],
];
for (const [name, needle] of checks) {
  if (clip.includes(needle)) ok(`剪贴板含${name}`);
  else fail(`剪贴板缺${name}：${JSON.stringify(clip.slice(0, 200))}`);
}

console.log('3. 点击「导出 .md」，校验文件名与内容');
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }),
  page.click('[data-testid="export-session-btn"]'),
]);
const fname = download.suggestedFilename();
if (fname === '测试课程-极限的定义.md') ok(`文件名 ${fname}`);
else fail(`文件名不符：${fname}`);
const fs = await import('node:fs/promises');
const path = await download.path();
const content = await fs.readFile(path, 'utf8');
if (content === clip) ok('导出内容与剪贴板一致');
else fail('导出内容与剪贴板不一致');

console.log('4. 新开会话（空会话）时复制/导出按钮禁用');
await page.click('button:has(.anticon-plus)');
await page.waitForFunction(() => {
  const el = document.querySelector('[data-testid="copy-session-btn"]');
  return el && el.disabled;
}, { timeout: 5000 });
ok('空会话按钮已禁用');
await ctx.close();

// ── 场景 2：非安全上下文（无 navigator.clipboard），execCommand 降级 ──────────
console.log('5. 模拟 iPad 局域网 http：navigator.clipboard 缺失时的降级路径');
const ctx2 = await browser.newContext();
await ctx2.addInitScript(() => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  // 拦截 execCommand 捕获临时 textarea 的值（headless 下真实剪贴板不可读）
  const orig = document.execCommand.bind(document);
  document.execCommand = (cmd, ...rest) => {
    if (cmd === 'copy') {
      window.__copied = document.activeElement?.value ?? '';
      return true;
    }
    return orig(cmd, ...rest);
  };
});
const page2 = await ctx2.newPage();
page2.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
await seed(page2);
await openChat(page2);
await page2.click('[data-testid="copy-session-btn"]');
await page2.waitForSelector('.ant-message-success', { timeout: 5000 });
const copied = await page2.evaluate(() => window.__copied ?? '');
if (copied.includes('# 极限的定义') && copied.includes('## 助手')) ok('execCommand 降级复制成功');
else fail(`execCommand 降级失败：${JSON.stringify(copied.slice(0, 200))}`);
await ctx2.close();

await browser.close();
if (process.exitCode) process.exit(process.exitCode);
console.log('\n全部通过');
