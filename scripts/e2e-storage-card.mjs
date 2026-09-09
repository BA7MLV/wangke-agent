/* eslint-disable no-console */
// 存储占用卡片冒烟：设置页渲染 StorageCard，分类明细与配额行存在，console 错误收集
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

await page.goto('http://localhost:4173/#/settings', { waitUntil: 'networkidle' });
await page.waitForSelector('.ant-card:has-text("存储占用")', { timeout: 10000 });
console.log('1. 存储占用卡片渲染 OK');

const info = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.ant-card')].find((c) => c.textContent.includes('存储占用'));
  if (!card) return null;
  return {
    progress: card.querySelector('.ant-progress')?.textContent ?? '',
    tag: card.querySelector('.ant-tag')?.textContent ?? '',
    rows: [...card.querySelectorAll('.ant-list-item')].map((li) => li.textContent),
    note: card.querySelector('.ant-typography')?.textContent?.slice(0, 60) ?? '',
  };
});
console.log('2. 内容:', JSON.stringify(info, null, 2));

const labels = ['视频文件', '抽帧图片', '字幕与向量', '讲义文档', '浏览器存储开销'];
const missing = labels.filter((l) => !info || !info.rows.some((r) => r.includes(l)));
if (missing.length) {
  console.log(`   ✗ 缺少分类行: ${missing.join('、')}`);
  process.exitCode = 1;
} else console.log('3. ✓ 五个分类行齐全');

if (!info || !info.progress.includes('已用')) {
  console.log('   ✗ 配额进度条异常');
  process.exitCode = 1;
} else console.log('4. ✓ 配额进度条 OK');

console.log(errors.length ? `[console errors]\n${errors.join('\n')}` : '无 console/page 错误');
await browser.close();
