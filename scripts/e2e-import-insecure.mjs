/* eslint-disable no-console */
// 非安全上下文回归：iPad 经局域网 http://IP 访问时 crypto.randomUUID 为 undefined。
// 用 init script 把它抹掉模拟该环境，验证导入链路仍可用（uuid 降级）。
// 用法：TEST_FILE=/path/to/video.mp4 node scripts/e2e-import-insecure.mjs（需先 npm run preview）
import { chromium } from 'playwright';

const TEST_FILE = process.env.TEST_FILE;
if (!TEST_FILE) { console.error('需要 TEST_FILE'); process.exit(1); }

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));

// 模拟非安全上下文：randomUUID 不存在（getRandomValues 仍在）
await page.addInitScript(() => {
  Object.defineProperty(window.crypto, 'randomUUID', { value: undefined, configurable: true });
});

await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
const stubbed = await page.evaluate(() => typeof crypto.randomUUID);
console.log('1. randomUUID 已抹除:', stubbed === 'undefined');

await page.setInputFiles('input[type="file"]', TEST_FILE);
try {
  await page.waitForSelector('[data-testid="video-item"]', { timeout: 30000 });
  const t = await page.locator('[data-testid="video-item"]').first().innerText();
  console.log('✅ 非安全上下文模拟下导入成功:', t.replace(/\n/g, ' | ').slice(0, 100));
} catch {
  const body = await page.locator('body').innerText();
  console.error('❌ 导入仍失败:', body.replace(/\n/g, ' | ').slice(0, 300));
  process.exitCode = 1;
}
await browser.close();
if (process.exitCode) process.exit(process.exitCode);
