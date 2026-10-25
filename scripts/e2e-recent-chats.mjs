import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// 独立浏览器上下文，不读写日常浏览器中的会话。
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('[useRecentChats]')) errors.push(message.text());
  });
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  await page.getByTestId('course-chat-page').waitFor();
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    await useCourseChat.getState().bootstrap();
    const sessions = [
      { id: 901, title: '旧会话', createdAt: 100, pinned: false },
      { id: 902, title: '最新会话', createdAt: 200, pinned: false },
      { id: 903, title: '置顶会话', createdAt: 50, pinned: true },
      { id: 904, title: '空会话', createdAt: 400, pinned: false },
    ].map((row) => ({ ...row, videoId: '__library_assistant__' }));
    await db.chatSessions.bulkPut(sessions);
    await db.chats.bulkAdd(sessions.slice(0, 3).map((row) => ({
      sessionId: row.id, videoId: row.videoId, role: 'user', content: row.title, createdAt: row.createdAt,
    })));
    useCourseChat.setState({ sessions, runningIds: [902], awaitingIds: [] });
  });
  const rows = page.locator('[data-testid^="chat-recent-"][role="option"]');
  await page.getByTestId('chat-recent-903').waitFor();
  const ids = () => rows.evaluateAll((els) => els.map((el) => el.dataset.testid));
  const expected = ['chat-recent-903', 'chat-recent-902', 'chat-recent-901'];
  assert.deepEqual(await ids(), expected);
  await page.goto(`${process.env.BASE_URL || 'http://localhost:5173'}/#/library`);
  await page.getByTestId('chat-recent-903').waitFor();
  assert.deepEqual(await ids(), expected);
  await page.getByTestId('chat-recent-901').click({ button: 'right' });
  for (const name of ['重命名', '置顶', '分支出新会话', '归档', '删除']) {
    assert.equal(await page.getByRole('menuitem', { name, exact: true }).count(), 1);
  }
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid^="chat-recent-"][role="option"]')?.dataset.testid === 'chat-recent-901');
  await page.getByTestId('chat-recent-901').click();
  await page.getByTestId('course-chat-page').waitFor();
  assert.equal(await page.getByTestId('chat-recent-901').getAttribute('aria-selected'), 'true');

  // 失败回答的真实按钮走 retryMessage 的删除路径；仅替换 send，避免依赖模型服务。
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    const row = await db.chats.where('sessionId').equals(901).first();
    window.__restoreRecentSend = useCourseChat.getState().send;
    window.__recentRetries = 0;
    useCourseChat.setState({
      messages: [
        { key: 'recent-user', rowId: row.id, role: 'user', content: row.content, createdAt: row.createdAt },
        { key: 'recent-error', role: 'ai', content: '测试回答失败', error: true, createdAt: row.createdAt + 1 },
      ],
      send: async (text, _unused, sessionId) => {
        // 让列表有机会读到删除后的空会话，再验证重建后订阅仍然有效。
        await new Promise((resolve) => setTimeout(resolve, 100));
        await db.chats.add({ sessionId, videoId: row.videoId, role: 'user', content: text, createdAt: 500 });
        window.__recentRetries++;
      },
    });
  });
  try {
    await page.getByTestId('chat-error-continue').click();
    await page.waitForFunction(() => window.__recentRetries === 1);
    await page.getByTestId('chat-recent-901').waitFor();
    assert.equal(await page.getByText('最近会话加载失败，请刷新重试', { exact: true }).count(), 0);
    await page.evaluate(async () => {
      const { db } = await import('/src/store/db.ts');
      // 下一次数据库变化也必须刷新，不能只保留旧列表。
      await db.chats.add({ sessionId: 904, videoId: '__library_assistant__', role: 'user', content: '重试后的新消息', createdAt: 600 });
    });
    await page.getByTestId('chat-recent-904').waitFor();
    assert.equal(await page.evaluate(async () => {
      const { db } = await import('/src/store/db.ts');
      return db.chats.where('sessionId').equals(901).count();
    }), 1, 'Retry must replace the user row without duplicates');
  } finally {
    await page.evaluate(async () => {
      const { useCourseChat } = await import('/src/store/courseChat.ts');
      useCourseChat.setState({ send: window.__restoreRecentSend });
      delete window.__restoreRecentSend;
    });
  }
  assert.deepEqual(errors, []);
  console.log('PASS shared order, empty-session filtering, library menus, pinning, navigation and failed-answer retry updates');
} catch (error) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) console.error(await page.locator('body').innerText());
  }
  throw error;
} finally {
  await browser.close();
}
