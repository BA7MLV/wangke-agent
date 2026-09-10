/* eslint-disable no-console */
// 导入链路冒烟：导入视频 → 进度条出现 → 文件落在 OPFS → 播放页可播 → 删除后 OPFS 清空
// 用法：TEST_FILE=/path/to/video.mp4 node scripts/e2e-import.mjs（需先 npm run preview）
import { chromium } from 'playwright';

const TEST_FILE = process.env.TEST_FILE;
if (!TEST_FILE) { console.error('需要 TEST_FILE'); process.exit(1); }

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));

const fail = (msg, code = 1) => { console.error(`❌ ${msg}`); process.exitCode = code; };

console.log('1. 打开首页');
await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });

console.log('2. 导入测试视频');
await page.setInputFiles('input[type="file"]', TEST_FILE);

// 进度 UI 应出现（写入本地存储 / 完成）
await page.waitForSelector('[data-testid="import-progress"]', { timeout: 10000 });
console.log('   进度条已出现');
await page.waitForSelector('[data-testid="video-item"]', { timeout: 30000 });
const itemText = await page.locator('[data-testid="video-item"]').first().innerText();
console.log('   列表项:', itemText.replace(/\n/g, ' | ').slice(0, 120));
if (!/0:0[01]:|0:12/.test(itemText)) console.log('   ⚠️ 时长显示异常（mediabunny probe 可能返回 0）:', itemText.slice(0, 80));

console.log('3. 校验 OPFS 中有文件、IndexedDB files 表无新增');
const opfsCheck = await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('videos');
  const names = [];
  for await (const name of dir.keys()) names.push(name);
  const idb = await new Promise((resolve) => {
    const req = indexedDB.open('wangke');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('files', 'readonly');
      const countReq = tx.objectStore('files').count();
      countReq.onsuccess = () => resolve(countReq.result);
    };
  });
  return { opfsNames: names, idbFileCount: idb };
});
console.log('   OPFS videos/:', opfsCheck.opfsNames, '· IndexedDB files 行数:', opfsCheck.idbFileCount);
if (opfsCheck.opfsNames.length !== 1) fail('OPFS 应有 1 个视频文件');
if (opfsCheck.idbFileCount !== 0) fail('IndexedDB files 表应为空（视频应只存 OPFS）');

console.log('4. 进入播放页，确认视频可加载');
await page.click('[data-testid="btn-play"]');
await page.waitForSelector('video', { timeout: 15000 });
const playable = await page.waitForFunction(
  () => { const v = document.querySelector('video'); return v && v.readyState >= 2 && v.duration > 0; },
  { timeout: 15000 },
).then(() => true).catch(() => false);
const duration = await page.evaluate(() => document.querySelector('video')?.duration ?? 0);
console.log('   视频 readyState≥2:', playable, '· 时长:', duration.toFixed(1), 's');
if (!playable) fail('视频未能加载到可播放状态');

console.log('5. 返回删除，确认 OPFS 清空');
await page.goBack({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="video-item"]', { timeout: 10000 });
await page.click('[data-testid="video-item"] [data-testid="btn-delete"]');
const confirmDlg = page.locator('mdui-dialog:has([data-testid="confirm-dialog-danger"])');
await confirmDlg.waitFor({ state: 'attached', timeout: 5000 });
await confirmDlg.locator('mdui-button[slot="action"]').last().click();
await page.waitForTimeout(1500);
const afterDelete = await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('videos');
  const names = [];
  for await (const name of dir.keys()) names.push(name);
  return names;
});
console.log('   删除后 OPFS videos/:', afterDelete);
if (afterDelete.length !== 0) fail('删除后 OPFS 应无残留文件');

await browser.close();
if (process.exitCode) process.exit(process.exitCode);
console.log('✅ 导入链路冒烟通过：OPFS 写入 / 播放 / 删除清理全部正常');
