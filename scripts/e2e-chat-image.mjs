/* eslint-disable no-console */
// E2E：字幕 → 问答 Agent → 截图提问（截图 chip + 时间戳角标 + 降级链自动解析 + 流式回答）
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

let answered = false;
if (indexOk) {
  // 任何一步抛错（选择器超时等）都按失败处理，走末尾统一的 exit 3，而不是崩溃 exit 1
  try {
    console.log('3. seek 视频并暂停，等待画面就绪');
    const seekedTo = await page.evaluate(() => new Promise((res) => {
      const v = document.querySelector('video');
      if (!v) return res(-1);
      const target = v.duration ? Math.min(60, v.duration * 0.1) : 60;
      v.addEventListener('seeked', () => res(v.currentTime), { once: true });
      v.currentTime = target;
      v.pause();
      setTimeout(() => res(v.currentTime), 8000);
    }));
    console.log('  currentTime:', Number(seekedTo).toFixed(1), 's');
    await page.waitForTimeout(1000);

    console.log('4. 点击截图按钮');
    await page.click('[data-testid="shot-btn"]');
    // Sender 的 header 内容直接渲染、无包装 class（ant-sender-header 仅属于 opt-in 的 Sender.Header
    // 子组件，ChatPanel 未使用）；[data-testid="chat-composer"] 内只有 chip 是 img（prefix/提交按钮均为 svg 图标）
    await page.waitForSelector('[data-testid="chat-composer"] img', { timeout: 5000 });
    // 角标与 img 同在 chip 容器 span 内，取父节点文本校验
    const chipBadge = await page.locator('[data-testid="chat-composer"] img').first().locator('..').innerText();
    const chipOk = /\d{1,3}:\d{2}/.test(chipBadge);
    console.log('  截图 chip 已出现，时间戳角标:', chipOk ? chipBadge.trim() : '缺失');
    await page.screenshot({ path: 'e2e-shots/9-chat-shot-chip.png', fullPage: true });

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

    console.log('5. 提问：这张画面讲了什么？');
    await page.fill('.side-pane textarea', '这张画面讲了什么？');
    await page.press('.side-pane textarea', 'Enter');

    // 用户气泡应带截图缩略图
    await page.waitForSelector('[data-testid="chat-msg-user"] img', { timeout: 10000 }).catch(() => null);
    const userImgCount = await page.locator('[data-testid="chat-msg-user"] img').count();
    console.log('  用户气泡缩略图数:', userImgCount);

    deadline = Date.now() + 180000;
    let sawStreaming = false;
    let lastLen = 0;
    let sawError = false;
    while (Date.now() < deadline) {
      // 1s 轮询：tier-3 错误 toast 约 3s 自动消失，2s 间隔可能漏检
      await page.waitForTimeout(1000);
      const t = await page.locator('.side-pane').innerText();
      if (t.length > lastLen + 5) { sawStreaming = true; lastLen = t.length; }
      if ((await countAi()) > aiBefore) { answered = true; break; }
      const body = await page.locator('body').innerText();
      if (t.includes('回答失败') || body.includes('当前模型不支持图片')) { sawError = true; break; }
    }
    console.log('  观测到流式输出:', sawStreaming);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'e2e-shots/10-chat-shot-answer.png', fullPage: true });

    const answerText = await page.locator('.side-pane').innerText();
    console.log('  回答片段:', answerText.replace(/\n/g, ' ').slice(0, 300));
    console.log('  出现错误:', sawError);
    if (!chipOk || userImgCount === 0 || sawError) answered = false;
  } catch (e) {
    console.log('  流程异常（按失败处理）:', String(e).slice(0, 300));
    answered = false;
  }
}

console.log(answered ? '✅ 截图提问 E2E 通过' : '⚠️ 截图提问未完成');
await browser.close();
process.exit(answered ? 0 : 3);
