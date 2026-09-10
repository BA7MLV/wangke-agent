/* eslint-disable no-console */
// 调试：左滑手势事件流
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4488';
const VIDEO_ID = 'e2e-hd-edit-vid';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
const page = await ctx.newPage();
page.on('console', (m) => console.log('[page]', m.text()));

// 播种（与 e2e-handout-edit.mjs 相同的最小数据集）
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15000 });
await page.evaluate(async (videoId) => {
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open('wangke');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  canvas.getContext('2d').fillRect(0, 0, 640, 360);
  const frameBlob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
  const tx = db.transaction(['videos', 'segments', 'frames', 'handouts'], 'readwrite');
  tx.objectStore('videos').put({
    id: videoId,
    name: '微积分第一课.mp4',
    size: 1,
    mimeType: 'video/mp4',
    duration: 600,
    createdAt: Date.now(),
    status: 'transcribed',
  });
  tx.objectStore('segments').add({ videoId, idx: 0, start: 0, end: 5, text: '字幕', status: 1 });
  tx.objectStore('frames').add({ videoId, ts: 10, blob: frameBlob, kind: 'slide', caption: '图' });
  tx.objectStore('handouts').add({
    videoId,
    createdAt: Date.now(),
    title: '微积分极限学习讲义',
    blob: new Blob(['placeholder']),
    outlineJson: JSON.stringify({ title: '微积分极限学习讲义', summary: '概述。', sections: [] }),
    sectionsJson: JSON.stringify([
      {
        heading: '极限的概念',
        blocks: [
          { type: 'para', text: '极限是描述函数在某点附近变化趋势的工具。' },
          { type: 'note', text: '注意区分左极限与右极限。' },
        ],
      },
    ]),
  });
  await new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}, VIDEO_ID);

await page.goto(`${BASE}/#/player/${VIDEO_ID}`, { waitUntil: 'networkidle' });
await page.click('[data-testid="panel-tab-handout"]');
await page.waitForSelector('.hd-doc', { timeout: 10000 });

// 在目标元素上监听触摸事件
await page.evaluate(() => {
  const el = [...document.querySelectorAll('.hd-swipe-content')].find((e) =>
    e.textContent.includes('注意区分左极限与右极限'),
  );
  if (!el) {
    console.log('目标元素不存在');
    return;
  }
  for (const ev of ['touchstart', 'touchmove', 'touchend', 'click']) {
    el.addEventListener(ev, (e) => {
      const t = e.touches?.[0] ?? e.changedTouches?.[0];
      console.log(`${ev} x=${t ? Math.round(t.clientX) : '-'} y=${t ? Math.round(t.clientY) : '-'} touches=${e.touches?.length ?? '-'} changed=${e.changedTouches?.length ?? '-'}`);
    });
  }
  console.log('监听器已挂');
});

const target = page.locator('.hd-swipe-content', { hasText: '注意区分左极限与右极限' });
const box = await target.boundingBox();
console.log('box', box);
const cdp = await ctx.newCDPSession(page);
const y = box.y + box.height / 2;
const startX = box.x + box.width - 20;
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y, id: 1 }] });
for (const dx of [30, 60, 100, 160]) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX - dx, y, id: 1 }] });
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(500);
console.log('transform =', await target.evaluate((el) => el.style.transform || '(empty)'));
await browser.close();
