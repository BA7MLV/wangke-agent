import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (window.top !== window) return;
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      providers: [{ id: 'test', name: 'Test', baseUrl: 'https://artifact.test/v1', apiKey: 'test', serves: ['chat'], catalogId: 'siliconflow-cn' }],
      llmModel: { providerId: 'test', model: 'test-model' },
    } }));
  });
  const requests = [];
  let response = { edits: [{ search: 'x^2', replace: 'sin(x)' }] };
  let holdNext = false;
  let releaseRequest;
  await page.route('https://artifact.test/**', async (route) => {
    requests.push(route.request().postDataJSON());
    if (holdNext) {
      holdNext = false;
      await new Promise((resolve) => { releaseRequest = resolve; });
    }
    await route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: JSON.stringify(response) } }] } });
  });
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).waitFor();
  const initial = '保留正文 SECRET_OTHER_CONTENT\n\n```diagram title="函数"\n{"type":"plot","curves":[{"fn":"x^2"}]}\n```\n\n保留另一张图\n```diagram\n{"type":"chart","kind":"bar","data":[{"label":"不改","value":4}]}\n```\n\n```html\n<p>old static</p>\n```';
  const rowId = await page.evaluate(async (content) => {
    const { db } = await import('/src/store/db.ts');
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    const sessionId = await db.chatSessions.add({ videoId: '__library_assistant__', title: '独立修改测试', createdAt: Date.now() });
    const rowId = await db.chats.add({ sessionId, videoId: '__library_assistant__', role: 'assistant', content, createdAt: Date.now(),
      widget: { html: '<p>old widget</p><script>window.widgetRuns = 1;</script>' } });
    await useCourseChat.getState().loadSession(sessionId);
    return rowId;
  }, initial);
  const readRow = () => page.evaluate(async (id) => (await import('/src/store/db.ts')).db.chats.get(id), rowId);
  const diagrams = page.locator('[data-testid="editable-artifact"]').filter({ has: page.locator('[data-testid="diagram-block"]') });
  await diagrams.first().getByRole('button', { name: '修改此图', exact: true }).click();
  await page.getByRole('textbox', { name: '修改要求', exact: true }).fill('把曲线改为 sin(x)');
  await page.getByRole('button', { name: '生成局部修改', exact: true }).click();
  await page.getByRole('button', { name: '应用修改', exact: true }).waitFor();
  assert.equal((await readRow()).content, initial, 'generation must not auto-save');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages.length, 2);
  assert.ok(!JSON.stringify(requests[0]).includes('SECRET_OTHER_CONTENT'));
  assert.ok(!JSON.stringify(requests[0]).includes('old widget'));
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await page.getByTestId('artifact-edit-dialog').waitFor({ state: 'hidden' });
  assert.equal((await readRow()).content, initial.replace('x^2', 'sin(x)'));
  await diagrams.first().getByRole('button', { name: '撤销上次修改' }).click();
  await page.waitForFunction(async ({ id, initial }) => (await import('/src/store/db.ts')).db.chats.get(id).then((r) => r.content === initial), { id: rowId, initial });

  await diagrams.first().getByRole('button', { name: '修改此图', exact: true }).click();
  await page.getByRole('textbox', { name: '修改要求', exact: true }).fill('测试拒绝坏 schema');
  response = { edits: [{ search: '"type":"plot"', replace: '"type":"invalid"' }] };
  await page.getByRole('button', { name: '生成局部修改', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal((await readRow()).content, initial);
  await page.getByTestId('artifact-edit-dialog').getByRole('button', { name: '取消', exact: true }).click();
  await diagrams.first().getByRole('button', { name: '修改此图', exact: true }).click();
  await page.getByRole('textbox', { name: '修改要求', exact: true }).fill('测试取消生成');
  holdNext = true;
  const pending = page.waitForRequest('https://artifact.test/**');
  await page.getByRole('button', { name: '生成局部修改', exact: true }).click();
  await pending;
  await page.getByRole('button', { name: '取消生成', exact: true }).click();
  releaseRequest();
  await page.getByTestId('artifact-edit-dialog').waitFor({ state: 'hidden' });
  assert.equal((await readRow()).content, initial);

  const staticBlock = page.locator('[data-testid="editable-artifact"]').filter({ has: page.locator('[data-testid="widget-stream-preview"]') });
  await staticBlock.getByRole('button', { name: '修改此 HTML' }).click();
  await page.getByRole('textbox', { name: '修改要求', exact: true }).fill('改标题');
  response = { edits: [{ search: 'old static', replace: 'new static' }] };
  await page.getByRole('button', { name: '生成局部修改', exact: true }).click();
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await page.getByTestId('artifact-edit-dialog').waitFor({ state: 'hidden' });
  assert.equal((await readRow()).content, initial.replace('old static', 'new static'));
  await staticBlock.getByText('new static', { exact: true }).waitFor();

  const widget = page.locator('[data-testid="editable-artifact"]').filter({ has: page.locator('[data-testid="widget-block"]') });
  await widget.getByTestId('widget-more').click();
  await page.getByTestId('widget-edit').click();
  await page.getByRole('textbox', { name: '修改要求', exact: true }).fill('改 widget 标题');
  response = { edits: [{ search: 'missing', replace: 'broken' }] };
  await page.getByRole('button', { name: '生成局部修改', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '补丁位置' }).waitFor();
  assert.ok((await readRow()).widget.html.includes('old widget'));
  response = { source: '<style>p{color:inherit}</style><p>new widget</p><script>window.widgetRuns = 2;</script>' };
  await page.getByRole('button', { name: '仅重生成此块', exact: true }).click();
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await page.getByTestId('artifact-edit-dialog').waitFor({ state: 'hidden' });
  assert.equal((await readRow()).widget.html, response.source);
  const iframe = widget.locator('iframe');
  assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
  await iframe.contentFrame().getByText('new widget', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await widget.getByTestId('widget-more').click();
  await page.getByTestId('widget-edit').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'e2e-shots/artifact-edit-mobile.png' });
  await page.keyboard.press('Escape');
  await page.getByTestId('artifact-edit-dialog').waitFor({ state: 'hidden' });
  await page.reload();
  await page.evaluate(async (id) => {
    const { db } = await import('/src/store/db.ts');
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    await useCourseChat.getState().loadSession((await db.chats.get(id)).sessionId);
  }, rowId);
  await page.locator('[data-testid="widget-stream-preview"]').getByText('new static', { exact: true }).waitFor();
  assert.equal((await readRow()).widget.html, response.source);
  assert.deepEqual(errors, []);
  console.log('PASS: actual CourseChat, isolated requests, patch/apply/undo, invalid schema, cancellation, HTML fences, widget fallback/sandbox, mobile dialog, refresh persistence');
} finally { await browser.close(); }
