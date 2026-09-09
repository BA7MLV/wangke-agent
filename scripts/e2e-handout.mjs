/* eslint-disable no-console */
// E2E：字幕 → 讲义生成（真实 API）
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
await page.waitForSelector('.ant-list-item', { timeout: 15000 });
await page.click('button:has-text("学习")');
await page.waitForSelector('video', { timeout: 15000 });

console.log('1. 生成字幕');
await page.click('button:has-text("生成字幕")');
let deadline = Date.now() + 240000;
while (Date.now() < deadline) {
  await page.waitForTimeout(3000);
  const t = await page.locator('.side-pane').innerText();
  if (t.includes('进程') || t.includes('失败')) break;
}

console.log('2. 切到讲义页，生成讲义');
await page.click('.ant-tabs-tab:has-text("讲义")');
await page.click('button:has-text("生成讲义")');
deadline = Date.now() + 300000;
let done = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(5000);
  const t = await page.locator('.side-pane').innerText();
  const short = t.replace(/\n/g, ' | ').slice(0, 150);
  console.log('  …', short);
  if (t.includes('下载 DOCX')) { done = true; break; }
  if (t.includes('失败')) break;
}
await page.screenshot({ path: 'e2e-shots/6-handout.png', fullPage: true });

if (done) {
  // 验证 DOCX 内容：从 IndexedDB 拿出来检查
  const info = await page.evaluate(async () => {
    const req = indexedDB.open('wangke');
    const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
    const tx = db.transaction('handouts', 'readonly');
    const store = tx.objectStore('handouts');
    const all = await new Promise((res, rej) => { const q = store.getAll(); q.onsuccess = () => res(q.result); q.onerror = rej; });
    const h = all[all.length - 1];
    return { title: h.title, size: h.blob.size, outline: h.outlineJson.slice(0, 400) };
  });
  console.log('讲义标题:', info.title);
  console.log('DOCX 大小:', (info.size / 1024).toFixed(1), 'KB');
  console.log('大纲:', info.outline);
  console.log('✅ 讲义 E2E 通过');
} else {
  console.log('⚠️ 讲义生成未完成');
}
await browser.close();
process.exit(done ? 0 : 3);
