import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const base = process.env.BASE_URL || 'http://localhost:5173';
const byId = (id) => page.getByTestId(id);
async function select(target, start = 1, end = 8) {
  return target.evaluate((el, { start, end }) => {
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const r = range.getBoundingClientRect();
    return { x: r.left + 2, y: r.top + r.height / 2, text: range.toString() };
  }, { start, end });
}
try {
  await page.goto(`${base}/#/library`);
  await page.locator('input[type=file]').setInputFiles({ name: '右键菜单测试.md', mimeType: 'text/markdown', buffer: Buffer.from('# 菜单测试\n\n监督学习使用带标签的数据训练模型。验证集用于评估泛化能力。\n\n第二段提供跨段落选择测试。') });
  const item = page.locator('[data-testid="video-item"]').filter({ hasText: '右键菜单测试' }).first();
  await item.waitFor();
  const id = await item.getAttribute('data-video-id');
  await page.goto(`${base}/#/player/${id}`);
  const para = page.locator('.mr-md__block p').filter({ hasText: '监督学习' }).first();
  await para.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="ink-smart"]')?.disabled === false);
  const p = await select(para);
  await page.waitForTimeout(250);
  assert.equal(await byId('ask-float').count(), 0, '拖选不弹旧浮层');
  await page.mouse.click(p.x, p.y, { button: 'right' });
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
  await page.mouse.click(q.x, q.y, { button: 'right' });
  await byId('selection-menu').waitFor();
  await page.keyboard.press('Escape');
  await byId('selection-menu').waitFor({ state: 'detached' });
  await page.mouse.click(q.x, q.y, { button: 'right' });
  await byId('ask-compose').click();
  await byId('chat-ref-chip').waitFor();
  assert.ok((await byId('chat-ref-chip').innerText()).includes(q.text));
  await page.evaluate(async () => {
    const { useSelectionAsk } = await import('/src/store/selectionAsk.ts');
    useSelectionAsk.subscribe((state) => { if (state.pending) window.__selectionAction = state.pending; });
  });
  const explanation = await select(para, 18, 24);
  await page.mouse.click(explanation.x, explanation.y, { button: 'right' });
  await byId('ask-explain').click();
  const sent = await page.evaluate(() => window.__selectionAction);
  assert.equal(sent.mode, 'explain');
  assert.equal(sent.cite.text, explanation.text);
  await page.reload();
  await page.locator('[data-ink-stroke]').waitFor();
  assert.equal((await rows()).length, 1);
  // HTML 原样视图的 iframe 事件也走右键菜单，标记复用分段视图的荧光棒。
  await page.goto(`${base}/#/library`);
  await page.locator('input[type=file]').setInputFiles('scripts/fixtures/sample.html');
  const htmlItem = page.locator('[data-testid="video-item"]').filter({ hasText: 'sample.html' }).first();
  await htmlItem.waitFor();
  const htmlId = await htmlItem.getAttribute('data-video-id');
  await page.goto(`${base}/#/player/${htmlId}`);
  const rawPara = page.frameLocator('[data-testid="html-frame"]').locator('.mr-probe');
  await rawPara.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="ink-smart"]')?.disabled === false);
  const h = await select(rawPara, 1, 8);
  await page.waitForTimeout(250);
  assert.equal(await byId('ask-float').count(), 0);
  await rawPara.click({ button: 'right', position: { x: 20, y: 10 } });
  await byId('selection-menu').waitFor();
  assert.equal(await byId('selection-mark').getAttribute('aria-disabled'), null);
  await byId('selection-mark').click();
  await page.locator('[data-ink-stroke]').waitFor();
  const htmlRows = await page.evaluate(async (id) => (await import('/src/store/db.ts')).db.materialInk.where('materialId').equals(id).toArray(), htmlId);
  assert.equal(htmlRows[0].anchor.exact, h.text);
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
    await page.mouse.click(chosen.x, chosen.y, { button: 'right' });
    await byId('selection-mark').click();
    await page.locator('[data-ink-stroke]').waitFor();
    const marks = await page.evaluate(async (id) => (await import('/src/store/db.ts')).db.materialInk.where('materialId').equals(id).toArray(), materialId);
    assert.equal(marks[0].anchor.exact, chosen.text, `${file} 右键标记精确选区`);
  }
  assert.deepEqual(errors, []);
  console.log('✓ Markdown / PDF / Word / HTML 资料右键菜单、精确高亮、撤销重做、Escape、引用提问、刷新恢复');
} catch (error) {
  console.error('测试失败页面：', page.url(), await page.locator('body').innerText());
  throw error;
} finally { await browser.close(); }
