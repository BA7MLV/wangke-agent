/** 浮动助手：真实鼠标/触摸拖动、点击分流、位置记忆、取消、边界和旋转。 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, hasTouch: true });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const toggle = page.getByTestId('study-assistant-toggle');
const panel = page.getByTestId('study-assistant-panel');
const header = page.getByTestId('study-assistant-drag-handle');
const assistant = page.locator('.study-assistant');
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const closeTo = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 2, `${label}: ${actual} ≈ ${expected}`);

async function drag(handle, dx, dy, touch = false, cancel = false) {
  const box = await handle.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  if (touch) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 8, y: y + dy * i / 8, id: 0 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
  }
  await settle();
}

async function inViewport() {
  await settle();
  const rect = await assistant.boundingBox();
  const { width, height } = page.viewportSize();
  assert.ok(rect.x >= 15 && rect.y >= 15 && rect.x + rect.width <= width - 15 && rect.y + rect.height <= height - 15,
    `助手在安全边界内：${JSON.stringify({ rect, width, height })}`);
}

try {
  await page.goto(`${BASE}/#/library`);
  await page.locator('input[type=file]').waitFor({ state: 'attached' });
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('wangke');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['videos', 'segments'], 'readwrite');
    tx.objectStore('videos').put({ id: 'drag-demo', name: '助手拖动示例', size: 0, mimeType: 'video/mp4', duration: 60, createdAt: Date.now(), status: 'transcribed' });
    tx.objectStore('segments').add({ videoId: 'drag-demo', idx: 0, start: 0, end: 10, text: '拖动助手时，课程内容继续保留。', status: 1 });
    await new Promise((resolve) => tx.oncomplete = resolve);
    db.close();
  });
  await page.goto(`${BASE}/#/player/drag-demo`);
  await toggle.waitFor();
  await inViewport();
  const original = await toggle.boundingBox();
  await drag(toggle, -220, -110);
  assert.equal(await panel.isVisible(), false, '拖动按钮不误展开');
  const moved = await toggle.boundingBox();
  closeTo(moved.x, original.x - 220, '鼠标水平拖动');
  closeTo(moved.y, original.y - 110, '鼠标垂直拖动');
  await page.reload(); await toggle.waitFor(); await settle();
  const restored = await toggle.boundingBox();
  closeTo(restored.x, moved.x, '刷新恢复横坐标');
  closeTo(restored.y, moved.y, '刷新恢复纵坐标');

  await toggle.click(); await panel.waitFor(); await inViewport();
  const beforeHeader = await assistant.boundingBox();
  await drag(header, -180, 60);
  assert.equal(await panel.isVisible(), true, '拖动标题不收起');
  const afterHeader = await assistant.boundingBox();
  closeTo(afterHeader.x, beforeHeader.x - 180, '标题水平拖动');
  closeTo(afterHeader.y, beforeHeader.y + 60, '标题垂直拖动');
  await page.getByTestId('panel-tab-chat').click();
  await page.getByTestId('chat-input').locator('textarea').fill('拖动后保留的草稿');
  await drag(page.getByTestId('chat-input').locator('textarea'), 40, 0);
  closeTo((await assistant.boundingBox()).x, afterHeader.x, '正文选字不移动助手');
  await toggle.click();
  assert.equal(await panel.isVisible(), false);

  const beforeTouch = await toggle.boundingBox();
  await drag(toggle, 80, 40, true);
  assert.equal(await panel.isVisible(), false, '触摸拖动按钮不误展开');
  const afterTouch = await toggle.boundingBox();
  closeTo(afterTouch.x, beforeTouch.x + 80, '触摸水平拖动');
  closeTo(afterTouch.y, beforeTouch.y + 40, '触摸垂直拖动');
  await page.touchscreen.tap(afterTouch.x + afterTouch.width / 2, afterTouch.y + afterTouch.height / 2);
  await panel.waitFor(); await settle();
  assert.equal(await page.getByTestId('chat-input').locator('textarea').inputValue(), '拖动后保留的草稿');
  const beforeCancel = await assistant.boundingBox();
  await drag(header, 35, -25, true, true);
  const afterCancel = await assistant.boundingBox();
  closeTo(afterCancel.x, beforeCancel.x, '取消触摸恢复横坐标');
  closeTo(afterCancel.y, beforeCancel.y, '取消触摸恢复纵坐标');
  await toggle.focus(); await page.keyboard.press('Enter');
  assert.equal(await panel.isVisible(), false, '拖动取消后键盘仍能收起');
  await page.keyboard.press('Space'); await panel.waitFor();

  await drag(header, -900, -900);
  await inViewport();
  assert.equal(await panel.isVisible(), true);
  for (const viewport of [{ width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction((height) => parseFloat(document.querySelector('.study-assistant-viewport').style.height) === height, viewport.height);
    await inViewport();
    await toggle.click(); await inViewport();
    await toggle.click(); await panel.waitFor(); await inViewport();
  }
  assert.deepEqual(errors, [], '没有运行时异常');
  console.log('✓ 鼠标/触摸拖动、轻点/键盘切换、草稿保留、刷新记忆、取消恢复、边界与横竖屏通过');
} finally { await browser.close(); }
