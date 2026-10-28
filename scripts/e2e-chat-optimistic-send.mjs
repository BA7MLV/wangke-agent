import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
    await page.goto(process.env.BASE_URL || 'http://127.0.0.1:5196');
    const input = page.locator('textarea[aria-label="给 AI 助手发送消息"]');
    await input.waitFor();
    await page.evaluate(async () => {
      const storeUrl = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === '/src/store/courseChat.ts')?.name;
      window.__chatModule = await import(storeUrl || '/src/store/courseChat.ts');
      const { cloud } = await import('/src/cloud/state.ts');
      const { applyCloudConfig } = await import('/src/cloud/sync.ts');
      cloud.enabled = true;
      const model = { providerId: '', model: '' };
      applyCloudConfig({ providers: [], llmModel: model, visionModel: model, asrModel: model, policy: { maxSteps: 100 } });
      const nativeFetch = window.fetch.bind(window);
      // Hold every sync / submission request until the assertions release it.
      window.__releaseSend = null;
      const hold = new Promise(resolve => { window.__releaseSend = resolve; });
      window.fetch = async (url, init) => {
        if (typeof url === 'string' && url.includes('/api/v1/cloud/records?')) {
          await hold;
          return Response.json({ records: [], cursor: 0, more: false });
        }
        if (typeof url === 'string' && url.endsWith('/api/v1/cloud/tasks') && init?.method === 'POST') {
          const body = JSON.parse(init.body);
          return Response.json({ id: 'ui-test-task', kind: 'chat', status: 'queued', input: body.input, resource: body.resource,
            progress: null, result: null, error: null, createdAt: new Date().toISOString() });
        }
        return nativeFetch(url, init);
      };
    });
    const text = `发送后立刻可见 ${width}`;
    await input.fill(text);
    await page.getByTestId('chat-send').click();
    const bubble = page.locator('.course-chat__bubble--user').filter({ hasText: text });
    // The request is still blocked: seeing the turn cannot depend on a response.
    await bubble.waitFor({ timeout: 3000 });
    assert.equal(await input.inputValue(), '');
    const state = await page.evaluate(async () => {
      const { useCourseChat, reflectCloudTasks } = window.__chatModule;
      await reflectCloudTasks([], true);
      const { messages, loading } = useCourseChat.getState();
      return { messages, loading };
    });
    assert.equal(state.messages.length, 2);
    assert.equal(state.loading, true);
    assert.equal(state.messages[1].streaming, true);
    assert.equal(state.messages[1].processPhase, 'preparing');
    assert.equal(await bubble.isVisible(), true);
    assert.equal(await bubble.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    }), true, 'the sent bubble must be inside the viewport');
    await page.evaluate(() => window.__releaseSend());
    await page.waitForFunction(async () => {
      const { useCourseChat } = window.__chatModule;
      return useCourseChat.getState().messages[0]?.taskId === 'ui-test-task';
    });
    assert.equal(await bubble.count(), 1);
    await page.evaluate(async () => {
      const { useCourseChat, reflectCloudTasks } = window.__chatModule;
      const state = useCourseChat.getState();
      window.__completionKeys = state.messages.map(message => message.key);
      window.__completionTask = { id: 'ui-test-task', kind: 'chat', status: 'running',
        input: { sessionId: state.activeId, text: state.messages[0].content },
        progress: { content: '完成同步也不能抢走阅读位置。\n\n'.repeat(80) }, result: null, error: null, createdAt: new Date().toISOString() };
      await reflectCloudTasks([window.__completionTask]);
      window.__emptyFrames = 0;
      window.__watchCompletion = true;
      const record = () => {
        if (!window.__watchCompletion) return;
        if (document.querySelector('.course-chat__empty') || document.querySelector('.course-chat--empty')) window.__emptyFrames++;
        requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });
    const list = page.getByTestId('course-chat-messages');
    await page.waitForFunction(() => document.querySelector('[data-testid="course-chat-messages"]')?.textContent.includes('完成同步也不能抢走阅读位置'));
    const settle = () => page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); });
    await settle();
    await list.evaluate(element => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: 150, bubbles: true }));
      element.scrollTop = Math.min(element.scrollTop + 150, (element.scrollHeight - element.clientHeight) / 2);
    });
    await settle();
    const top = await list.evaluate(element => element.scrollTop);
    await page.evaluate(async () => {
      const { reflectCloudTasks } = window.__chatModule;
      window.__answerNode = document.querySelector('[data-chat-message="' + window.__completionKeys[1] + '"]');
      window.__completionTask = { ...window.__completionTask, status: 'completed',
        result: { content: window.__completionTask.progress.content, rowId: 90002, userRowId: 90001 } };
      await reflectCloudTasks([window.__completionTask]);
    });
    await page.getByTestId('chat-sync-status').waitFor(); // deliberately delayed record sync
    const completedTop = await list.evaluate(element => element.scrollTop);
    assert(Math.abs(completedTop - top) < 2, `completion keeps manual reading position (${top} -> ${completedTop})`);
    const readingAnchor = () => page.evaluate(() => {
      const node = document.querySelector('[data-chat-message="' + window.__completionKeys[1] + '"]');
      return (node.querySelector('[data-chat-answer-start]') ?? node).getBoundingClientRect().top;
    });
    const anchorTop = await readingAnchor();
    await page.evaluate(async () => {
      const { useCloudSync } = await import('/src/cloud/sync.ts');
      useCloudSync.setState({ error: '模拟同步失败' });
    });
    await page.getByRole('button', { name: '重试同步', exact: true }).click();
    await page.evaluate(async () => {
      const { db } = await import('/src/store/db.ts');
      const { reflectCloudTasks } = window.__chatModule;
      const task = window.__completionTask;
      await db.chats.bulkAdd([
        { id: 90001, taskId: task.id, sessionId: task.input.sessionId, videoId: '__library_assistant__', role: 'user', content: task.input.text, createdAt: Date.now() },
        { id: 90002, taskId: task.id, sessionId: task.input.sessionId, videoId: '__library_assistant__', role: 'assistant', content: task.result.content, createdAt: Date.now() + 1 },
      ]);
      await reflectCloudTasks([task], true);
    });
    await page.getByTestId('chat-sync-status').waitFor({ state: 'hidden' });
    const completion = await page.evaluate(async () => {
      const { useCourseChat } = window.__chatModule;
      window.__watchCompletion = false;
      return { keys: useCourseChat.getState().messages.map(message => message.key), expectedKeys: window.__completionKeys,
        emptyFrames: window.__emptyFrames, sameNode: window.__answerNode === document.querySelector('[data-chat-message="' + window.__completionKeys[1] + '"]') };
    });
    assert.deepEqual(completion.keys, completion.expectedKeys);
    assert.equal(completion.emptyFrames, 0, 'welcome screen never appears during completion/sync');
    assert.equal(completion.sameNode, true, 'answer DOM is preserved through persistence');
    await settle();
    const syncedAnchor = await readingAnchor();
    assert(Math.abs(syncedAnchor - anchorTop) < 2, `sync keeps the text at the same visual position (${anchorTop} -> ${syncedAnchor})`);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: stable bubble identity; delayed completion sync; retry; no welcome frames; reading position preserved`);
    await page.close();
  }
} finally {
  await browser.close();
}
