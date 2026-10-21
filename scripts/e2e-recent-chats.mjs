import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// 独立浏览器上下文，不读写日常浏览器中的会话。
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
  assert.deepEqual(errors, []);
  console.log('PASS shared order, empty-session filtering, library menus, pinning and navigation');
} catch (error) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) console.error(await page.locator('body').innerText());
  }
  throw error;
} finally {
  await browser.close();
}
