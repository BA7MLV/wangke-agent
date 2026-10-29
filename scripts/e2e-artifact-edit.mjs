import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

await mkdir(new URL('../e2e-shots/', import.meta.url), { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (window.top !== window) return;
    window.__artifactTestImport = (path) => {
      const resource = performance.getEntriesByType('resource').findLast((entry) => new URL(entry.name).pathname === path);
      return import(resource?.name ?? path);
    };
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      theme: 'light',
      providers: [{ id: 'test', name: 'Test', baseUrl: 'https://artifact.test/v1', apiKey: 'test', serves: ['chat'], catalogId: 'siliconflow-cn' }],
      llmModel: { providerId: 'test', model: 'test-model' },
    } }));
  });
  const requests = [], plans = [];
  const plan = (reply, hold = false) => {
    let release, started;
    const wait = new Promise((resolve) => { release = resolve; });
    const received = new Promise((resolve) => { started = resolve; });
    plans.push({ reply, wait: hold ? wait : Promise.resolve(), started });
    return { release, received };
  };
  await page.route('https://artifact.test/**', async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const next = plans.shift();
    assert.ok(next, 'no accidental extra paid requests');
    next.started();
    await next.wait;
    await route.fulfill(body.stream ? {
      contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: next.reply.content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    } : { json: { choices: [{ message: { role: 'assistant', content: JSON.stringify(next.reply) } }] } }).catch(() => {});
  });
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  const composer = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await composer.waitFor();
  await page.waitForFunction(async () => (await window.__artifactTestImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  const initial = '保留正文 SECRET_OTHER_CONTENT\n\n```diagram title="函数"\n{"type":"plot","curves":[{"fn":"x^2"}]}\n```\n\n保留另一张图\n```diagram\n{"type":"chart","kind":"bar","data":[{"label":"不改","value":4}]}\n```\n\n```html interactive\n<p>old static</p>\n```';
  const widgetSource = '<section><h3>原来的交互图</h3><label>系数<input type="range" min="1" max="5" value="2"></label><script>document.querySelector("section").dataset.run = String(Math.random());</script></section>';
  const { rowId, sessionId, otherSessionId } = await page.evaluate(async ({ content, widgetSource }) => {
    const { db } = await window.__artifactTestImport('/src/store/db.ts');
    const { useCourseChat } = await window.__artifactTestImport('/src/store/courseChat.ts');
    const sessionId = await db.chatSessions.add({ videoId: '__library_assistant__', title: '非阻塞独立修改测试', createdAt: Date.now() });
    const otherSessionId = await db.chatSessions.add({ videoId: '__library_assistant__', title: '另一个会话', createdAt: Date.now() });
    await db.chats.add({ sessionId: otherSessionId, videoId: '__library_assistant__', role: 'assistant', content: '可以继续查看其他会话', createdAt: Date.now() });
    const rowId = await db.chats.add({ sessionId, videoId: '__library_assistant__', role: 'assistant', content, createdAt: Date.now(),
      widget: { id: 'edit-widget', html: widgetSource } });
    await useCourseChat.getState().loadSession(sessionId);
    return { rowId, sessionId, otherSessionId };
  }, { content: initial, widgetSource });
  const readRow = () => page.evaluate(async (id) => (await window.__artifactTestImport('/src/store/db.ts')).db.chats.get(id), rowId);
  const switchSession = (id) => page.evaluate(async (id) => (await window.__artifactTestImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(id), id);
  const artifacts = page.getByTestId('editable-artifact');
  // Only direct children: a ready preview contains the same diagram renderer.
  const diagrams = artifacts.filter({ has: page.locator(':scope > [data-testid="diagram-block"]') });
  const first = diagrams.nth(0), second = diagrams.nth(1);
  const panel = (block) => block.getByTestId('artifact-edit-panel');
  const begin = async (block, instruction) => {
    await block.getByRole('button', { name: '修改此图', exact: true }).focus();
    await block.getByRole('button', { name: '修改此图', exact: true }).press('Enter');
    await panel(block).getByRole('textbox', { name: '修改要求', exact: true }).fill(instruction);
    await panel(block).getByRole('button', { name: '生成局部修改', exact: true }).click();
  };

  const pending = plan({ edits: [{ search: 'x^2', replace: 'sin(x)' }] }, true);
  await begin(first, '把曲线改为 sin(x)');
  await pending.received;
  assert.equal(await page.getByRole('dialog').count(), 0, 'generating never opens a modal or traps focus');
  await panel(first).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'e2e-shots/artifact-edit-generating.png' });
  await composer.fill('生成期间仍可输入');
  assert.equal(await composer.inputValue(), '生成期间仍可输入');
  plan({ content: '独立修改不阻塞正常对话' });
  await composer.press('Enter');
  await page.getByText('独立修改不阻塞正常对话', { exact: true }).waitFor();
  await page.waitForFunction(async () => !(await window.__artifactTestImport('/src/store/courseChat.ts')).useCourseChat.getState().loading);
  // The conversation has just autoscrolled; keyboard activation avoids a moving pointer target.
  await panel(first).getByRole('button', { name: '收起', exact: true }).focus();
  await panel(first).getByRole('button', { name: '收起', exact: true }).press('Enter');
  await first.getByTestId('artifact-edit-status').getByRole('button', { name: '查看进度' }).waitFor();
  plan({ edits: [{ search: '"value":4', replace: '"value":7' }] });
  await begin(second, '把条形值改为 7');
  await panel(second).getByTestId('artifact-edit-preview').getByTestId('diagram-block').waitFor();
  await panel(second).getByRole('button', { name: '应用修改', exact: true }).click();
  await panel(second).waitFor({ state: 'hidden' });
  assert.equal((await readRow()).content, initial.replace('"value":4', '"value":7'), 'a sibling can apply while the first request is pending');

  // Unmount the whole message, not merely hide the panel. The paid request must continue.
  await switchSession(otherSessionId);
  await page.getByText('可以继续查看其他会话', { exact: true }).waitFor();
  pending.release();
  await page.waitForFunction(async (id) => Object.entries((await window.__artifactTestImport('/src/store/artifactDrafts.ts')).useArtifactDrafts.getState().drafts)
    .some(([key, draft]) => JSON.parse(key)[0] === id && draft.status === 'ready' && draft.next?.includes('sin(x)')), rowId);
  await switchSession(sessionId);
  await first.getByRole('button', { name: '查看修改', exact: true }).click();
  await panel(first).getByTestId('artifact-edit-preview').getByTestId('diagram-block').waitFor();
  assert.equal((await readRow()).content, initial.replace('"value":4', '"value":7'), 'generation must not auto-save');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].messages.length, 2);
  assert.ok(!JSON.stringify(requests[0]).includes('SECRET_OTHER_CONTENT'));
  assert.ok(!JSON.stringify(requests[0]).includes('原来的交互图'));
  await panel(first).getByRole('button', { name: '应用修改', exact: true }).click();
  await panel(first).waitFor({ state: 'hidden' });
  assert.equal((await readRow()).content, initial.replace('x^2', 'sin(x)').replace('"value":4', '"value":7'), 'applying a returning draft rebases over unrelated changes');
  await first.getByRole('button', { name: '撤销上次修改' }).click();
  await page.waitForFunction(async ({ id, expected }) => (await window.__artifactTestImport('/src/store/db.ts')).db.chats.get(id).then((r) => r.content === expected), { id: rowId, expected: initial.replace('"value":4', '"value":7') });

  plan({ edits: [{ search: '"type":"plot"', replace: '"type":"invalid"' }] });
  await begin(first, '测试拒绝坏 schema');
  await panel(first).getByRole('alert').waitFor();
  assert.equal((await readRow()).content, initial.replace('"value":4', '"value":7'));
  await panel(first).getByRole('button', { name: '收起', exact: true }).click();
  const cancelled = plan({ edits: [{ search: 'x^2', replace: 'cos(x)' }] }, true);
  await begin(first, '测试取消生成');
  await cancelled.received;
  await panel(first).getByRole('button', { name: '停止生成', exact: true }).click();
  await panel(first).getByText('已停止生成，原内容未修改。', { exact: true }).waitFor();
  assert.equal(await panel(first).getByTestId('artifact-edit-preview').count(), 0);
  plan({ edits: [{ search: 'x^2', replace: 'sin(x)' }] });
  await panel(first).getByRole('button', { name: '生成局部修改', exact: true }).click();
  await panel(first).getByTestId('artifact-edit-preview').getByTestId('diagram-block').waitFor();
  cancelled.release();
  await panel(first).getByRole('button', { name: '收起', exact: true }).click();

  const staticBlock = artifacts.filter({ has: page.locator(':scope > [data-testid="html-answer"]') });
  await staticBlock.getByRole('button', { name: '更多 HTML 操作' }).click();
  await page.getByRole('menuitem', { name: '修改 HTML', exact: true }).click();
  await panel(staticBlock).getByRole('textbox', { name: '修改要求', exact: true }).fill('改标题');
  plan({ edits: [{ search: 'old static', replace: 'new static' }] });
  await panel(staticBlock).getByRole('button', { name: '生成局部修改', exact: true }).click();
  await panel(staticBlock).getByTestId('artifact-edit-preview').getByTestId('widget-frame').contentFrame().getByText('new static', { exact: true }).waitFor();
  await panel(staticBlock).getByRole('button', { name: '应用修改', exact: true }).click();
  await panel(staticBlock).waitFor({ state: 'hidden' });
  assert.equal((await readRow()).content, initial.replace('"value":4', '"value":7').replace('old static', 'new static'));

  const widget = artifacts.filter({ has: page.locator(':scope > [data-testid="widget-block"]') });
  const originalFrame = () => widget.locator(':scope > [data-testid="widget-block"]').getByTestId('widget-frame').contentFrame();
  const runToken = await originalFrame().locator('section').getAttribute('data-run');
  await widget.getByTestId('widget-more').click();
  await page.getByTestId('widget-edit').click();
  await panel(widget).getByRole('textbox', { name: '修改要求', exact: true }).fill('做得更可视化，用变化对比说明系数的作用');
  plan({ edits: [{ search: 'missing', replace: 'broken' }] });
  await panel(widget).getByRole('button', { name: '生成局部修改', exact: true }).click();
  await panel(widget).getByRole('alert').filter({ hasText: '补丁位置' }).waitFor();
  const revisedWidget = widgetSource.replace('原来的交互图', '修改后的交互图');
  plan({ source: revisedWidget });
  await panel(widget).getByText('更多选项', { exact: true }).click();
  await panel(widget).getByRole('button', { name: '仅重生成此块', exact: true }).click();
  const preview = panel(widget).getByTestId('artifact-edit-preview');
  const previewFrame = () => preview.getByTestId('widget-frame').contentFrame();
  await previewFrame().getByText('修改后的交互图', { exact: true }).waitFor();
  assert.equal(await preview.getByTestId('widget-frame').getAttribute('sandbox'), 'allow-scripts');
  await previewFrame().getByRole('slider').fill('5');
  assert.equal(await originalFrame().getByRole('slider').inputValue(), '2', 'preview interaction never changes the original');
  assert.equal(await originalFrame().locator('section').getAttribute('data-run'), runToken, 'generating/previewing never remounts the original');
  assert.equal((await readRow()).widget.html, widgetSource);
  await preview.getByTestId('widget-more').click();
  await page.getByRole('menuitem', { name: '查看 HTML 源码', exact: true }).waitFor();
  assert.equal(await page.getByTestId('widget-open').count(), 0, 'preview has no popout');
  assert.equal(await page.getByTestId('widget-edit').count(), 0, 'preview has no editing control');
  await page.keyboard.press('Escape');
  const countBeforePreview = requests.length;
  const hostDenied = await previewFrame().locator('body').evaluate(() => { try { return !parent.document.body; } catch { return true; } });
  assert.ok(hostDenied);
  assert.equal(requests.length, countBeforePreview, 'preview does not request model tokens');
  await widget.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'e2e-shots/artifact-edit-desktop.png' });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    await panel(widget).scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px: no viewport overflow`);
    const bounds = await panel(widget).boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${width}px: panel is not clipped`);
    if (width === 390) await page.screenshot({ path: 'e2e-shots/artifact-edit-mobile.png' });
  }
  await panel(widget).getByRole('button', { name: '稍后再看', exact: true }).click();
  await widget.getByRole('button', { name: '查看修改', exact: true }).click();
  await previewFrame().getByText('修改后的交互图', { exact: true }).waitFor();
  await panel(widget).getByRole('button', { name: '应用修改', exact: true }).click();
  await panel(widget).waitFor({ state: 'hidden' });
  await staticBlock.getByRole('button', { name: '更多 HTML 操作' }).click();
  await page.getByRole('menuitem', { name: '撤销上次修改', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal((await readRow()).widget.html, revisedWidget);
  await originalFrame().getByText('修改后的交互图', { exact: true }).waitFor();
  await page.reload();
  await page.waitForFunction(async () => (await window.__artifactTestImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  await switchSession(sessionId);
  await page.getByTestId('html-answer').getByTestId('widget-frame').contentFrame().getByText('new static', { exact: true }).waitFor();
  assert.equal((await readRow()).widget.html, revisedWidget);
  const deletedId = await page.evaluate(async () => {
    const { db } = await window.__artifactTestImport('/src/store/db.ts');
    const sessionId = await db.chatSessions.add({ videoId: '__library_assistant__', title: '迟到结果保护', createdAt: Date.now() });
    const id = await db.chats.add({ sessionId, videoId: '__library_assistant__', role: 'assistant', content: '```diagram\n{"type":"plot","curves":[{"fn":"x"}]}\n```', createdAt: Date.now() });
    await (await window.__artifactTestImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(sessionId);
    return id;
  });
  const deletePending = plan({ edits: [{ search: '"fn":"x"', replace: '"fn":"sin(x)"' }] }, true);
  await begin(diagrams.last(), '测试生成期间删除原回答');
  await deletePending.received;
  await page.evaluate(async (id) => (await window.__artifactTestImport('/src/store/db.ts')).db.chats.delete(id), deletedId);
  await panel(diagrams.last()).getByRole('alert').filter({ hasText: '已被删除' }).waitFor();
  deletePending.release();
  assert.equal(await page.evaluate(async (id) => (await window.__artifactTestImport('/src/store/db.ts')).db.chats.get(id), deletedId), undefined, 'late generation must not recreate deleted messages');
  assert.deepEqual(errors, []);
  assert.equal(plans.length, 0);
  console.log('PASS: non-modal editing, parallel independent figures, collapse/session-switch survival, visual previews, explicit apply/undo, cancellation, invalid schema, isolated requests/sandbox, 320/390/768px layout and refresh persistence');
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) console.error((await page.locator('body').innerText()).slice(-5000));
  throw error;
} finally { await browser.close(); }
