import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4181';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const instructions = '# 回答偏好\n- 先举例，再推导。\n- Please answer in English.';

try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      locale: 'zh-CN',
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    await context.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
    await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
    await context.addInitScript(() => {
      if (!localStorage.getItem('wangke-settings')) localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: {
        uiLanguage: 'zh-CN',
        providers: [{ id: 'test', name: 'Test', baseUrl: 'https://agent-instructions.test/v1', apiKey: 'fake-test-key', serves: ['chat'], catalogId: '' }],
        llmModel: { providerId: 'test', model: 'test-model' },
      } }));
      window.__agentTestImport = (path) => {
        const resource = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
        return import(resource?.name ?? path);
      };
    });
    const requests = [];
    await context.route('https://agent-instructions.test/**', route => {
      const body = route.request().postDataJSON();
      if (!body.stream) return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: '测试对话' } }] } });
      requests.push(body);
      return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '测试回答已完成。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${BASE}/#/settings/agent`);
    const input = page.getByTestId('agent-instructions');
    await input.waitFor();
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.getByTestId('agent-instructions-reset').isDisabled(), true);
    await input.fill(instructions);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings')).state.agentInstructions), instructions);
    await page.getByTestId('settings-nav-appearance').click();
    await page.getByTestId('card-appearance').waitFor();
    await page.getByTestId('settings-nav-agent').click();
    assert.equal(await input.inputValue(), instructions);
    await page.reload();
    await input.waitFor();
    assert.equal(await input.inputValue(), instructions);
    const overflow = await page.getByTestId('settings-modal').evaluate(node => node.scrollWidth > node.clientWidth + 1);
    assert.equal(overflow, false);
    await page.getByTestId('agent-instructions-reset').click();
    await page.getByTestId('confirm-dialog-cancel').click();
    assert.equal(await input.inputValue(), instructions);
    await page.getByTestId('agent-instructions-reset').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings')).state.agentInstructions), '');
    await page.reload();
    await input.waitFor();
    assert.equal(await input.inputValue(), '');
    console.log(`OK: ${mobile ? 'mobile' : 'desktop'} navigation, editing, autosave, reload, reset cancellation and confirmation, no overflow`);
    if (!mobile) {
      const send = async text => {
        const composer = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
        await composer.fill(text);
        const response = page.waitForResponse(response => response.url().startsWith('https://agent-instructions.test/') && response.request().postDataJSON()?.stream === true);
        await composer.press('Enter');
        await response;
        await page.waitForFunction(async () => !(await window.__agentTestImport('/src/store/courseChat.ts')).useCourseChat.getState().loading);
      };
      await input.fill(instructions);
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      await send('请解释一个概念。');
      assert.equal(requests.length, 1);
      assert.ok(requests[0].messages[0].content.endsWith(instructions));
      await page.evaluate(() => { location.hash = '/settings/agent'; });
      await input.fill('新版指令：先给一个例子。');
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      await send('继续解释。');
      assert.equal(requests.length, 2);
      assert.ok(requests[1].messages[0].content.endsWith('新版指令：先给一个例子。'));
      assert.ok(!requests[1].messages[0].content.includes(instructions));
      await page.evaluate(async () => {
        const { runQa } = await window.__agentTestImport('/src/harness/qaRunner.ts');
        await runQa({ videoId: 'test-video', sessionId: 7000, text: '解释视频内容。' });
        await runQa({ videoId: 'test-pdf', sessionId: 7001, text: '解释文档内容。', materialKind: 'page', materialFormat: 'pdf' });
      });
      assert.equal(requests.length, 4);
      for (const request of requests.slice(2)) assert.ok(request.messages[0].content.endsWith('新版指令：先给一个例子。'));
      await page.evaluate(() => { location.hash = '/settings/agent'; });
      await input.fill('');
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      await send('恢复默认后再解释。');
      assert.equal(requests.length, 5);
      assert.ok(!requests[4].messages[0].content.includes('## 用户设置的 Agent 默认提示词'));
      console.log('OK: actual model requests include current instructions for library/video/PDF; an existing conversation picks up edits and resets');
    }
    if (await page.getByTestId('settings-modal').isVisible()) {
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      await page.getByTestId('settings-modal').waitFor({ state: 'hidden' });
    }
    await page.goto(`${BASE}/#/library`);
    const file = page.getByTestId('agent-instructions-file');
    const systemFolder = page.getByTestId('system-folder');
    await systemFolder.waitFor();
    assert.equal(await file.count(), 0, 'the file is not shown at the library root');
    const open = async (item) => mobile ? item.tap() : item.dblclick();
    await open(systemFolder);
    await file.waitFor();
    assert.equal(await systemFolder.count(), 0);
    assert.equal(await page.getByTestId('btn-new-folder').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '导入资料', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('navigation', { name: '资料路径' }).getByRole('button', { name: 'system', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '后退', exact: true }).click();
    await systemFolder.waitFor();
    assert.equal(await file.count(), 0);
    await page.getByRole('button', { name: '前进', exact: true }).click();
    await file.waitFor();
    await open(file);
    await page.getByTestId('agent-instructions-file-dialog').waitFor();
    await input.fill('资料中修改：先画图再讲解。');
    await page.getByTestId('agent-file-close').click();
    await page.getByTestId('agent-instructions-file-dialog').waitFor({ state: 'hidden' });
    await page.evaluate(async () => (await window.__agentTestImport('/src/components/settingsDialogStore.ts')).openSettings('agent'));
    await input.waitFor();
    assert.equal(await input.inputValue(), '资料中修改：先画图再讲解。');
    await input.fill('设置中修改：先给结论。');
    await page.getByTestId('agent-instructions-open-file').click();
    await page.getByTestId('settings-modal').waitFor({ state: 'hidden' });
    await page.getByTestId('agent-instructions-file-dialog').waitFor();
    assert.equal(await input.inputValue(), '设置中修改：先给结论。');
    const result = await page.evaluate(async () => {
      const { createResourceExecutor } = await window.__agentTestImport('/src/harness/resources.ts');
      const execute = createResourceExecutor();
      const before = await execute('read', { path: '/system/AGENTS.md' });
      const edit = await execute('edit', { path: '/system/AGENTS.md', edits: [{ old_string: '先给结论', new_string: '先举例' }] });
      const after = await execute('read', { path: '/system/AGENTS.md' });
      return { before, edit, after };
    });
    assert.match(result.before, /先给结论/);
    assert.match(result.edit, /已保存/);
    assert.match(result.after, /先举例/);
    assert.equal(await input.inputValue(), '设置中修改：先举例。');
    await page.reload();
    await input.waitFor();
    assert.equal(await input.inputValue(), '设置中修改：先举例。');
    await page.getByTestId('agent-file-close').click();
    await page.getByTestId('agent-instructions-file-dialog').waitFor({ state: 'hidden' });
    await page.getByTestId('library-search').fill('AGENTS.md');
    await file.waitFor();
    await page.getByRole('radio', { name: '列表视图', exact: true }).click();
    await file.waitFor();
    assert.equal(await file.isVisible(), true);
    assert.equal(await page.getByTestId('video-list').evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
    await page.getByRole('navigation', { name: '资料路径' }).getByRole('button', { name: '全部资料', exact: true }).click();
    await systemFolder.waitFor();
    await page.getByTestId('library-search').fill('AGENTS.md');
    await systemFolder.waitFor();
    assert.equal(await file.count(), 0);
    await open(systemFolder);
    await file.waitFor();
    await page.reload();
    await file.waitFor();
    assert.equal(await systemFolder.count(), 0, 'refresh keeps the system directory open');
    console.log(`OK: ${mobile ? 'mobile' : 'desktop'} /system directory, history, persistence, two-way editing, live Agent edits, deep-link reload, search and list view`);
    await context.close();
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
} finally {
  await browser.close();
}
