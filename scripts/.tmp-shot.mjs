/* eslint-disable no-console */
// 临时：截讲义视图 + 滑动展开状态
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4488';
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function seed(page) {
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
    const c = canvas.getContext('2d');
    c.fillStyle = '#2b5cab';
    c.fillRect(0, 0, 640, 360);
    c.fillStyle = '#fff';
    c.font = '32px sans-serif';
    c.fillText('极限的几何意义', 40, 180);
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
    tx.objectStore('frames').add({ videoId, ts: 10, blob: frameBlob, kind: 'slide', caption: '极限的几何意义' });
    tx.objectStore('handouts').add({
      videoId,
      createdAt: Date.now(),
      title: '微积分极限学习讲义',
      blob: new Blob(['placeholder']),
      outlineJson: JSON.stringify({ title: '微积分极限学习讲义', summary: '本课程讲授极限的定义、几何意义与运算法则。', sections: [] }),
      sectionsJson: JSON.stringify([
        {
          heading: '极限的概念',
          blocks: [
            { type: 'lead', text: '本节介绍极限的定义与几何意义。' },
            { type: 'para', text: '极限是描述函数在某点附近变化趋势的工具。' },
            { type: 'h2', text: '极限的定义' },
            { type: 'list', ordered: true, items: ['给定任意小的正数', '存在对应的邻域', '函数值落入该邻域'] },
            { type: 'table', caption: '符号对照', header: ['符号', '含义'], rows: [['ε', '任意小正数'], ['δ', '对应邻域半径']] },
            { type: 'figure', ts: 10, caption: '极限的几何意义' },
            { type: 'note', text: '注意区分左极限与右极限。' },
          ],
        },
        { heading: '极限的运算', blocks: [{ type: 'lead', text: '本节讲极限的四则运算法则。' }, { type: 'para', text: '两个收敛函数的和的极限等于极限的和。' }] },
      ]),
    });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }, 'e2e-hd-edit-vid');
}

// 桌面：hover 状态
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await seed(page);
await page.goto(`${BASE}/#/player/e2e-hd-edit-vid`, { waitUntil: 'networkidle' });
await page.click('.ant-tabs-nav >> text=讲义');
await page.waitForSelector('.hd-figure img', { timeout: 10000 });
const para = page.locator('.hd-swipe', { hasText: '极限是描述函数' });
await para.hover();
await page.waitForTimeout(400);
await page.screenshot({ path: 'e2e-shots/handout-edit-desktop.png' });

// 移动端：滑开状态
const mctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const mp = await mctx.newPage();
await seed(mp);
await mp.goto(`${BASE}/#/player/e2e-hd-edit-vid`, { waitUntil: 'networkidle' });
await mp.click('nav >> text=讲义');
await mp.waitForSelector('.hd-figure img', { timeout: 10000 });
const target = mp.locator('.hd-swipe-content', { hasText: '极限是描述函数' });
await target.scrollIntoViewIfNeeded();
const box = await target.boundingBox();
const cdp = await mctx.newCDPSession(mp);
const y = box.y + box.height / 2;
const startX = box.x + box.width - 20;
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y, id: 1 }] });
for (const dx of [30, 60, 100, 160]) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX - dx, y, id: 1 }] });
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await mp.waitForTimeout(400);
await mp.screenshot({ path: 'e2e-shots/handout-edit-mobile-swipe.png' });

await browser.close();
console.log('ok');
