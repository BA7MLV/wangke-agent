/** 浏览器真实触摸：文字高亮、重排/恢复、摘录问答及工具上下文。使用独立浏览器数据。 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1100, height: 1100 }, hasTouch: true });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const byId = (id) => page.getByTestId(id);

await page.addInitScript(() => {
  localStorage.setItem('wangke-settings', JSON.stringify({ version: 2, state: {
    providers: [{ id: 'test', name: 'Test', baseUrl: 'https://highlights.test/v1', apiKey: 'test', protocol: 'openai-chat', serves: ['chat'], catalogId: 'openai' }],
    llmModel: { providerId: 'test', model: 'gpt-4o' }, contextWindow: 32768, agentRounds: 4, thinkingEnabled: false,
  } }));
  window.__highlightRequests = [];
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    if (!String(input).startsWith('https://highlights.test/')) return original(input, init);
    const body = JSON.parse(init.body);
    window.__highlightRequests.push(body);
    const hasResult = body.messages.some((m) => m.role === 'tool' && String(m.content).includes('<mark>'));
    const delta = hasResult ? { content: '已依据高亮原文回答。' } : { tool_calls: [{ index: 0, id: 'read-highlights', type: 'function', function: { name: 'read', arguments: '{"path":"/courses/current/highlights"}' } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: hasResult ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
});

async function importFile(file) {
  await page.goto(`${BASE}/#/library`);
  await page.locator('input[type=file]').waitFor({ state: 'attached' });
  const old = await page.locator('[data-video-id]').evaluateAll((els) => els.map((e) => e.dataset.videoId));
  await page.locator('input[type=file]').setInputFiles(file);
  const id = await (await page.waitForFunction((old) => [...document.querySelectorAll('[data-testid="video-item"]')].find((e) => !old.includes(e.dataset.videoId))?.dataset.videoId, old)).jsonValue();
  await page.goto(`${BASE}/#/player/${id}`);
  await page.waitForFunction(() => document.querySelector('[data-testid="ink-smart"]')?.disabled === false);
  return id;
}

async function rows(id) {
  return page.evaluate(async (id) => (await import('/src/store/db.ts')).db.materialInk.where('materialId').equals(id).toArray(), id);
}
async function saved(id, count) {
  for (let i = 0; i < 100; i++) { if ((await rows(id)).length === count) return; await delay(30); }
  assert.equal((await rows(id)).length, count, '批注事务完成');
}
async function touch(type, x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: .5 }] });
}

// 从测试文档的实际 DOM 取字符中心，不调用被测高亮算法。
async function endpoints(target, start, end) {
  return target.evaluate((el, { start, end }) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), runs = [];
    let n, offset = 0;
    while ((n = walker.nextNode())) { runs.push({ node: n, start: offset }); offset += n.length; }
    const at = (i) => {
      const run = runs.find((r) => i >= r.start && i < r.start + r.node.length);
      const range = document.createRange(); range.setStart(run.node, i - run.start); range.setEnd(run.node, i - run.start + 1);
      const r = range.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    };
    return { a: at(start), b: at(end - 1), text: el.textContent.slice(start, end) };
  }, { start, end });
}
async function highlight(target, start, end, reverse = false) {
  await byId('ink-text-highlight').click();
  await target.evaluate((e) => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const points = await endpoints(target, start, end);
  const a = reverse ? points.b : points.a, b = reverse ? points.a : points.b;
  await touch('touchStart', a.x, a.y);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', a.x + (b.x - a.x) * i / 8, a.y + (b.y - a.y) * i / 8); await delay(16); }
  await touch('touchEnd');
  assert.equal(await byId('ink-smart').getAttribute('aria-checked'), 'true', '高亮后恢复智能批注');
  return points.text;
}

try {
  const paragraph = '监督学习使用带标签的数据训练模型。验证集用于评估泛化能力，训练误差降低并不代表真实效果更好。'.repeat(5);
  const mdId = await importFile({ name: '文字高亮测试.md', mimeType: 'text/markdown', buffer: Buffer.from(`# 高亮测试\n\n${paragraph}\n\n第二段包含 **加粗文字** 和 x < y & z，用于测试转义与独立来源。\n`) });
  assert.equal(await byId('ink-smart').getAttribute('aria-checked'), 'true');
  const para = page.locator('.mr-md__block p').filter({ hasText: '监督学习' }).first();
  const expected = await highlight(para, 3, 95, true);
  await saved(mdId, 1);
  const mark = (await rows(mdId))[0];
  assert.equal(mark.anchor.exact, expected, '反向跨行拖选精确到字符');
  assert.equal(mark.input, 'touch');
  assert.ok(mark.rects.length >= 2, '按行生成多块高亮');
  assert.equal(await para.locator('mark').count(), 0, '正文 DOM 没有被 mark 包裹改写');
  // 智能态仍允许鼠标选字，不把鼠标拖选变成笔迹。
  const mouseText = await endpoints(para, 0, 8);
  await page.mouse.move(mouseText.a.x - 3, mouseText.a.y); await page.mouse.down();
  await page.mouse.move(mouseText.b.x + 3, mouseText.b.y, { steps: 8 }); await page.mouse.up();
  assert.ok(await page.evaluate(() => getSelection()?.toString().length > 3), '智能态鼠标保留选字');
  assert.equal((await rows(mdId)).length, 1);
  await byId('ink-text-highlight').click();
  await para.evaluate((e) => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const cancelled = await endpoints(para, 5, 15);
  await touch('touchStart', cancelled.a.x, cancelled.a.y);
  await touch('touchMove', cancelled.b.x, cancelled.b.y);
  await touch('touchCancel');
  assert.equal(await byId('ink-smart').getAttribute('aria-checked'), 'true', '触摸取消后退出一次性工具');
  assert.equal((await rows(mdId)).length, 1, '取消的文字高亮不保存');
  // 高亮完成后不点任何画笔工具，主动笔直接落墨。
  const penAt = await endpoints(para, 100, 105);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...penAt.a, button: 'left', buttons: 1, pointerType: 'pen', force: .5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: penAt.a.x + 30, y: penAt.a.y + 10, button: 'left', buttons: 1, pointerType: 'pen', force: .7 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: penAt.a.x + 30, y: penAt.a.y + 10, button: 'left', buttons: 0, pointerType: 'pen' });
  await saved(mdId, 2);
  assert.equal((await rows(mdId)).find((s) => !s.anchor).tool, 'pen');
  await byId('ink-undo').click(); await saved(mdId, 1);
  await byId('ink-undo').click(); await saved(mdId, 0);
  await byId('ink-redo').click(); await saved(mdId, 1);
  assert.deepEqual((await rows(mdId))[0], mark);

  const path = page.locator(`[data-ink-stroke="${mark.id}"] path`);
  await path.waitFor();
  const originalPath = await path.getAttribute('d');
  await page.setViewportSize({ width: 620, height: 1100 });
  await page.waitForFunction(({ id, d }) => document.querySelector(`[data-ink-stroke="${id}"] path`)?.getAttribute('d') !== d, { id: mark.id, d: originalPath });
  const coverage = await para.evaluate((el, id) => {
    const path = document.querySelector(`[data-ink-stroke="${id}"] path`);
    const inside = (i) => {
      const range = document.createRange(); range.setStart(el.firstChild, i); range.setEnd(el.firstChild, i + 1);
      const r = range.getBoundingClientRect();
      return path.isPointInFill(new DOMPoint(r.x + r.width / 2, r.y + r.height / 2).matrixTransform(path.getScreenCTM().inverse()));
    };
    return { selected: Array.from({ length: 92 }, (_, i) => inside(i + 3)).every(Boolean), before: inside(2), after: inside(95) };
  }, mark.id);
  assert.deepEqual(coverage, { selected: true, before: false, after: false }, '重排后每个选中字形仍位于高亮内，前后未选字不被涂色');
  assert.deepEqual((await rows(mdId))[0], mark, '重排不改写锚点或原始快照');
  await page.reload();
  await path.waitFor();
  assert.equal(await byId('ink-smart').getAttribute('aria-checked'), 'true');
  assert.deepEqual((await rows(mdId))[0], mark, '刷新恢复高亮');
  await page.setViewportSize({ width: 1100, height: 1100 });
  await byId('ink-erase').click();
  await para.evaluate((e) => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const eraseAt = await endpoints(para, 10, 11);
  await page.mouse.click(eraseAt.a.x, eraseAt.a.y);
  await saved(mdId, 0);
  await byId('ink-undo').click(); await saved(mdId, 1);
  await byId('ink-smart').click();

  // 同一锚点不能在重复正文中猜位置；原文删除后应停止显示。
  const anchors = await page.evaluate(async () => {
    const { resolveTextAnchor } = await import('/src/materials/textHighlight.ts');
    const a = { start: 50, end: 52, exact: '重复', prefix: '', suffix: '' };
    return { ambiguous: resolveTextAnchor('重复与重复', a), moved: resolveTextAnchor('新的前缀唯一原文后缀', { start: 0, end: 4, exact: '唯一原文', prefix: '前缀', suffix: '后缀' }), deleted: resolveTextAnchor('已删除的内容', a) };
  });
  assert.equal(anchors.ambiguous, null); assert.equal(anchors.deleted, null); assert.deepEqual(anchors.moved, { start: 4, end: 8 });

  const integration = await page.evaluate(async ({ id, unit }) => {
    const { createResourceExecutor } = await import('/src/harness/resources.ts');
    const { formatCitation } = await import('/src/store/selectionAsk.ts');
    const execute = createResourceExecutor({ courseId: id, kind: 'para' });
    return {
      catalog: await execute('read', { path: '/courses/current/highlights' }),
      read: await execute('read', { path: '/courses/current/material', start: unit, end: unit }),
      grep: await execute('grep', { path: '/courses/current/material', query: '监督学习' }),
      denied: await execute('read', { path: '/courses/other/highlights' }),
      escaped: formatCitation({ source: 'md', text: '<mark> & 原文', annotation: 'highlight', unitLabel: '第 2 段' }),
    };
  }, { id: mdId, unit: mark.anchor.unit });
  for (const key of ['catalog', 'read', 'grep']) assert.ok(integration[key].includes(`<mark>${expected}</mark>`), `${key} 包含高亮原文`);
  assert.match(integration.denied, /只能访问当前课程/);
  assert.match(integration.escaped, /<mark>&lt;mark&gt; &amp; 原文<\/mark>/);
  await byId('ink-excerpts').click();
  assert.equal(await byId('ink-excerpt-list').locator('mark').innerText(), expected);
  await byId('ink-excerpt-ask').click();
  await byId('chat-ref-chip').waitFor();
  await byId('chat-input').locator('textarea').fill('请解释我的高亮内容');
  await byId('chat-send').click();
  await page.getByText('已依据高亮原文回答。', { exact: true }).waitFor();
  const requests = await page.evaluate(() => window.__highlightRequests);
  assert.ok(requests.some((r) => r.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes(`<mark>${expected}</mark>`))), '实际模型请求收到高亮引用');
  assert.ok(requests.some((r) => r.messages.some((m) => m.role === 'tool' && m.content.includes(`<mark>${expected}</mark>`))), '模型调用 read 后收到高亮工具结果');
  await byId('study-assistant-toggle').click();
  await byId('ink-excerpts').click();
  console.log('✓ 跨行反向触摸高亮、重排定位、撤销/重做、刷新、引用发送和模型工具链');

  // PDF 字符层高亮 + 问答裁图；不修改原 canvas。
  const pdfId = await importFile('scripts/fixtures/sample-zh.pdf');
  const span = page.locator('[data-page="1"] .textLayer span').filter({ hasText: /\S{5}/ }).first();
  await span.waitFor();
  const pdfText = await highlight(span, 1, 5);
  await saved(pdfId, 1);
  assert.equal((await rows(pdfId))[0].anchor.exact, pdfText);
  const crop = await page.evaluate(async (id) => {
    const { db } = await import('/src/store/db.ts'); const { cropCanvasRegion } = await import('/src/materials/region.ts');
    const canvas = document.querySelector('[data-page="1"] canvas'), original = canvas.toDataURL();
    const rect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
    const clean = cropCanvasRegion(canvas, rect, 1), marked = cropCanvasRegion(canvas, rect, 1, await db.materialInk.where('materialId').equals(id).toArray());
    return { changed: clean.dataUrl !== marked.dataUrl, hasInk: marked.hasInk, pristine: original === canvas.toDataURL() };
  }, pdfId);
  assert.deepEqual(crop, { changed: true, hasInk: true, pristine: true });
  await byId('reader-zoom-in').click();
  await page.locator('[data-ink-stroke] path').waitFor();

  const docId = await importFile('scripts/fixtures/sample.docx');
  const docPara = page.locator('.docx p').filter({ hasText: /\S{5}/ }).nth(1);
  await docPara.waitFor();
  const docText = await highlight(docPara, 1, 5);
  await saved(docId, 1);
  const docMark = (await rows(docId))[0];
  assert.equal(docMark.anchor.exact, docText);
  assert.equal(docMark.anchor.unit, Number(await docPara.getAttribute('data-unit')), 'Word 按段定位而非页面序号');

  const htmlId = await importFile('scripts/fixtures/sample.html');
  await byId('ink-text-highlight').click();
  await byId('html-view-blocks').waitFor();
  assert.equal(await byId('html-frame').count(), 0);
  const htmlPara = page.locator('.mr-html__block p').filter({ hasText: /\S{5}/ }).first();
  const htmlText = await highlight(htmlPara, 1, 5);
  await saved(htmlId, 1);
  assert.equal((await rows(htmlId))[0].anchor.exact, htmlText);
  assert.equal((await rows(htmlId))[0].anchor.source, 'html');
  console.log('✓ PDF / Word / HTML 文字高亮、PDF 裁图和材料隔离');

  await page.goto(`${BASE}/#/player/${mdId}`);
  await page.locator('[data-ink-stroke]').waitFor();
  await byId('ink-excerpts').click();
  await mkdir('e2e-shots', { recursive: true });
  await page.locator('[data-slot="toast"]').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await page.screenshot({ path: 'e2e-shots/material-highlights.png' });
  assert.deepEqual(errors, [], '没有浏览器运行时异常');
  console.log('✓ 全部通过；截图 e2e-shots/material-highlights.png');
} finally { await browser.close(); }
