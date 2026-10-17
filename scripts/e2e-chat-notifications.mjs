import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') console.error(message.text()); });
  page.on('pageerror', (error) => errors.push(error.stack));
  await page.addInitScript(() => {
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      providers: [{ id: 'test', name: 'Test', baseUrl: 'https://example.test/v1', apiKey: 'test', serves: ['chat'], catalogId: '' }],
      llmModel: { providerId: 'test', model: 'test-model' },
      visionModel: { providerId: 'test', model: 'test-model' },
      asrModel: { providerId: 'test', model: 'test-model' },
    } }));
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.includes('/chat/completions')) return nativeFetch(input, init);
      return new Response(new ReadableStream({
        start(controller) {
          window.finishChat = () => {
            const data = { choices: [{ delta: { content: '完成的回答' } }] };
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`));
            controller.close();
          };
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
  await page.goto(process.env.BASE_URL || 'http://localhost:5185');
  await page.evaluate(async () => {
    const source = await (await fetch('/src/pages/CourseChat.tsx')).text();
    window.chatStoreUrl = source.match(/from "([^"]*\/store\/courseChat\.ts[^"]*)"/)[1];
  });
  await page.locator('textarea').waitFor().catch(async (error) => {
    console.error(errors, await page.locator('body').innerText());
    throw error;
  });
  const send = (text) => page.evaluate(async (content) => {
    window.finishChat = null;
    const { useCourseChat } = await import(window.chatStoreUrl);
    await useCourseChat.getState().bootstrap();
    window.pendingTurn = useCourseChat.getState().send(content);
    window.pendingTurn.then(() => {
      if (!window.finishChat) console.error('No model request', JSON.stringify(useCourseChat.getState().messages));
    });
  }, text);
  const finish = async () => {
    await page.waitForFunction(() => typeof window.finishChat === 'function');
    await page.evaluate(async () => { window.finishChat(); await window.pendingTurn; });
  };
  await send('后台完成提醒');
  await page.waitForFunction(() => typeof window.finishChat === 'function');
  const id = await page.evaluate(async () => {
    const { useCourseChat } = await import(window.chatStoreUrl);
    const id = useCourseChat.getState().activeId;
    await useCourseChat.getState().createSession();
    return id;
  });
  await finish();
  await page.getByTestId('nav-unread-dot').waitFor();
  await page.getByTestId(`chat-recent-${id}-unread`).waitFor();
  await page.getByTestId('nav-rail-toggle').click();
  await page.getByTestId('nav-unread-dot').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('nav-rail-open').click();
  await page.getByRole('dialog', { name: 'DeepStudent' }).waitFor();
  await page.getByTestId(`chat-recent-${id}-unread`).waitFor();
  assert.equal(await page.getByTestId('nav-unread-dot').count(), 1);
  await page.getByTestId(`chat-recent-${id}`).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="nav-unread-dot"]'));
  await send('当前正在查看，无需提醒');
  await finish();
  assert.equal(await page.getByTestId('nav-unread-dot').count(), 0);
  // 资料页的 activeId 没变，也应提示，并跨刷新保留。
  await send('在资料页等待');
  await page.waitForFunction(() => typeof window.finishChat === 'function');
  await page.evaluate(() => { location.hash = '#/library'; });
  await page.getByTestId('page-title').filter({ hasText: '资料' }).waitFor();
  await finish();
  await page.getByTestId('nav-unread-dot').waitFor();
  await page.reload();
  await page.evaluate(async () => {
    const source = await (await fetch('/src/pages/CourseChat.tsx')).text();
    window.chatStoreUrl = source.match(/from "([^"]*\/store\/courseChat\.ts[^"]*)"/)[1];
  });
  await page.getByTestId('nav-unread-dot').waitFor();
  await page.getByTestId('nav-rail-open').click();
  await page.getByTestId(`chat-recent-${id}-unread`).waitFor();
  await page.getByTestId(`chat-recent-${id}`).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="nav-unread-dot"]'));
  await page.evaluate(async (id) => {
    const { useChatNotifications } = await import('/src/store/chatNotifications.ts');
    const { useCourseChat } = await import(window.chatStoreUrl);
    useChatNotifications.getState().setViewing(null);
    useChatNotifications.getState().complete(id);
    await useCourseChat.getState().setArchived(id, true);
    if (useChatNotifications.getState().unreadIds.length) throw new Error('Archived notification retained');
    await useCourseChat.getState().setArchived(id, false);
    useChatNotifications.getState().complete(id);
    await useCourseChat.getState().deleteSessionById(id);
    if (useChatNotifications.getState().unreadIds.length) throw new Error('Deleted notification retained');
  }, id);
  assert.deepEqual(errors, []);
  console.log('PASS background completion; desktop/mobile dots; DeepStudent heading; drawer preserves unread; viewing clears; foreground completion; library completion; reload persistence; archive/delete cleanup');
} finally {
  await browser.close();
}
