/* eslint-disable no-console */
// 断点续播链路：导入视频 → 播放页 seek 到 10s 并播放几秒 → IndexedDB 落盘 lastPosition
// → 刷新页面 → 播放器自动恢复到上次位置（播完归零逻辑由 ended 回调保证，不在本脚本覆盖）
// 用法：TEST_FILE=/path/to/video.mp4 node scripts/e2e-resume.mjs（需先 npm run preview）
import { chromium } from 'playwright';

const TEST_FILE = process.env.TEST_FILE;
if (!TEST_FILE) { console.error('需要 TEST_FILE'); process.exit(1); }

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));

const fail = (msg) => { console.error(`❌ ${msg}`); process.exitCode = 1; };

const readLastPosition = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open('wangke');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return new Promise((res, rej) => {
    const tx = db.transaction('videos', 'readonly');
    const req = tx.objectStore('videos').getAll();
    req.onsuccess = () => res(req.result[0]?.lastPosition ?? null);
    req.onerror = () => rej(req.error);
  });
});

console.log('1. 打开首页并导入测试视频');
await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('.ant-list-item', { timeout: 30000 });

console.log('2. 进入播放页，等待视频就绪');
await page.click('button:has-text("学习")');
await page.waitForSelector('video', { timeout: 15000 });
await page.waitForFunction(
  () => { const v = document.querySelector('video'); return v && v.readyState >= 2 && v.duration > 0; },
  { timeout: 15000 },
);

console.log('3. seek 到 10s，静音播放约 4 秒（触发进度落盘）');
await page.evaluate(() => {
  const v = document.querySelector('video');
  v.muted = true;
  v.currentTime = 10;
  return v.play();
});
await page.waitForTimeout(4000);
await page.evaluate(() => document.querySelector('video').pause());

console.log('4. 轮询 IndexedDB，确认 lastPosition 已保存');
let saved = null;
for (let i = 0; i < 20; i++) {
  saved = await readLastPosition();
  if (typeof saved === 'number' && saved >= 9) break;
  await page.waitForTimeout(500);
}
console.log('   lastPosition =', saved);
if (!(typeof saved === 'number' && saved >= 9)) fail(`进度未保存到 IndexedDB（lastPosition=${saved}）`);

console.log('5. 刷新页面，确认自动恢复到上次位置');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('video', { timeout: 15000 });
const restored = await page.waitForFunction(
  () => { const v = document.querySelector('video'); return v && v.readyState >= 2 && v.currentTime >= 8; },
  { timeout: 15000 },
).then(() => true).catch(() => false);
const currentTime = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
console.log('   刷新后 currentTime =', currentTime.toFixed(1), 's');
if (!restored) fail(`刷新后未恢复进度（currentTime=${currentTime}）`);

await browser.close();
if (process.exitCode) { console.error('❌ 断点续播 e2e 失败'); } else { console.log('✅ 断点续播 e2e 通过'); }
