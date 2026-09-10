/* eslint-disable no-console */
// 动效冒烟：设置页 error-shake + 错误态回退（红框走设计令牌）+ 首页渲染 + motion token 注入，console 错误收集
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
// API Key 从 antd Input 换成了 mdui-text-field：真实的 <input> 在 shadow DOM 里，
// 外面只能定位到宿主元素，所以等宿主（页面就绪的信号也随之改为「宿主出现」）
await page.waitForSelector('[data-testid="api-key"]', { timeout: 10000 });
console.log('1. 设置页打开 OK');

// 空 API Key 点检查 → 应触发 .is-shaking + .is-error + 错误消息可见
// （t-input / t-input-wrap / t-error-msg 是 transitions.css 约定的动效钩子，与用哪套 UI 库无关）
await page.click('[data-testid="btn-check-models"]');
await page.waitForTimeout(120);
const shakeState = await page.evaluate(() => ({
  shaking: !!document.querySelector('.t-input.is-shaking'),
  wrapError: !!document.querySelector('.t-input-wrap.is-error'),
  msgVisible: getComputedStyle(document.querySelector('.t-error-msg')).visibility,
}));
console.log('2. error-shake 钩子:', JSON.stringify(shakeState));
if (!shakeState.shaking || !shakeState.wrapError || shakeState.msgVisible !== 'visible') {
  console.log('   ✗ shake 钩子未生效');
  process.exitCode = 1;
} else console.log('   ✓ shake + 红边 + 消息生效');

// 错误态的红框：mdui 的边框颜色取自设计令牌，这里确认令牌真的被换成了 error 色
// （原来这个红框由 antd Input 的 status="error" 提供，迁移后必须由我们自己的 CSS 提供）
const errToken = await page.evaluate(() => {
  const wrap = document.querySelector('.t-input.is-error');
  if (!wrap) return null;
  const cs = getComputedStyle(wrap);
  return {
    primary: cs.getPropertyValue('--mdui-color-primary').trim(),
    error: cs.getPropertyValue('--mdui-color-error').trim(),
  };
});
if (!errToken || !errToken.primary || errToken.primary !== errToken.error) {
  console.log(`   ✗ 错误态未把强调色换成 error 色: ${JSON.stringify(errToken)}`);
  process.exitCode = 1;
} else console.log('   ✓ 错误态已改用 error 令牌描边');

// 等自动回退
await page.waitForTimeout(3600);
const reverted = await page.evaluate(() => !document.querySelector('.t-input-wrap.is-error'));
console.log(reverted ? '3. ✓ 错误态自动回退' : '3. ✗ 未自动回退');
if (!reverted) process.exitCode = 1;

// 首页（已迁移到 mdui）渲染
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="drop-zone"]', { timeout: 10000 });
console.log('4. 首页渲染 OK');

// motion token 已注入（构建压缩会把 150ms 改写成 .15s，两种都算注入成功）
const token = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--duration-quick').trim());
const tokenOk = token === '150ms' || token === '.15s';
console.log(tokenOk ? '5. ✓ motion tokens 已注入' : `5. ✗ token 异常: "${token}"`);
if (!tokenOk) process.exitCode = 1;

console.log(errors.length ? `[console errors]\n${errors.join('\n')}` : '无 console/page 错误');
await browser.close();
