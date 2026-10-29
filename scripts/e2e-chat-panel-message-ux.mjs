import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// E2E：播放页「学习助手 → 问答」的消息交互必须与主页 AI 助手一致：
// 操作行（复制 / 重试 / 分支 / 更多）、用户气泡长按菜单、重试语义与分支。
const BASE = process.env.BASE_URL || 'http://localhost:5173';
const FAKE_API = 'https://fake.local/v1';

const installFakeModel = async (context) => {
  await context.addInitScript((baseUrl) => {
    localStorage.setItem('wangke-settings', JSON.stringify({
      state: {
        providers: [{ id: 'sf', name: 'fake', baseUrl, apiKey: 'test-key', serves: ['chat', 'vision', 'asr'], catalogId: 'siliconflow-cn' }],
        llmModel: { providerId: 'sf', model: 'test-model' },
        visionModel: { providerId: 'sf', model: 'test-model' },
        asrModel: { providerId: 'sf', model: 'test-model' },
        contextWindow: 32768,
        agentRounds: 6,
      },
      version: 0,
    }));
    let seq = 0;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.includes('/chat/completions')) return nativeFetch(input, init);
      if (window.__failNextPanelRequest) {
        const prefix = window.__failNextPanelRequest;
        delete window.__failNextPanelRequest;
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: prefix }, finish_reason: 'error' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      seq++;
      const text = `第 ${seq} 次回答`;
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
  }, FAKE_API);
};

const seed = async (page) => {
  await page.goto(BASE);
  await page.locator('textarea').waitFor();
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const videoId = 'panel-ux-test';
    await db.videos.put({
      id: videoId, name: '面板交互课程', size: 1, mimeType: 'video/mp4',
      duration: 100, createdAt: Date.now(), status: 'transcribed',
    });
    await db.segments.add({ videoId, idx: 0, start: 0, end: 5, text: '测试字幕', status: 1 });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(17, 39, 0, 0);
    const sessionId = await db.chatSessions.add({ videoId, title: '面板交互', createdAt: yesterday.getTime() });
    await db.chats.bulkAdd([
      { videoId, sessionId, role: 'user', content: '帮我整理复习重点', createdAt: yesterday.getTime() },
      { videoId, sessionId, role: 'assistant', content: '## 复习重点\n\n先复习核心概念，再做练习。', createdAt: yesterday.getTime() + 1000 },
    ]);
  });
};

const openPanelChat = async (page) => {
  await page.goto(`${BASE}/#/player/panel-ux-test`);
  await page.getByTestId('study-assistant-toggle').waitFor({ state: 'attached' });
  const tab = page.locator('[data-testid="panel-tab-chat"]');
  if (!(await tab.isVisible().catch(() => false))) {
    await page.getByTestId('study-assistant-toggle').click();
  }
  await tab.click();
};

const rows = (page) => page.evaluate(async () => {
  const { db } = await import('/src/store/db.ts');
  const session = (await db.chatSessions.toArray()).find((s) => s.title === '面板交互');
  return (await db.chats.where('sessionId').equals(session.id).sortBy('createdAt'))
    .map((r) => ({ role: r.role, content: r.content }));
});

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await installFakeModel(desktop);
const page = await desktop.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await seed(page);
  await openPanelChat(page);
  await page.getByText('复习重点', { exact: false }).first().waitFor();

  const messages = page.getByTestId('chat-message-actions');
  assert.equal(await messages.count(), 2, '用户与助手各有一条操作行');

  const aiMsg = page.locator('.chat-msg--ai').last();
  const userMsg = page.locator('.chat-msg--user').last();
  assert.equal(await aiMsg.locator('[data-testid="chat-message-actions"]').evaluate((el) => getComputedStyle(el).opacity), '0');
  await aiMsg.hover();
  await page.waitForTimeout(250);
  assert.equal(await aiMsg.locator('[data-testid="chat-message-actions"]').evaluate((el) => getComputedStyle(el).opacity), '1');
  for (const id of ['chat-copy-message', 'chat-retry-message', 'chat-fork-message', 'chat-message-more']) {
    assert.equal(await aiMsg.getByTestId(id).count(), 1, id);
  }
  assert.equal(await aiMsg.getByTestId('chat-retry-message').isEnabled(), true);
  await aiMsg.getByTestId('chat-message-more').click();
  await page.getByTestId('chat-copy-plain').waitFor();
  assert.equal(await page.getByTestId('chat-export-session').count(), 1);
  await page.keyboard.press('Escape');

  // 用户操作行在气泡**外面**，并靠右对齐（与主页同一套结构）
  const userAction = userMsg.locator(':scope > [data-testid="chat-message-actions"]');
  assert.equal(await userAction.count(), 1);
  assert.equal(await userAction.evaluate((el) => getComputedStyle(el).justifyContent), 'flex-end');
  assert.equal(await userMsg.locator('.chat-bubble--user [data-testid="chat-message-actions"]').count(), 0);

  // 助手回答不再套一层有底色的气泡
  assert.equal(await aiMsg.locator('.chat-bubble--ai').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');

  // 回答上的重试 = 重新生成：同一问一答被替换，历史里不会出现重复提问
  await aiMsg.hover();
  await aiMsg.getByTestId('chat-retry-message').click();
  await page.getByText('第 1 次回答').waitFor();
  assert.deepEqual(await rows(page), [
    { role: 'user', content: '帮我整理复习重点' },
    { role: 'assistant', content: '第 1 次回答' },
  ]);

  // 提问上的重试 = 重新回答这句话
  await page.locator('.chat-msg--user').last().hover();
  await page.locator('.chat-msg--user').last().getByTestId('chat-retry-message').click();
  await page.getByText('第 2 次回答').waitFor();
  assert.deepEqual(await rows(page), [
    { role: 'user', content: '帮我整理复习重点' },
    { role: 'assistant', content: '第 2 次回答' },
  ]);

  // 分支：复制到这条消息为止，原会话不动
  await page.locator('.chat-msg--ai').last().hover();
  await page.locator('.chat-msg--ai').last().getByTestId('chat-fork-message').click();
  await page.getByText('面板交互 · 分支').first().waitFor();
  assert.equal(await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    return db.chatSessions.count();
  }), 2);
  assert.deepEqual(await rows(page), [
    { role: 'user', content: '帮我整理复习重点' },
    { role: 'assistant', content: '第 2 次回答' },
  ]);
  await page.screenshot({ path: 'e2e-shots/panel-message-ux-desktop.png' });

  // 移动端：轻触不展开，真触屏长按出现时间与复制 / 重试 / 分支
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await installFakeModel(mobile);
  const mp = await mobile.newPage();
  mp.on('pageerror', (error) => errors.push(error.message));
  await seed(mp);
  await openPanelChat(mp);
  const trigger = mp.getByTestId('chat-user-message-trigger');
  await trigger.waitFor();
  assert.equal(await mp.locator('.chat-msg--user > [data-testid="chat-message-actions"]').isVisible(), false);
  await trigger.tap();
  assert.equal(await mp.getByRole('menu').count(), 0, '轻触不打开菜单');

  const cdp = await mobile.newCDPSession(mp);
  const box = await trigger.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
  await mp.getByTestId('chat-message-time').waitFor();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await mp.getByTestId('chat-message-time').textContent(), '昨天 17:39');
  assert.deepEqual(await mp.getByRole('menuitem').allTextContents(), ['复制', '重试', '分支出新会话', '删除这条消息']);
  await mp.screenshot({ path: 'e2e-shots/panel-message-long-press-mobile.png' });
  await mp.getByTestId('chat-user-copy').tap();
  assert.equal(await mp.evaluate(() => navigator.clipboard.readText()), '帮我整理复习重点');

  const interruptedPrefix = '问答已输出的这段正文必须保留，刷新后仍然存在。';
  await page.evaluate(prefix => { window.__failNextPanelRequest = prefix; }, interruptedPrefix);
  const failureComposer = page.getByRole('textbox', { name: '给学习助手发送消息' });
  await failureComposer.fill('测试模型异常时保留半截回答');
  await failureComposer.press('Enter');
  await page.getByTestId('chat-interrupted').waitFor();
  const failedRows = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    return db.chats.toArray();
  });
  const failedAnswer = failedRows.find(row => row.role === 'assistant' && row.content === interruptedPrefix);
  assert.ok(failedAnswer?.interrupted, 'ordinary QA partial text must persist even without a widget');
  assert.match(failedAnswer.interruptReason, /没有正常结束/);
  assert.ok(!failedAnswer.content.includes('回答中断'), 'status text must not pollute the model prefix');
  await page.reload();
  await openPanelChat(page);
  await page.getByTestId('chat-interrupted').waitFor();
  assert.ok((await page.locator('.chat-bubble--ai').last().innerText()).includes(interruptedPrefix));

  assert.deepEqual(errors, []);
  console.log('PASS: 学习助手问答操作行、长按菜单、重试与分支；异常正文落库、刷新恢复及独立中断提示。');
} catch (error) {
  console.error(await page.locator('body').innerText().catch(() => ''));
  throw error;
} finally {
  await browser.close();
}
