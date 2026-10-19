/** 手写批注与悬浮助手：真实导入、笔/手指路由、取消、持久化、格式切换、响应式。 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const cdp = await context.newCDPSession(page);
const byId = (id) => page.getByTestId(id);

async function inkRows() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('wangke');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise((resolve, reject) => {
      const request = db.transaction('materialInk').objectStore('materialInk').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows;
  });
}

async function waitSaved(count) {
  for (let n = 0; n < 100; n++) {
    if ((await inkRows()).length === count) return;
    await delay(50);
  }
  assert.equal((await inkRows()).length, count, '等待批注事务完成');
}

async function importFile(file) {
  await page.goto(`${BASE}/#/library`);
  await page.locator('input[type=file]').waitFor({ state: 'attached' });
  const old = await page.locator('[data-video-id]').evaluateAll((els) => els.map((e) => e.dataset.videoId));
  await page.locator('input[type=file]').setInputFiles(file);
  const id = await (await page.waitForFunction((old) => [...document.querySelectorAll('[data-testid="video-item"]')].find((e) => !old.includes(e.dataset.videoId))?.dataset.videoId, old)).jsonValue();
  await page.goto(`${BASE}/#/player/${id}`);
  await byId('ink-pen').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="ink-pen"]')?.disabled);
  return id;
}

async function penStroke(layer, yOffset = 70) {
  // 长页不能居中滚动：顶部可能落到固定工具栏后面，导致测试把笔点在按钮上。
  await layer.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await layer.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = await layer.boundingBox();
  const x = box.x + Math.min(box.width * .2, 120), y = box.y + Math.min(box.height * .4, yOffset);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, pointerType: 'pen', force: .2, clickCount: 1 });
  for (let i = 1; i <= 18; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + i * 4, y: y + Math.sin(i / 3) * 10, button: 'left', buttons: 1, pointerType: 'pen', force: .2 + i / 30 });
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 72, y: y + Math.sin(6) * 10, button: 'left', buttons: 0, pointerType: 'pen', force: 0, clickCount: 1 });
}

// CDP 触摸会触发浏览器真正的手势仲裁 / pointercancel；dispatchEvent 无法覆盖这一层。
async function touchAt(type, x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: .5 }] });
}

async function touchSwipe(x, y, distance = 90) {
  await touchAt('touchStart', x, y);
  for (let i = 1; i <= 6; i++) {
    await touchAt('touchMove', x, y - distance * i / 6);
    await delay(16);
  }
  await touchAt('touchEnd');
}

try {
  const pdfId = await importFile('scripts/fixtures/sample-zh.pdf');
  assert.equal(await byId('study-assistant-panel').isVisible(), false);
  assert.equal(await byId('chat-input').count(), 1, '收起仍挂载问答');
  await byId('ink-pen').click();
  await page.getByLabel('笔型', { exact: true }).selectOption('brush');
  await page.getByLabel('实时字迹美化').selectOption('0.65');
  await page.getByLabel('笔迹浓度').fill('60');
  await page.getByLabel('笔迹粗细').fill('4.5');
  const first = page.locator('[data-page="1"] [data-testid="ink-layer"]');
  await first.waitFor();
  await page.locator('[data-page="1"] .textLayer span').first().waitFor();
  await first.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await first.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = await first.boundingBox();
  const scrollTop = () => page.locator('.mr-scroll').evaluate((e) => e.scrollTop);
  await touchSwipe(box.x + 100, box.y + 220);
  assert.equal((await inkRows()).length, 0, '手指翻阅不留笔迹');
  assert.ok(await scrollTop() > 0, '真实触摸在批注态能翻阅');
  // 接触即停止惯性，随后取消这个触摸，回到起点。
  await touchAt('touchStart', box.x + 100, box.y + 220);
  await touchAt('touchCancel');
  await page.locator('.mr-scroll').evaluate((e) => e.scrollTop = 0);

  await penStroke(first);
  await waitSaved(1);
  const savedRows = await inkRows();
  const saved = savedRows[0];
  assert.equal(saved.surface, 'pdf:1');
  assert.equal(saved.renderer, 'freehand-v1');
  assert.equal(saved.nib, 'brush');
  assert.equal(saved.smoothing, 0.65);
  assert.equal(saved.opacity, 0.6);
  assert.equal(await first.locator('[data-ink-stroke] path').getAttribute('opacity'), '0.6');
  assert.ok(new Set(saved.points.map((p) => p.pressure)).size > 2, '保留真实笔压');
  assert.ok(await first.locator('[data-ink-stroke] path').getAttribute('d'));
  await byId('ink-undo').click(); await waitSaved(0);
  await byId('ink-redo').click(); await waitSaved(1);
  assert.deepEqual((await inkRows())[0], saved, '重做恢复原笔迹');

  // 竖直笔画 + 同时发生的真实触摸：浏览器不能把笔画接管为滚动。
  await first.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const r = await first.boundingBox();
  const px = r.x + 130, py = r.y + 70;
  const pen = async (type, y) => cdp.send('Input.dispatchMouseEvent', {
    type, x: px, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
    pointerType: 'pen', force: type === 'mouseReleased' ? 0 : .5, clickCount: 1,
  });
  const beforePen = await scrollTop();
  await pen('mousePressed', py);
  await pen('mouseMoved', py + 35);
  await touchSwipe(px + 80, py + 180);
  await pen('mouseMoved', py + 140);
  assert.equal(await scrollTop(), beforePen, '落笔期间手指不能拖动页面');
  await pen('mouseReleased', py + 140);
  await waitSaved(2);
  const vertical = (await inkRows()).find((s) => s.id !== saved.id);
  assert.ok((vertical.points.at(-1).y - vertical.points[0].y) * r.width / 1000 > 130, '长竖笔没有被 UA 取消');
  await byId('ink-undo').click(); await waitSaved(1);

  // 跨页面共享仲裁：先触摸再落笔，触摸 cancel / lostcapture 不能清空笔画。
  await delay(300);
  await first.evaluate(async (el) => {
    const r = el.getBoundingClientRect();
    const scroll = el.closest('.mr-scroll');
    const fire = (target, type, id, pointerType, x, y) => target.dispatchEvent(new PointerEvent(type,
      { bubbles: true, cancelable: true, isPrimary: true, pointerId: id, pointerType, button: 0,
        clientX: r.left + x, clientY: r.top + y, width: 8, height: 8, pressure: .5 }));
    fire(scroll, 'pointerdown', 501, 'touch', 100, 200);
    fire(el, 'pointerdown', 502, 'pen', 100, 80);
    fire(el, 'pointermove', 502, 'pen', 100, 100);
    fire(scroll, 'pointercancel', 501, 'touch', 100, 200);
    fire(scroll, 'lostpointercapture', 501, 'touch', 100, 200);
    fire(el, 'pointermove', 502, 'pen', 100, 150);
    fire(el, 'pointerup', 502, 'pen', 100, 150);
  });
  await waitSaved(2);
  await byId('ink-undo').click(); await waitSaved(1);

  // 抬笔后手掌还未离屏：超过保护时间也不能把这一触摸重新认成翻页。
  await delay(300);
  const heldPalm = await first.evaluate(async (el) => {
    const r = el.getBoundingClientRect(), scroll = el.closest('.mr-scroll');
    const fire = (type, id, pointerType, y) => el.dispatchEvent(new PointerEvent(type,
      { bubbles: true, cancelable: true, isPrimary: true, pointerId: id, pointerType, button: 0,
        clientX: r.left + 100, clientY: r.top + y, width: 8, height: 8, pressure: .5 }));
    fire('pointerdown', 601, 'touch', 200);
    fire('pointerdown', 602, 'pen', 80);
    fire('pointerup', 602, 'pen', 100);
    const before = scroll.scrollTop;
    await new Promise((resolve) => setTimeout(resolve, 300));
    fire('pointermove', 601, 'touch', 100);
    fire('pointerup', 601, 'touch', 100);
    return { before, after: scroll.scrollTop };
  });
  assert.equal(heldPalm.before, heldPalm.after, '掌触直到离屏都不会转为滚动');
  await waitSaved(2);
  await byId('ink-undo').click(); await waitSaved(1);
  console.log('✓ 真实触摸滚动、竖直笔画与触屏并发、独立取消、掌触生命周期');

  await byId('ink-read').click();
  await page.locator('.mr-scroll').evaluate((el) => el.scrollTop = 0);
  const readBox = await page.locator('.mr-scroll').boundingBox();
  await touchSwipe(readBox.x + 100, readBox.y + 240);
  await page.waitForFunction(() => document.querySelector('.mr-scroll').scrollTop > 0);
  assert.equal((await inkRows()).length, 1, '阅读态保留原生滚动且不落墨');
  await byId('ink-pen').click();

  // 模拟空间不足：笔迹留在画面、错误可见、重试后只写一次。
  await page.evaluate(() => {
    window.__originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'materialInk') throw new DOMException('test full', 'QuotaExceededError');
      return window.__originalPut.apply(this, args);
    };
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  });
  await penStroke(first, 150);
  await page.getByText('批注尚未保存，请重试。').waitFor();
  assert.equal((await inkRows()).length, 1);
  assert.equal(await first.locator('[data-ink-stroke]').count(), 2);
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__originalPut; });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await waitSaved(2);
  await byId('ink-undo').click(); await waitSaved(1);

  // 手指绘制兼容电容笔，同时过滤大面积掌触。
  await byId('ink-finger').click();
  await delay(300); // 等待抬笔后的 250ms 掌触保护窗口结束
  await first.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const event = { bubbles: true, pointerId: 90, pointerType: 'touch', isPrimary: true, button: 0, clientX: r.left + 60, clientY: r.top + 90, width: 70, height: 70 };
    el.dispatchEvent(new PointerEvent('pointerdown', event));
    el.dispatchEvent(new PointerEvent('pointerup', event));
  });
  assert.equal(await first.locator('[data-ink-stroke]').count(), 1);
  // 掌触在兼容绘制模式下也不能被当成一笔。
  await first.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const palm = new PointerEvent('pointerdown', { bubbles: true, pointerId: 89, pointerType: 'touch', isPrimary: true,
      button: 0, width: 70, height: 70, clientX: r.left + 60, clientY: r.top + 90 });
    el.dispatchEvent(palm);
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 89, pointerType: 'touch', isPrimary: true,
      button: 0, width: 70, height: 70, clientX: r.left + 60, clientY: r.top + 90 }));
  });
  assert.equal(await first.locator('[data-ink-stroke]').count(), 1, '掌触不会落墨');
  await first.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const event = { bubbles: true, pointerId: 91, pointerType: 'touch', isPrimary: true, button: 0, clientX: r.left + 60, clientY: r.top + 90, width: 8, height: 8 };
    el.dispatchEvent(new PointerEvent('pointerdown', event));
    el.dispatchEvent(new PointerEvent('pointermove', { ...event, clientX: r.left + 90 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...event, clientX: r.left + 90 }));
    const next = { ...event, pointerId: 92, clientY: r.top + 120 };
    el.dispatchEvent(new PointerEvent('pointerdown', next));
    el.dispatchEvent(new PointerEvent('pointermove', { ...next, clientX: r.left + 90 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...next, clientX: r.left + 90 }));
  });
  await waitSaved(3); // 连续手指/电容笔笔画不进入触控笔的掌触保护窗口
  assert.equal((await inkRows()).filter((s) => s.input === 'touch').length, 2);
  const fingerBox = await first.boundingBox();
  const beforeFinger = await scrollTop();
  await touchSwipe(fingerBox.x + 150, Math.max(fingerBox.y + 150, 450));
  await waitSaved(4);
  assert.equal(await scrollTop(), beforeFinger, '手指绘制开关打开时真实触摸只绘制不滚动');
  await byId('ink-undo').click(); await waitSaved(3);
  // 增强美化下快速触摸转折：预览端点不能落后，抬手也不能突然变形。
  const precision = await first.evaluate(async (el) => {
    const { inkPath } = await import('/src/materials/ink.ts');
    const stroke = { renderer: 'freehand-v1', input: 'touch', tool: 'pen', nib: 'ballpoint', width: 3,
      smoothing: 0.65, points: [{ x: 10, y: 10, pressure: .5 }, { x: 80, y: 10, pressure: .5 }, { x: 80, y: 90, pressure: .5 }] };
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', inkPath(stroke, false));
    el.querySelector('svg').append(path);
    const bounds = path.getBBox();
    path.remove();
    return { bottom: bounds.y + bounds.height, same: inkPath(stroke, false) === inkPath(stroke, true) };
  });
  assert.ok(precision.bottom >= 90 && precision.bottom <= 92, '快速转折末端贴合触点');
  assert.equal(precision.same, true, '手指抬起不改变预览轮廓');
  await byId('ink-undo').click(); await waitSaved(2);
  await byId('ink-undo').click(); await waitSaved(1);
  await byId('ink-finger').click();

  const cancelEvent = { pointerId: 45, pointerType: 'pen', isPrimary: true, button: 0, clientX: box.x + 80, clientY: box.y + 50, pressure: .5 };
  await first.dispatchEvent('pointerdown', cancelEvent);
  await first.dispatchEvent('pointermove', { ...cancelEvent, clientX: box.x + 180 });
  await first.dispatchEvent('pointercancel', cancelEvent);
  assert.equal(await first.locator('[data-ink-stroke]').count(), 1, '取消手势不提交残笔');
  await byId('ink-highlight').click(); await penStroke(first, 110); await waitSaved(2);
  assert.equal((await inkRows()).find((s) => s.id !== saved.id).tool, 'highlight');
  await byId('ink-erase').click(); await penStroke(first, 110); await waitSaved(1);
  await byId('ink-undo').click(); await waitSaved(2);
  await byId('reader-zoom-in').click();
  assert.deepEqual((await inkRows()).find((s) => s.id === saved.id), saved, '缩放不改写坐标');
  await byId('reader-tool-areaselect').click();
  assert.equal(await byId('ink-read').getAttribute('aria-checked'), 'true', '框选与书写互斥');
  await byId('reader-tool-areaselect').click();
  await page.reload(); await first.locator('[data-ink-stroke]').first().waitFor();
  assert.equal(await first.locator('[data-ink-stroke]').count(), 2, '刷新恢复笔迹');
  assert.deepEqual((await inkRows()).find((s) => s.id === saved.id), saved, '笔型、浓度、美化与原始笔压持久化');

  const cropCheck = await page.evaluate(async () => {
    const { cropCanvasRegion } = await import('/src/materials/region.ts');
    const { formatCitation } = await import('/src/store/selectionAsk.ts');
    const { db } = await import('/src/store/db.ts');
    const strokes = (await db.materialInk.toArray()).filter((s) => s.surface === 'pdf:1');
    const canvas = document.querySelector('[data-page="1"] canvas');
    const before = canvas.toDataURL();
    const rect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
    const clean = cropCanvasRegion(canvas, rect, 1);
    const marked = cropCanvasRegion(canvas, rect, 1, strokes);
    const outside = cropCanvasRegion(canvas, { x: canvas.width - 30, y: canvas.height - 30, w: 20, h: 20 }, 1, strokes);
    return {
      changed: clean.dataUrl !== marked.dataUrl,
      thumbChanged: clean.thumb !== marked.thumb,
      originalUnchanged: before === canvas.toDataURL(),
      hasInk: marked.hasInk,
      outsideHasInk: !!outside.hasInk,
      citation: formatCitation({ source: 'pdf', text: '原文', unitLabel: '第 1 页', image: marked }),
    };
  });
  assert.equal(cropCheck.changed, true, '问答裁图包含笔迹');
  assert.equal(cropCheck.thumbChanged, true, '缩略图包含笔迹');
  assert.equal(cropCheck.originalUnchanged, true, '原始 PDF 画布保持原文');
  assert.equal(cropCheck.hasInk, true);
  assert.equal(cropCheck.outsideHasInk, false, '选区外批注不标记为附图内容');
  assert.match(cropCheck.citation, /用户手写批注/);
  assert.match(cropCheck.citation, /第 1 页/);

  await byId('study-assistant-toggle').click();
  await byId('chat-input').locator('textarea').fill('这段内容还没发送');
  await byId('study-assistant-toggle').click();
  await byId('study-assistant-toggle').click();
  assert.equal(await byId('chat-input').locator('textarea').inputValue(), '这段内容还没发送', '收起保留草稿');
  for (const viewport of [{ width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    // resize / visualViewport 事件在 setViewportSize 返回后才送达；等高度变量同步再量布局。
    await page.waitForFunction((height) => parseFloat(document.documentElement.style.getPropertyValue('--vvh')) === height, viewport.height);
    const panel = await byId('study-assistant-panel').boundingBox();
    assert.ok(panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= viewport.width + 1 && panel.y + panel.height <= viewport.height,
      `助手在可视区内：${JSON.stringify({ viewport, panel })}`);
    assert.ok(await byId('chat-input').locator('textarea').isVisible());
    const input = await byId('chat-input').locator('textarea').boundingBox();
    assert.ok(input.y >= panel.y && input.y + input.height <= panel.y + panel.height + 1, '输入框没有被面板裁掉');
  }
  await page.setViewportSize({ width: 1024, height: 900 });
  await byId('study-assistant-toggle').click();
  const text = page.locator('.mr-page .textLayer span').first();
  await text.waitFor();
  await text.evaluate((e) => { const range = document.createRange(); range.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
  await byId('ask-compose').click();
  await byId('chat-ref-chip').waitFor();
  assert.equal(await byId('study-assistant-panel').isVisible(), true, '划词提问自动展开助手');
  console.log('✓ PDF 笔压、手指翻阅/绘制、掌触过滤、取消、撤销/重做、橡皮、缩放、保存失败重试、持久化、助手草稿与响应式');

  const mdId = await importFile({ name: '手写批注示例.md', mimeType: 'text/markdown', buffer: Buffer.from('# 机器学习阅读笔记\n\n监督学习使用带标签的数据训练模型。可以圈出关键词，或用荧光笔标出重点。\n\n## 泛化与过拟合\n\n训练误差降低，不代表模型在新数据上表现更好。\n') });
  assert.notEqual(mdId, pdfId);
  assert.equal(await page.locator('[data-ink-stroke]').count(), 0, '材料隔离');
  await byId('ink-pen').click(); await penStroke(byId('ink-layer').nth(1)); await waitSaved(3);
  await byId('md-edit-toggle').click();
  assert.equal(await byId('ink-toolbar').count(), 0, '编辑正文时退出批注');
  await byId('md-edit-toggle').click(); await byId('ink-toolbar').waitFor();
  assert.equal(await byId('ink-read').getAttribute('aria-checked'), 'true');

  await importFile('scripts/fixtures/sample.docx');
  await byId('ink-pen').click(); await penStroke(byId('ink-layer').first()); await waitSaved(4);
  await page.reload(); await page.locator('[data-ink-stroke]').waitFor();
  await importFile('scripts/fixtures/sample.html');
  assert.equal(await byId('html-frame').count(), 1);
  await byId('ink-pen').click(); await byId('html-view-blocks').waitFor();
  assert.equal(await byId('html-frame').count(), 0, 'HTML 批注自动切到分段');
  await penStroke(byId('ink-layer').first()); await waitSaved(5);
  await byId('html-view-raw').click();
  assert.equal(await byId('ink-read').getAttribute('aria-checked'), 'true');
  console.log('✓ Markdown / Word / HTML 批注与格式切换');

  await page.evaluate(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open('wangke'); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction(['videos', 'segments'], 'readwrite');
    tx.objectStore('videos').put({ id: 'assistant-video', name: '学习助手示例', size: 0, mimeType: 'video/mp4', duration: 60, createdAt: Date.now(), status: 'transcribed' });
    tx.objectStore('segments').add({ videoId: 'assistant-video', idx: 0, start: 0, end: 10, text: '这是学习助手的测试字幕。', status: 1 });
    await new Promise((resolve) => tx.oncomplete = resolve); db.close();
  });
  await page.goto(`${BASE}/#/player/assistant-video`);
  await byId('study-assistant-toggle').click();
  for (const key of ['subs', 'handout', 'chat', 'dm', 'cards']) {
    await byId(`panel-tab-${key}`).click();
    assert.equal(await byId(`panel-slot-${key}`).isVisible(), true);
  }
  await byId('panel-tab-subs').click();
  assert.ok((await byId('panel-slot-subs').innerText()).includes('这是学习助手的测试字幕。'), '收起时字幕订阅已工作');
  console.log('✓ 视频五个学习面板统一入口');

  await page.goto(`${BASE}/#/player/${mdId}`);
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.locator('[data-ink-stroke]').waitFor();
  await byId('study-assistant-toggle').click();
  await byId('study-assistant-panel').waitFor();
  await page.locator('[data-slot="toast"]').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await mkdir('e2e-shots', { recursive: true });
  await page.screenshot({ path: 'e2e-shots/material-ink-assistant.png' });
  assert.deepEqual(errors, [], '没有运行时异常');
  console.log('✓ 全部通过；截图 e2e-shots/material-ink-assistant.png');
} finally { await browser.close(); }
