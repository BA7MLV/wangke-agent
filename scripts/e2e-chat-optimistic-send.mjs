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
      const { useCourseChat, reflectCloudTasks } = await import('/src/store/courseChat.ts');
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
      const { useCourseChat } = await import('/src/store/courseChat.ts');
      return useCourseChat.getState().messages[0]?.key === 'cloud-user-ui-test-task';
    });
    assert.equal(await bubble.count(), 1);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: user message visible before sync; survives polling and acceptance without duplication`);
    await page.close();
  }
} finally {
  await browser.close();
}
