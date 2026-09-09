/* eslint-disable no-console */
// 动效冒烟：设置页 error-shake + success-check DOM 钩子，库页渲染，console 错误收集
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

await page.goto('http://localhost:4173/#/settings', { waitUntil: 'networkidle' });
await page.waitForSelector('input[type="password"]', { timeout: 10000 });
console.log('1. 设置页打开 OK');

// 空 API Key 点检查 → 应触发 .is-shaking + .is-error + 错误消息可见
await page.click('button:has-text("检查模型可用性")');
await page.waitForTimeout(120);
const shakeState = await page.evaluate(() => ({
  shaking: !!document.querySelector('.t-input.is-shaking'),
  wrapError: !!document.querySelector('.t-input-wrap.is-error'),
  msgVisible: getComputedStyle(document.querySelector('.t-error-msg')).visibility,
}));
console.log('2. error-shake 钩子:', JSON.stringify(shakeState));
if (!shakeState.shaking || !shakeState.wrapError || shakeState.msgVisible !== 'visible') {
  console.log('   ✗ shake 钩子未生效'); process.exitCode = 1;
} else console.log('   ✓ shake + 红边 + 消息生效');

// 等自动回退
await page.waitForTimeout(3600);
const reverted = await page.evaluate(() => !document.querySelector('.t-input-wrap.is-error'));
console.log(reverted ? '3. ✓ 错误态自动回退' : '3. ✗ 未自动回退');
if (!reverted) process.exitCode = 1;

// 首页渲染
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForSelector('.ant-upload-wrapper', { timeout: 10000 });
console.log('4. 首页渲染 OK');

// motion token 已注入（构建压缩会把 150ms 改写成 .15s，两种都算注入成功）
const token = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--duration-quick').trim());
const tokenOk = token === '150ms' || token === '.15s';
console.log(tokenOk ? '5. ✓ motion tokens 已注入' : `5. ✗ token 异常: "${token}"`);
if (!tokenOk) process.exitCode = 1;

console.log(errors.length ? `[console errors]\n${errors.join('\n')}` : '无 console/page 错误');
await browser.close();
