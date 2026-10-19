// README screenshots: isolated browser context, synthetic study data, no model API calls.
// Usage: npm run dev, then node scripts/shot-readme.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
const output = new URL('../docs/images/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  reducedMotion: 'reduce',
  locale: 'zh-CN',
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
// These screenshots only exercise local import/rendering; never contact a model provider.
await context.route('**/*', (route) => {
  const url = new URL(route.request().url());
  return url.origin === new URL(base).origin || !/^https?:$/.test(url.protocol)
    ? route.continue()
    : route.abort();
});

try {
  await page.goto(`${base}/#/library`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="import-input"]');
  const notes = [
    ['线性代数 · 特征值与特征向量', '# 线性代数\n\n从矩阵变换理解特征值与特征向量。\n\n## 学习目标\n\n掌握特征方程，理解相似对角化的条件。'],
    ['概率论 · 随机变量与分布', '# 概率论\n\n用随机变量描述不确定性，用分布连接理论与现实。\n\n## 复习重点\n\n分布函数、数学期望与方差。'],
    ['计算机网络 · 分层模型', '# 计算机网络\n\n从应用层到链路层，梳理一次请求经过的完整路径。\n\n## 知识框架\n\n协议分层、可靠传输与拥塞控制。'],
    ['学习笔记 · 检索与复习', '# 学习方法\n\n将课程内容转化为自己的知识结构。\n\n## 复习计划\n\n主动回忆，间隔复习，用问题检验理解。'],
  ];
  await page.locator('[data-testid="import-input"]').setInputFiles(notes.map(([name, text]) => ({
    name: `${name}.md`, mimeType: 'text/markdown', buffer: Buffer.from(text),
  })));
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('[data-testid="video-item"]')];
    return cards.length === 4 && cards.every((card) =>
      card.querySelector('[data-testid="video-thumb"] img')?.naturalWidth > 0);
  }, undefined, { timeout: 60000 });
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('wangke');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = database.transaction('studyDays', 'readwrite');
    for (let offset = 0; offset < 365; offset++) {
      if (offset > 6 && offset % 7 < 2) continue;
      const date = new Date();
      date.setDate(date.getDate() - offset);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      tx.objectStore('studyDays').put({
        date: key, seconds: (20 + ((offset * 37) % 110)) * 60, updatedAt: Date.now(),
      });
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  });
  // Reload after import so transient success toasts are not part of the documentation.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('[data-testid="video-item"]')];
    return cards.length === 4 && cards.every((card) =>
      card.querySelector('[data-testid="video-thumb"] img')?.naturalWidth > 0);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: new URL('library.png', output).pathname, animations: 'disabled' });
  await page.goto(`${base}/#/study`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="heat-cells"]');
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-testid="heat-cell"][data-level="4"]').length > 0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: new URL('study.png', output).pathname, animations: 'disabled' });
  assert.deepEqual(errors, [], 'Screenshots must render without uncaught page errors');
  console.log('Updated docs/images/library.png and docs/images/study.png (1440 × 1000).');
} finally {
  await browser.close();
}
