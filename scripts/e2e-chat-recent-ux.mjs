import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('textarea').waitFor();
  const ids = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const { LIBRARY_ASSISTANT_ID } = await import('/src/harness/libraryAssistant.ts');
    const now = Date.now();
    const ids = [];
    for (const [i, title] of ['旧会话新消息', '较新会话', '置顶会话', '空会话'].entries()) {
      const id = await db.chatSessions.add({ videoId: LIBRARY_ASSISTANT_ID, title, createdAt: now + i, pinned: i === 2 });
      ids.push(id);
      if (i !== 3) await db.chats.add({ videoId: LIBRARY_ASSISTANT_ID, sessionId: id, role: 'user',
        content: i === 0 ? Array.from({ length: 15 }, (_, n) => `第 ${n + 1} 行：请帮我理解这个概念。`).join('\n') : title,
        createdAt: now + (i === 0 ? 100 : i) });
    }
    return ids;
  });
  await page.reload();
  const recent = page.locator('[data-testid^="chat-recent-"][role="option"]');
  await recent.first().waitFor();
  assert.deepEqual(await recent.evaluateAll((els) => els.map((el) => el.dataset.testid)),
    [ids[2], ids[0], ids[1]].map((id) => `chat-recent-${id}`));
  await page.evaluate(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    await useCourseChat.getState().createSession();
  });
  await page.locator('textarea').fill('还没有发送的草稿');
  assert.equal(await recent.count(), 3, 'Draft must not create a sidebar entry');
  await page.getByTestId(`chat-recent-${ids[1]}`).click();
  await page.getByTestId(`chat-recent-${ids[2]}-unpin`).click();
  await page.waitForFunction((id) => !document.querySelector(`[data-testid="chat-recent-${id}-unpin"]`), ids[2]);
  assert.equal(await page.getByTestId(`chat-recent-${ids[1]}`).getAttribute('aria-selected'), 'true');
  assert.equal(await recent.first().getAttribute('data-testid'), `chat-recent-${ids[0]}`);
  await page.getByTestId(`chat-recent-${ids[0]}`).click();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const expand = page.getByTestId('chat-user-expand');
    await expand.waitFor();
    assert(await expand.evaluate((el) => !!el.closest('.course-chat__bubble--user')));
    const gap = await expand.evaluate((el) => el.getBoundingClientRect().top - document.querySelector('.course-chat__user-text').getBoundingClientRect().bottom);
    assert(gap >= 0 && gap <= 8, `Expand must be adjacent to text: ${gap}`);
    await expand.click();
    assert.equal(await expand.getAttribute('aria-expanded'), 'true');
    await expand.click();
    assert.equal(await expand.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(async (id) => {
    const { db } = await import('/src/store/db.ts');
    await db.chats.add({ sessionId: id, videoId: 'test', role: 'user', content: '第一条消息', createdAt: Date.now() + 1000 });
  }, ids[3]);
  await page.getByTestId(`chat-recent-${ids[3]}`).waitFor();
  assert.equal(await recent.first().getAttribute('data-testid'), `chat-recent-${ids[3]}`, 'First send appears immediately at the top');
  assert.deepEqual(errors, []);
  console.log('PASS empty sessions hidden; recent activity descending; pin click does not navigate; inline expand/collapse on desktop and mobile');
} finally {
  await browser.close();
}
