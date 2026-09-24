import { chromium } from 'playwright';

const API_KEY = process.env.SF_KEY;
const TEST_FILE = process.env.TEST_FILE;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 600)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
page.on('response', (res) => { if (res.status() >= 400) console.log('[HTTP', res.status() + ']', res.url().slice(0, 120)); });

await page.addInitScript((key) => {
  localStorage.setItem('wangke-settings', JSON.stringify({
    state: { apiKey: key, baseUrl: 'https://api.siliconflow.cn/v1', asrModel: 'XingChenAGI/XingChenASR-V3.2-Ultra', llmModel: 'deepseek-ai/DeepSeek-V4-Flash', visionModel: 'Qwen/Qwen3-VL-32B-Instruct' },
    version: 0,
  }));
}, API_KEY);

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 15000 });
await page.click('[data-testid="btn-play"]');
await page.waitForSelector('video', { timeout: 15000 });
console.log('player ready, clicking 生成字幕');
await page.click('[data-testid="subs-generate"]');

for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(5000);
  const txt = await page.locator('.side-pane').innerText().catch(() => '(none)');
  console.log(`[t=${(i + 1) * 5}s]`, txt.replace(/\n/g, ' | ').slice(0, 200));
  if (txt.includes('进程') || txt.includes('失败')) break;
}
await page.screenshot({ path: 'e2e-shots/debug-transcribe.png', fullPage: true });
await browser.close();
