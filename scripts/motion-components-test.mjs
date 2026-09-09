/* eslint-disable no-console */
// 动效组件渲染验证：TextSwap / ThinkLine / StreamParagraph / SuccessCheck
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

await page.goto('http://localhost:4173/#/motion-test', { waitUntil: 'networkidle' });
await page.waitForSelector('.t-text-swap', { timeout: 10000 });

// 初始态
const init = await page.evaluate(() => ({
  swapText: document.querySelector('.t-text-swap')?.textContent,
  thinkLines: document.querySelectorAll('.t-think-text').length,
  thinkSizer: !!document.querySelector('.t-think-sizer'),
  streamWords: document.querySelectorAll('.t-stream-w').length,
  streamIn: document.querySelectorAll('.t-stream-w.is-in').length,
  checkState: document.querySelector('.t-success-check')?.getAttribute('data-state'),
  dasharray: document.querySelector('.t-success-check svg path')?.style.strokeDasharray,
}));
console.log('初始:', JSON.stringify(init));

// 等 swap / think / stream 触发
await page.waitForTimeout(1600);
const after = await page.evaluate(() => ({
  swapText: document.querySelector('.t-text-swap')?.textContent,
  thinkText: document.querySelector('.t-think-text:not(.is-exit)')?.textContent,
  thinkDataText: document.querySelector('.t-think-text:not(.is-exit)')?.getAttribute('data-text'),
  streamWords: document.querySelectorAll('.t-stream-w').length,
  streamIn: document.querySelectorAll('.t-stream-w.is-in').length,
  checkOpacity: getComputedStyle(document.querySelector('.t-success-check')).opacity,
}));
console.log('1.6s 后:', JSON.stringify(after));

let fail = 0;
const assert = (ok, label) => { console.log((ok ? '✓ ' : '✗ ') + label); if (!ok) fail = 1; };

assert(init.swapText === '抽取音频中…', 'TextSwap 初始文案');
assert(after.swapText === '转写 3/40…', 'TextSwap 交换后文案');
assert(init.thinkSizer, 'ThinkLine sizer 存在');
assert(after.thinkText === '正在检索：牛顿第一定律', 'ThinkLine 状态已交换');
assert(after.thinkDataText === after.thinkText, 'ThinkLine data-text 与文案同步');
assert(after.streamWords === 7, `StreamParagraph 词数（期望 7，实际 ${after.streamWords}）`);
assert(after.streamIn === 7, 'StreamParagraph 全部词已 is-in');
assert(init.checkState === 'in', 'SuccessCheck data-state=in');
assert(!!init.dasharray && init.dasharray !== '20', `SuccessCheck dasharray 已校准（${init.dasharray}）`);
assert(after.checkOpacity === '1', 'SuccessCheck 动画结束 opacity=1');

console.log(errors.length ? `[console errors]\n${errors.join('\n')}` : '无 console/page 错误');
await browser.close();
process.exitCode = fail || (errors.length ? 1 : 0);
