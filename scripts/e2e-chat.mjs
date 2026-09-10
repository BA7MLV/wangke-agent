/* eslint-disable no-console */
// E2E：字幕 → 问答 Agent（embedding 索引 + agent loop + 流式回答 + 时间戳跳转）
import { chromium } from 'playwright';

const API_KEY = process.env.SF_KEY;
const TEST_FILE = process.env.TEST_FILE;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
page.on('response', (r) => { if (r.status() >= 400) console.log('[HTTP', r.status() + ']', r.url().slice(0, 100)); });

await page.addInitScript((key) => {
  localStorage.setItem('wangke-settings', JSON.stringify({
    state: { apiKey: key, baseUrl: 'https://api.siliconflow.cn/v1', asrModel: 'XingChenAGI/XingChenASR-V3.2-Ultra', llmModel: 'deepseek-ai/DeepSeek-V4-Flash', embedModel: 'Qwen/Qwen3-VL-Embedding-8B', visionModel: 'Qwen/Qwen3-VL-32B-Instruct' },
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

console.log('2. 切到问答页，等待索引自动建立');
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
await page.screenshot({ path: 'e2e-shots/7-chat-index.png', fullPage: true });

let answered = false;
if (indexOk) {
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

  console.log('3. 提问：这堂课讲了什么？');
  await page.fill('.side-pane textarea', '这堂课主要讲了什么内容？');
  await page.press('.side-pane textarea', 'Enter');

  deadline = Date.now() + 180000;
  let sawStreaming = false;
  let lastLen = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const t = await page.locator('.side-pane').innerText();
    if (t.length > lastLen + 5) { sawStreaming = true; lastLen = t.length; }
    if ((await countAi()) > aiBefore) { answered = true; break; }
    if (t.includes('回答失败')) break;
  }
  console.log('  观测到流式输出:', sawStreaming);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'e2e-shots/8-chat-answer.png', fullPage: true });

  const answerText = await page.locator('.side-pane').innerText();
  console.log('  回答片段:', answerText.replace(/\n/g, ' ').slice(0, 300));

  // 验证 markdown 渲染（回答中的加粗/列表应渲染为 HTML 元素而非纯文本）
  const mdInfo = await page.evaluate(() => {
    const pane = document.querySelector('.side-pane');
    return {
      strong: pane.querySelectorAll('strong').length,
      li: pane.querySelectorAll('li').length,
      rawStars: (pane.innerText.match(/\*\*/g) || []).length,
    };
  });
  console.log('  markdown 渲染: strong=%d, li=%d, 残留星号=%d', mdInfo.strong, mdInfo.li, mdInfo.rawStars);
  if (mdInfo.strong + mdInfo.li === 0 || mdInfo.rawStars > 0) answered = false;

  // 验证时间戳链接 + 点击跳转
  const tsLink = page.locator('.side-pane a', { hasText: /^\[\d{1,3}:\d{2}/ }).first();
  const hasTs = (await tsLink.count()) > 0;
  console.log('  回答含时间戳链接:', hasTs);
  if (hasTs) {
    await tsLink.click();
    await page.waitForTimeout(1000);
    const ct = await page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
    console.log('  点击后播放器 currentTime:', ct.toFixed(1), 's');
    if (ct < 0) answered = false;
  }
}

console.log(answered ? '✅ 问答 E2E 通过' : '⚠️ 问答未完成');
await browser.close();
process.exit(answered ? 0 : 3);
