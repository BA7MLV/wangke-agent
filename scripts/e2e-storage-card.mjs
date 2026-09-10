/* eslint-disable no-console */
// 存储占用卡片冒烟：设置页渲染 StorageCard，配额 / 持久化 / 五个分类明细齐全，console 错误收集
//
// 全部按 data-testid 定位（mdui 是 Web Components，内部结构在 shadow DOM 里，类名/DOM 层级都不稳定）。
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="card-storage"] [data-testid="storage-row"]', { timeout: 10000 });
console.log('1. 存储占用卡片渲染 OK');

const info = await page.evaluate(() => {
  const card = document.querySelector('[data-testid="card-storage"]');
  if (!card) return null;
  const text = (sel) => card.querySelector(sel)?.textContent?.trim() ?? '';
  const progress = card.querySelector('[data-testid="storage-progress"]');
  return {
    progressValue: progress ? progress.value : null,
    progressText: text('.storage-progress-text'),
    persist: text('[data-testid="storage-persist-tag"]'),
    rows: [...card.querySelectorAll('[data-testid="storage-row"]')].map((li) => li.textContent.trim()),
    note: text('[data-testid="storage-note"]').slice(0, 40),
  };
});
console.log('2. 内容:', JSON.stringify(info, null, 2));

// 五个分类行齐全
const labels = ['视频文件', '抽帧图片', '字幕与向量', '讲义文档', '浏览器存储开销'];
const missing = labels.filter((l) => !info || !info.rows.some((r) => r.includes(l)));
if (missing.length) {
  console.log(`   ✗ 缺少分类行: ${missing.join('、')}`);
  process.exitCode = 1;
} else console.log('3. ✓ 五个分类行齐全');

// 回归断言（2026-09-10）：分类名曾经整列不渲染 —— mdui-list-item 没有 `slot="headline"`
// 这个命名插槽（官方 JSX 注释里却写着有），内容会被静默丢弃。这里显式守住「标签真的在」。
const labelOnly = info ? info.rows.every((r) => /[\u4e00-\u9fa5]/.test(r)) : false;
if (!labelOnly) {
  console.log('   ✗ 分类行缺少中文标签（可能又把标题写进了不存在的插槽）');
  process.exitCode = 1;
} else console.log('4. ✓ 每个分类行都带标签文本');

// 每行还应有体积数字（end-icon 插槽）
const hasSize = info ? info.rows.every((r) => /\d/.test(r)) : false;
if (!hasSize) {
  console.log('   ✗ 分类行缺少体积数字');
  process.exitCode = 1;
} else console.log('5. ✓ 每个分类行都带体积');

if (!info || !info.progressText.includes('已用')) {
  console.log('   ✗ 配额说明异常');
  process.exitCode = 1;
} else console.log('6. ✓ 配额说明 OK');

if (!info || !info.persist) {
  console.log('   ✗ 持久化状态 chip 缺失');
  process.exitCode = 1;
} else console.log(`7. ✓ 持久化状态：${info.persist}`);

console.log(errors.length ? `[console errors]\n${errors.join('\n')}` : '无 console/page 错误');
await browser.close();
