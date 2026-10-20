import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const shots = new URL('../e2e-shots/', import.meta.url);
await mkdir(shots, { recursive: true });
const examples = await readFile(new URL('../src/skills/builtin/interactive-explainer/references/examples.md', import.meta.url), 'utf8');
const html = examples.match(/```html\n([\s\S]*?)\n```/)[1]
  .replace('const api = window.__wbw;', `const api = window.__wbw;
    root.dataset.runToken = String(Math.random());
    api.sendPrompt('不得自动发送').catch(() => {});`)
  .replace('privateContent: null', `privateContent: {panel: 'PRIVATE_STATE_SENTINEL'}`);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.addInitScript(() => {
    if (window.top !== window) return;
    // A reused Vite server may timestamp app imports after HMR. Reuse those module instances.
    window.__widgetTestImport = (path) => {
      const resource = performance.getEntriesByType('resource').findLast((entry) => new URL(entry.name).pathname === path);
      return import(resource?.name ?? path);
    };
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      theme: 'light',
      providers: [{ id: 'test', name: 'Test', baseUrl: 'https://widget.test/v1', apiKey: 'test', serves: ['chat'], catalogId: 'siliconflow-cn' }],
      llmModel: { providerId: 'test', model: 'test-model' },
    } }));
  });
  await context.route('https://widget.test/**', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: 'text/event-stream', body:
      'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '这是当前参数的解释。' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n' });
  });
  await page.goto(BASE);
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).waitFor();
  await page.waitForFunction(async () => (await window.__widgetTestImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  const rowId = await page.evaluate(async (html) => {
    const { db } = await window.__widgetTestImport('/src/store/db.ts');
    const { useCourseChat } = await window.__widgetTestImport('/src/store/courseChat.ts');
    const sessionId = await db.chatSessions.add({ videoId: '__library_assistant__', title: '交互讲解状态测试', createdAt: Date.now() });
    const id = await db.chats.add({ sessionId, videoId: '__library_assistant__', role: 'assistant', content: '拖动系数，观察曲线变化。', createdAt: Date.now(), widget: { html } });
    await useCourseChat.getState().loadSession(sessionId);
    return id;
  }, html);
  const frame = () => page.getByTestId('widget-frame').contentFrame();
  const openPreview = async () => {
    await page.getByTestId('widget-more').click();
    await page.getByTestId('widget-open').click();
  };
  const input = () => frame().getByRole('slider');
  const readRow = () => page.evaluate(async (id) => (await window.__widgetTestImport('/src/store/db.ts')).db.chats.get(id), rowId);
  const setCoefficient = async (target, value) => {
    await target.evaluate((element, value) => {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(value));
  };
  await input().waitFor().catch(async (error) => {
    throw new Error(`${error.message}\nPage errors: ${JSON.stringify(errors)}\n${await page.locator('body').innerText()}`);
  });
  assert.equal(requests.length, 0, 'load cannot trigger a model request');
  assert.equal(await page.getByRole('dialog').count(), 0, 'on-load API follow-ups are rejected');
  assert.equal(await page.getByTestId('widget-frame').getAttribute('sandbox'), 'allow-scripts');
  const token = await frame().locator('section').getAttribute('data-run-token');
  await setCoefficient(input(), -2);
  await page.waitForFunction(async (id) => (await window.__widgetTestImport('/src/store/db.ts')).db.chats.get(id).then((row) => row.widgetState?.value.modelContent['系数 a'] === -2), rowId);
  assert.equal((await readRow()).widgetState.value.privateContent.panel, 'PRIVATE_STATE_SENTINEL');
  assert.equal(requests.length, 0, 'parameter changes are entirely local');
  await page.evaluate(async () => (await window.__widgetTestImport('/src/store/settings.ts')).useSettings.getState().update({ theme: 'dark' }));
  await frame().locator('html[data-wbw-theme="dark"]').waitFor();
  assert.equal(await input().inputValue(), '-2');
  assert.equal(await frame().locator('section').getAttribute('data-run-token'), token, 'theme changes must retain the iframe');
  await page.screenshot({ path: new URL('widget-state-dark.png', shots).pathname });

  const popupPromise = page.waitForEvent('popup');
  await openPreview();
  const popup = await popupPromise;
  const preview = popup.getByTestId('widget-frame').contentFrame();
  await preview.getByRole('slider').waitFor();
  assert.equal(await preview.getByRole('slider').inputValue(), '-2');
  await setCoefficient(preview.getByRole('slider'), 2.5);
  await frame().locator('output').filter({ hasText: '2.50' }).waitFor();
  assert.equal(await frame().locator('section').getAttribute('data-run-token'), token, 'state sync must not remount the original');
  await preview.getByRole('button', { name: '解释当前情况' }).click();
  await popup.getByTestId('widget-follow-up-dialog').waitFor();
  assert.equal(requests.length, 0);
  await popup.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await popup.close();

  // Forged host-origin messages are not from the opaque widget and must be ignored.
  await page.evaluate(() => window.postMessage({ __wbw: 'wbw:state', payload: { requestId: 999, value: { modelContent: { a: 99 } } } }, '*'));
  assert.equal((await readRow()).widgetState.value.modelContent['系数 a'], 2.5);
  await frame().getByRole('button', { name: '解释当前情况' }).click();
  await page.getByTestId('widget-follow-up-dialog').waitFor();
  assert.equal(requests.length, 0, 'opening confirmation must not call the model');
  assert.ok((await page.getByTestId('widget-follow-up-state').textContent()).includes('2.5'));
  assert.ok(!(await page.getByRole('dialog').textContent()).includes('PRIVATE_STATE_SENTINEL'));
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(requests.length, 0, 'cancellation spends no tokens');

  await page.setViewportSize({ width: 320, height: 780 });
  await input().scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile host must not overflow');
  assert.ok(await frame().locator('body').evaluate((element) => element.scrollWidth <= innerWidth), 'mobile widget must not overflow');
  await frame().getByRole('button', { name: '解释当前情况' }).click();
  await page.getByTestId('widget-follow-up-dialog').waitFor();
  await page.getByRole('textbox', { name: '交互讲解追问' }).fill('解释当前参数为何改变开口');
  await page.screenshot({ path: new URL('widget-follow-up-mobile.png', shots).pathname });
  await page.getByRole('dialog').getByRole('button', { name: '发送追问', exact: true }).click();
  await page.getByText('这是当前参数的解释。', { exact: true }).waitFor();
  assert.equal(requests.length, 1);
  const sent = JSON.stringify(requests[0]);
  assert.ok(sent.includes('2.5') && sent.includes('不可信数据'));
  assert.ok(!sent.includes('PRIVATE_STATE_SENTINEL') && !sent.includes('quadratic-explorer'), 'follow-ups include parameters, not private state or widget source');
  await page.reload();
  await page.waitForFunction(async () => (await window.__widgetTestImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  await page.evaluate(async (id) => {
    const { db } = await window.__widgetTestImport('/src/store/db.ts');
    await (await window.__widgetTestImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession((await db.chats.get(id)).sessionId);
  }, rowId);
  await input().waitFor();
  assert.equal(await input().inputValue(), '2.5', 'refresh restores persisted parameters');
  assert.equal(requests.length, 1, 'restoration must not create more model requests');
  const frameElement = page.getByTestId('widget-frame');
  const badState = await frameElement.contentFrame().locator('section').evaluate(async () => {
    try { await window.__wbw.setWidgetState({ modelContent: { a: Infinity } }); return false; }
    catch { return true; }
  });
  assert.equal(badState, true);
  assert.equal((await readRow()).widgetState.value.modelContent['系数 a'], 2.5);
  await page.evaluate(async () => {
    const { db } = await window.__widgetTestImport('/src/store/db.ts');
    const update = db.chats.update;
    db.chats.update = () => {
      db.chats.update = update;
      return Promise.reject(new Error('测试：存储空间不足'));
    };
  });
  const failedSave = await frame().locator('section').evaluate(async () => {
    try { await window.__wbw.setWidgetState({ modelContent: { a: 1 }, privateContent: null }); return ''; }
    catch (error) { return error.message; }
  });
  assert.ok(failedSave.includes('存储空间不足'), 'storage errors reject the bridge Promise');
  await page.getByRole('alert').filter({ hasText: '存储空间不足' }).waitFor();
  assert.equal((await readRow()).widgetState.value.modelContent['系数 a'], 2.5, 'failed writes preserve the last committed snapshot');
  await frame().locator('section').evaluate(() => window.__wbw.setWidgetState({ modelContent: { '系数 a': 2.5 }, privateContent: { panel: 'PRIVATE_STATE_SENTINEL' } }));
  assert.equal((await readRow()).widgetState.value.modelContent['系数 a'], 2.5, 'a resolved save is already durable');

  const forkState = await page.evaluate(async (id) => {
    const { db } = await window.__widgetTestImport('/src/store/db.ts');
    const { useCourseChat } = await window.__widgetTestImport('/src/store/courseChat.ts');
    const original = await db.chats.get(id);
    const forkId = await useCourseChat.getState().forkSession(original.sessionId, id);
    const rows = await db.chats.where('sessionId').equals(forkId).toArray();
    await useCourseChat.getState().loadSession(original.sessionId);
    return { forkId, hasWidget: rows.some((row) => row.widget), hasSnapshot: rows.some((row) => row.widgetState) };
  }, rowId);
  assert.ok(forkState.forkId && forkState.hasWidget && !forkState.hasSnapshot, 'forks preserve the explainer, not the original UI snapshot');

  const nextPopup = page.waitForEvent('popup');
  await openPreview();
  const followUpPreview = await nextPopup;
  const previewFrame = followUpPreview.getByTestId('widget-frame').contentFrame();
  await previewFrame.getByRole('button', { name: '解释当前情况' }).click();
  await followUpPreview.getByTestId('widget-follow-up-dialog').waitFor();
  await followUpPreview.getByRole('dialog').getByRole('button', { name: '发送追问', exact: true }).click();
  await followUpPreview.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(async () => !(await window.__widgetTestImport('/src/store/courseChat.ts')).useCourseChat.getState().loading);
  assert.equal(requests.length, 2, 'confirmed preview prompts reach the original conversation exactly once');
  assert.ok(!JSON.stringify(requests[1]).includes('PRIVATE_STATE_SENTINEL'));
  // The popout stays useful for local controls, but must not claim a lost follow-up was sent.
  await page.close();
  try {
    await previewFrame.getByRole('button', { name: '解释当前情况' }).click();
    await followUpPreview.getByRole('dialog').getByRole('button', { name: '发送追问', exact: true }).click();
    await followUpPreview.getByRole('alert').filter({ hasText: '原会话没有响应' }).waitFor();
  } catch (error) {
    await followUpPreview.screenshot({ path: new URL('widget-preview-debug.png', shots).pathname });
    console.log('Preview after origin closed:', await followUpPreview.locator('body').innerText());
    throw error;
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(errors, []);
  console.log('PASS: real CourseChat + skill example, local-only parameters, persistence ACK/errors, theme retention, popout sync/follow-up ACK, confirmation/cancel/private isolation, 320px and refresh.');
} finally { await browser.close(); }
