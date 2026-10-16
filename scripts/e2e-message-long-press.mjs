import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(base);
  await page.locator('textarea').waitFor();
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const { LIBRARY_ASSISTANT_ID } = await import('/src/harness/libraryAssistant.ts');
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(17, 39, 0, 0);
    const createdAt = yesterday.getTime();
    const id = await db.chatSessions.add({ videoId: LIBRARY_ASSISTANT_ID, title: '长按菜单回归', createdAt });
    await db.chats.bulkAdd([
      { videoId: LIBRARY_ASSISTANT_ID, sessionId: id, role: 'user', content: '帮我整理复习重点', createdAt },
      { videoId: LIBRARY_ASSISTANT_ID, sessionId: id, role: 'assistant', content: '先复习核心概念，再做练习。', createdAt: createdAt + 1000 },
    ]);
  });
  await page.reload();
  const trigger = page.getByTestId('chat-user-message-trigger');
  await trigger.waitFor();
  assert.equal(await page.getByTestId('chat-message-time').count(), 0, '时间默认不显示');
  assert.equal(await page.locator('.course-chat__message--user > .course-chat__actions').isVisible(), false);
  await trigger.tap();
  assert.equal(await page.getByRole('menu').count(), 0, '轻触不打开菜单');
  const cdp = await context.newCDPSession(page);
  const hold = async () => {
    const box = await trigger.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
    await page.getByTestId('chat-message-time').waitFor();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await hold();
  assert.equal(await page.getByTestId('chat-message-time').textContent(), '昨天 17:39');
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['复制', '重试', 'Fork · 分支出新会话']);
  assert.equal(await page.getByTestId('chat-user-fork').locator('svg').count(), 0);
  assert.equal(await page.getByTestId('chat-user-copy').locator('svg').count(), 1);
  await page.screenshot({ path: 'e2e-shots/message-long-press-menu-mobile.png' });
  await page.getByTestId('chat-user-copy').tap();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '帮我整理复习重点');
  await hold();
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  await hold();
  await page.getByTestId('chat-user-fork').tap();
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  await page.waitForFunction(async () => {
    const { db } = await import('/src/store/db.ts');
    return (await db.chatSessions.count()) === 2;
  });
  // 日期边界：跨年昨天、同日与更早日期。
  assert.deepEqual(await page.evaluate(async () => {
    const { messageTime } = await import('/src/utils/messageTime.ts');
    const now = new Date(2026, 0, 1, 12);
    return [messageTime(+new Date(2025, 11, 31, 17, 39), now), messageTime(+new Date(2026, 0, 1, 9, 5), now), messageTime(+new Date(2025, 11, 30, 9, 5), now)];
  }), ['昨天 17:39', '今天 09:05', '2025年12月30日 09:05']);
  assert.deepEqual(errors, []);
  console.log('PASS: 移动端轻触不展开、真触屏长按、时间与动作顺序、图标主次、复制、取消、Fork、日期边界');
} catch (error) {
  console.error(await page.locator('body').innerText());
  console.error(await page.evaluate(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    return { messages: useCourseChat.getState().messages, triggers: [...document.querySelectorAll('.course-chat__bubble')].map((el) => el.outerHTML) };
  }));
  throw error;
} finally {
  await browser.close();
}
