/** 整卡起拖、删除区反馈、取消保护，以及学习助手一体式输入栏。 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, hasTouch: true });
const page = await context.newPage();
const base = process.env.BASE_URL || 'http://localhost:5173';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`${base}/#/library`);
  await page.locator('input[type=file]').waitFor({ state: 'attached' });
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open('wangke');
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction(['videos', 'segments'], 'readwrite');
    tx.objectStore('videos').put({ id: 'whole-card', name: '整卡拖动回归', size: 0, mimeType: 'video/mp4', duration: 60, createdAt: Date.now(), status: 'transcribed' });
    tx.objectStore('segments').add({ videoId: 'whole-card', idx: 0, start: 0, end: 10, text: '用于验证学习助手输入栏。', status: 1 });
    await new Promise((resolve) => tx.oncomplete = resolve);
    db.close();
  });
  await page.reload();
  const card = page.getByTestId('video-item');
  const thumb = card.getByTestId('video-thumb');
  await thumb.waitFor();
  assert.equal(await page.getByTestId('drag-handle').count(), 0);
  const box = await thumb.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 25, y + 15, { steps: 3 });
  await page.locator('.drag-ghost').waitFor();
  const zone = page.getByTestId('drag-zone-delete');
  const target = await zone.boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await page.waitForFunction(() => document.querySelector('[data-testid="drag-zone-delete"]')?.textContent.includes('松手删除'));
  assert.ok(await zone.evaluate((el) => getComputedStyle(el).borderTopStyle === 'solid'));
  await page.mouse.up();
  await page.getByTestId('confirm-dialog-danger').waitFor();
  assert.ok(page.url().includes('/library'), '拖动缩略图不会误打开课程');
  await page.keyboard.press('Escape');
  await page.getByTestId('confirm-dialog-danger').waitFor({ state: 'hidden' });
  assert.equal(await card.count(), 1, '取消删除保留卡片');

  // 真触摸长按缩略图，而不只是用鼠标模拟长按标题。
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
  await page.waitForTimeout(520);
  await page.locator('.drag-ghost').waitFor();
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 70 * i / 8, y: y + 200 * i / 8, id: 0 }] });
  }
  await page.locator('.drag-ghost').waitFor();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.locator('.drag-ghost').waitFor({ state: 'hidden' });
  assert.ok(page.url().includes('/library'), '触屏长按后松手不会误打开课程');
  await thumb.click();
  await page.getByTestId('study-assistant-toggle').click();
  await page.getByTestId('panel-tab-chat').click();
  const input = page.getByTestId('chat-input').locator('textarea');
  await input.fill('保留一行输入');
  assert.equal(await input.getAttribute('rows'), '1');
  assert.equal(await input.evaluate((el) => getComputedStyle(el).borderTopWidth), '0px');
  await page.setViewportSize({ width: 390, height: 844 });
  await input.waitFor();
  const row = page.locator('.chat-composer__row');
  assert.ok(await row.evaluate((el) => el.scrollWidth <= el.clientWidth), '窄屏输入栏不横向溢出');
  assert.deepEqual(errors, []);
  console.log('PASS: 整卡鼠标拖动、触屏长按、删除区高亮/文案、取消保护、普通点击、助手一条式输入和窄屏布局');
} finally {
  await browser.close();
}
