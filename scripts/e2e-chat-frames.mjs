/* eslint-disable no-console */
// E2E：字幕 → 问答 Agent → 画面引用（list_frames 工具 + [图@mm:ss] 标记 → AI 气泡渲染幻灯片缩略图）
// 帧数据直接向 IndexedDB 播种（跳过较慢的讲义流水线），agent 行为走真实 API
import { chromium } from 'playwright';

const API_KEY = process.env.SF_KEY;
const TEST_FILE = process.env.TEST_FILE;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
page.on('response', (r) => { if (r.status() >= 400) console.log('[HTTP', r.status() + ']', r.url().slice(0, 100)); });

await page.addInitScript((key) => {
  localStorage.setItem('wangke-settings', JSON.stringify({
    state: { apiKey: key, baseUrl: 'https://api.siliconflow.cn/v1', asrModel: 'XingChenAGI/XingChenASR-V3.2-Ultra', llmModel: 'deepseek-ai/DeepSeek-V4-Flash', visionModel: 'Qwen/Qwen3-VL-32B-Instruct' },
    version: 0,
  }));
}, API_KEY);

await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 15000 });
await page.click('[data-testid="btn-play"]');
await page.waitForSelector('video', { timeout: 15000 });

console.log('1. 生成字幕');
await page.click('[data-testid="subs-generate"]');
let deadline = Date.now() + 240000;
while (Date.now() < deadline) {
  await page.waitForTimeout(3000);
  const t = await page.locator('.side-pane').innerText();
  if (t.includes('进程') || t.includes('失败')) break;
}

console.log('2. 向 IndexedDB 播种两帧假幻灯片（带 caption）');
await page.evaluate(async () => {
  /**
   * ⚠️ 顺序不能改：**先造好 blob，再开事务**。
   *
   * IndexedDB 的事务在「控制权回到事件循环且没有未决请求」时会自动提交，
   * 而 `canvas.toBlob` 是**宏任务** —— 一旦在事务存活期间 `await` 它，
   * 事务当场提交，后面再碰 `tx.objectStore('frames')` 就会抛
   * 「The transaction has finished」，整个脚本在第 2 步崩掉。
   * （微任务级的 await 是安全的，比如等一个 IDB 请求的结果 —— 事务在事件处理期间仍然 active。）
   */
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2b6cb0'; ctx.fillRect(0, 0, 320, 180);
  ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif'; ctx.fillText('测试幻灯片', 20, 90);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));

  const req = indexedDB.open('wangke');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
  const videoId = await new Promise((res, rej) => {
    const q = db.transaction('videos').objectStore('videos').getAll();
    q.onsuccess = () => res(q.result[0].id); q.onerror = rej;
  });

  // 从这里到 tx.oncomplete 之间除了等事务自己，不能再有任何 await
  const tx = db.transaction('frames', 'readwrite');
  const frames = tx.objectStore('frames');
  frames.add({ videoId, ts: 30, blob, kind: 'slide', caption: '课程封面与学习目标' });
  frames.add({ videoId, ts: 250, blob, kind: 'slide', caption: '第二章标题页' });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  db.close();
});

console.log('3. 切到问答页，等待索引自动建立');
await page.click('[data-testid="panel-tab-chat"]');
deadline = Date.now() + 120000;
let indexOk = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(2000);
  const t = await page.locator('.side-pane').innerText();
  const placeholder = await page.locator('.side-pane textarea').getAttribute('placeholder').catch(() => null);
  if (placeholder && placeholder.includes('输入问题')) { indexOk = true; break; }
  if (t.includes('索引失败')) break;
}
console.log('  索引就绪:', indexOk);

let answered = false;
if (indexOk) {
  // 任何一步抛错（选择器超时等）都按失败处理，走末尾统一的 exit 3，而不是崩溃 exit 1
  try {
    // 记录提问前 assistant 消息数（IndexedDB 持久化是回答完成的确定性信号）
    const countAi = () => page.evaluate(async () => {
      const req = indexedDB.open('wangke');
      const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
      const tx = db.transaction('chats', 'readonly');
      const all = await new Promise((res, rej) => { const q = tx.objectStore('chats').getAll(); q.onsuccess = () => res(q.result); q.onerror = rej; });
      db.close();
      return all.filter((r) => r.role === 'assistant').length;
    });
    const aiBefore = await countAi();

    console.log('4. 提问：这门课幻灯片上讲了什么？');
    await page.fill('.side-pane textarea', '这门课的幻灯片画面上讲了什么？请查看课程画面清单，引用相关画面回答。');
    await page.press('.side-pane textarea', 'Enter');

    deadline = Date.now() + 180000;
    let sawStreaming = false;
    let lastLen = 0;
    let sawError = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      const t = await page.locator('.side-pane').innerText();
      if (t.length > lastLen + 5) { sawStreaming = true; lastLen = t.length; }
      if ((await countAi()) > aiBefore) { answered = true; break; }
      if (t.includes('回答失败')) { sawError = true; break; }
    }
    console.log('  观测到流式输出:', sawStreaming);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'e2e-shots/11-chat-frame-ref.png', fullPage: true });

    // AI 气泡（placement=start）里应出现画面缩略图，且回答文本不残留原始 [图@ 标记
    const aiImgCount = await page.locator('[data-testid="chat-msg-ai"] img').count();
    const answerText = await page.locator('.side-pane').innerText();
    const markerLeft = answerText.includes('[图@');
    console.log('  AI 气泡画面缩略图数:', aiImgCount);
    console.log('  回答片段:', answerText.replace(/\n/g, ' ').slice(0, 300));
    console.log('  残留 [图@ 标记:', markerLeft, ' 出现错误:', sawError);
    if (aiImgCount === 0 || markerLeft || sawError) answered = false;
  } catch (e) {
    console.log('  流程异常（按失败处理）:', String(e).slice(0, 300));
    answered = false;
  }
}

console.log(answered ? '✅ 画面引用 E2E 通过' : '⚠️ 画面引用未完成');
await browser.close();
process.exit(answered ? 0 : 3);
