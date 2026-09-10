/* eslint-disable no-console */
// 导入性能分段计时：选择文件 → 进度条出现(probe完成) → 导入完成(写入完成)
import { chromium } from 'playwright';
const TEST_FILE = process.env.TEST_FILE;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });

const t0 = Date.now();
await page.setInputFiles('input[type="file"]', TEST_FILE);
const t1 = Date.now();
await page.waitForSelector('[data-testid="import-progress"]', { timeout: 60000 });
const t2 = Date.now();
await page.waitForSelector('[data-testid="video-item"]', { timeout: 300000 });
const t3 = Date.now();

const size = await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('videos');
  for await (const name of dir.keys()) {
    const h = await dir.getFileHandle(name);
    return (await h.getFile()).size;
  }
  return 0;
});

console.log(`setInputFiles 耗时:     ${((t1 - t0) / 1000).toFixed(1)}s`);
console.log(`选择→开始写入(probe):  ${((t2 - t1) / 1000).toFixed(1)}s`);
console.log(`OPFS 写入:             ${((t3 - t2) / 1000).toFixed(1)}s  (${(size / 1024 / 1024 / ((t3 - t2) / 1000)).toFixed(0)} MB/s)`);
console.log(`总计:                  ${((t3 - t0) / 1000).toFixed(1)}s · 文件 ${(size / 1024 / 1024).toFixed(0)}MB`);
await browser.close();
