import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
await context.route('https://cdn.mr.test/**', (route) => route.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const base = process.env.BASE_URL || 'http://localhost:5173';
const byId = (id) => page.getByTestId(id);
async function select(target, start = 1, end = 8, inFrame = false) {
  if (inFrame) {
    const text = await target.evaluate((el, { start, end }) => {
      const doc = el.ownerDocument;
      const node = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
      const range = doc.createRange(); range.setStart(node, start); range.setEnd(node, end);
      doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range);
      el.dispatchEvent(new doc.defaultView.PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
      return range.toString();
    }, { start, end });
    await byId('selection-menu').waitFor();
    return { text };
  }
  await target.scrollIntoViewIfNeeded();
  const points = await target.evaluate((el, { start, end }) => {
    const doc = el.ownerDocument;
    doc.getSelection()?.removeAllRanges();
    const node = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
    const range = doc.createRange(), bounds = el.getBoundingClientRect();
    const at = (i, last) => {
      range.setStart(node, i); range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      return { x: (last ? r.right - .2 : r.left + .2) - bounds.left, y: r.top + r.height / 2 - bounds.top };
    };
    return { a: at(start, false), b: at(end - 1, true), expected: node.textContent.slice(start, end) };
  }, { start, end });
  const box = await target.boundingBox();
  await page.mouse.move(box.x + points.a.x, box.y + points.a.y);
  await page.mouse.down();
  await page.mouse.move(box.x + points.b.x, box.y + points.b.y, { steps: 8 });
  await page.waitForTimeout(180);
  assert.equal(await byId('selection-menu').count(), 0, '拖选过程中不抢出菜单');
  const text = await target.evaluate((el) => el.ownerDocument.getSelection().toString());
  assert.equal(text, points.expected, '真实鼠标拖选精确到字符');
  await page.mouse.up();
  await byId('selection-menu').waitFor();
  return { text };
}
try {
  await page.goto(`${base}/#/library`);
  await page.locator('input[type=file]').setInputFiles({ name: '拖选菜单测试.md', mimeType: 'text/markdown', buffer: Buffer.from('# 菜单测试\n\n监督学习使用带标签的数据训练模型。验证集用于评估泛化能力。\n\n第二段提供跨段落选择测试。') });
  const item = page.locator('[data-testid="video-item"]').filter({ hasText: '拖选菜单测试' }).first();
  await item.waitFor();
  const id = await item.getAttribute('data-video-id');
  await page.goto(`${base}/#/player/${id}`);
  const para = page.locator('.mr-md__block p').filter({ hasText: '监督学习' }).first();
  await para.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="ink-smart"]')?.disabled === false);
  const p = await select(para);
  await page.waitForTimeout(250);
  assert.equal(await byId('ask-float').count(), 0, '拖选不弹旧浮层');
  await byId('selection-menu').waitFor();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['标记', '解释', '提问']);
  await byId('selection-mark').click();
  await page.locator('[data-ink-stroke]').waitFor();
  const rows = () => page.evaluate(async (id) => (await import('/src/store/db.ts')).db.materialInk.where('materialId').equals(id).toArray(), id);
  await page.waitForFunction(async (id) => (await import('/src/store/db.ts')).db.materialInk.where('materialId').equals(id).count().then((n) => n === 1), id);
  assert.equal((await rows())[0].anchor.exact, p.text);
  assert.equal((await rows())[0].opacity, .25);
  assert.equal((await rows())[0].color, '#facc15');
  await byId('ink-toggle').click();
  await byId('ink-undo').click();
  await page.locator('[data-ink-stroke]').waitFor({ state: 'detached' });
  await byId('ink-redo').click();
  await page.locator('[data-ink-stroke]').waitFor();
  const q = await select(para, 10, 16);
  await byId('selection-menu').waitFor();
  await page.keyboard.press('Escape');
  await byId('selection-menu').waitFor({ state: 'detached' });
  await select(para, 10, 16);
  await byId('ask-compose').click();
  await byId('chat-ref-chip').waitFor();
  assert.ok((await byId('chat-ref-chip').innerText()).includes(q.text));
  const explanation = await select(para, 18, 24);
  await byId('ask-explain').click();
  await page.waitForFunction((text) => document.body.innerText.includes(text)
    && document.body.innerText.includes('请解释这段内容的含义，并结合课程上下文说明它为什么重要。'), explanation.text);
  await page.reload();
  await page.locator('[data-ink-stroke]').waitFor();
  assert.equal((await rows()).length, 1);
  console.log('✓ Markdown 拖选菜单、标记、撤销重做、解释与提问');
  // HTML 原样视图的 iframe 也在拖选松手后弹出菜单。
  await page.goto(`${base}/#/library`);
  await page.locator('input[type=file]').setInputFiles({ name: '拖选菜单.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><html><body><h1>拖选菜单</h1><p class="mr-probe">第一段：这段文字用于验证拖选结束后自动弹出菜单。</p></body></html>') });
  const htmlItem = page.locator('[data-testid="video-item"]').filter({ hasText: '拖选菜单.html' }).first();
  await htmlItem.waitFor();
  const htmlId = await htmlItem.getAttribute('data-video-id');
  await page.goto(`${base}/#/player/${htmlId}`);
  const rawPara = page.frameLocator('[data-testid="html-frame"]').locator('.mr-probe');
  await rawPara.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="html-frame"]')?.contentDocument?.readyState === 'complete');
  await page.waitForFunction(() => document.querySelector('[data-testid="ink-smart"]')?.disabled === false);
  const h = await select(rawPara, 1, 8, true);
  await page.waitForTimeout(250);
  assert.equal(await byId('ask-float').count(), 0);
  await byId('selection-menu').waitFor();
  assert.equal(await byId('selection-mark').getAttribute('aria-disabled'), null);
  await byId('selection-mark').click();
  await page.locator('[data-ink-stroke]').waitFor();
  const htmlRows = await page.evaluate(async (id) => (await import('/src/store/db.ts')).db.materialInk.where('materialId').equals(id).toArray(), htmlId);
  assert.equal(htmlRows[0].anchor.exact, h.text);
  console.log('✓ HTML 原样视图拖选菜单与标记');
  for (const [file, selector] of [
    ['scripts/fixtures/sample-zh.pdf', '[data-page="1"] .textLayer span'],
    ['scripts/fixtures/sample.docx', '.docx p'],
  ]) {
    await page.goto(`${base}/#/library`);
    await byId('video-item').first().waitFor();
    const old = await page.locator('[data-video-id]').evaluateAll((els) => els.map((el) => el.dataset.videoId));
    await page.locator('input[type=file]').setInputFiles(file);
    const materialId = await (await page.waitForFunction((old) => [...document.querySelectorAll('[data-testid="video-item"]')].find((el) => !old.includes(el.dataset.videoId))?.dataset.videoId, old)).jsonValue();
    await page.goto(`${base}/#/player/${materialId}`);
    const text = page.locator(selector).filter({ hasText: /\S{5}/ }).first();
    await text.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="ink-smart"]')?.disabled === false);
    await text.scrollIntoViewIfNeeded();
    const chosen = await select(text, 1, 5);
    await byId('selection-mark').click();
    await page.locator('[data-ink-stroke]').waitFor();
    const marks = await page.evaluate(async (id) => (await import('/src/store/db.ts')).db.materialInk.where('materialId').equals(id).toArray(), materialId);
    assert.equal(marks[0].anchor.exact, chosen.text, `${file} 拖选标记精确选区`);
    console.log(`✓ ${file} 拖选菜单与标记`);
  }
  assert.deepEqual(errors, []);
  console.log('✓ Markdown / PDF / Word / HTML 拖选松手自动菜单、精确高亮、撤销重做、Escape、解释与提问、刷新恢复');
} catch (error) {
  console.error('测试失败页面：', page.url(), await page.locator('body').innerText());
  throw error;
} finally { await browser.close(); }
