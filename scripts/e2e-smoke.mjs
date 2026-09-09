/* eslint-disable no-console */
// 端到端冒烟测试：上传视频 → 生成字幕（真实调硅基流动 API）
import { chromium } from 'playwright';

const API_KEY = process.env.SF_KEY;
const TEST_FILE = process.env.TEST_FILE;
if (!API_KEY || !TEST_FILE) { console.error('需要 SF_KEY 和 TEST_FILE'); process.exit(1); }

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

console.log('1. 打开首页');
await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });

console.log('2. 上传测试视频');
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('.ant-list-item', { timeout: 15000 });

console.log('3. 进入播放页');
await page.click('button:has-text("学习")');
await page.waitForSelector('video', { timeout: 15000 });

console.log('4. 生成字幕');
await page.click('button:has-text("生成字幕")');

const deadline = Date.now() + 240000;
let sideText = '';
while (Date.now() < deadline) {
  await page.waitForTimeout(3000);
  sideText = await page.locator('.side-pane').innerText();
  if (sideText.includes('进程') || sideText.includes('失败') || sideText.includes('出错')) break;
}
await page.screenshot({ path: 'e2e-shots/5-subtitles.png', fullPage: true });

const cueLines = sideText.split('\n').filter((l) => /^\d+:\d{2}/.test(l.trim()));
console.log(`字幕条目数: ${cueLines.length}`);
console.log('侧栏内容片段:', sideText.replace(/\n/g, ' | ').slice(0, 300));
await browser.close();

if (cueLines.length >= 3 && sideText.includes('进程')) {
  console.log('✅ E2E 通过：字幕生成成功且内容正确');
  process.exit(0);
}
console.log('⚠️ 字幕不符合预期');
process.exit(3);
