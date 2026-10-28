import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.testImport = path => {
      const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(entry?.name ?? path);
    };
  });
  await page.goto(process.env.BASE_URL || 'http://localhost:5188');
  await page.waitForFunction(async () => (await window.testImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  await page.evaluate(async () => {
    const { db } = await window.testImport('/src/store/db.ts');
    await db.chatSessions.put({ id: 991, videoId: '__library_assistant__', title: '消息顺序回归', createdAt: 1000 });
    await db.chats.bulkPut([
      { id: 9000, sessionId: 991, videoId: '__library_assistant__', role: 'user', content: '用户先提问\n' + '这是一条用于检查折叠按钮的长消息。\n'.repeat(12), createdAt: 1000 },
      { id: 1000, sessionId: 991, videoId: '__library_assistant__', role: 'assistant', content: '助手后回答', createdAt: 1000 },
    ]);
    await (await window.testImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(991);
  });
  const verify = async () => {
    await page.getByText('助手后回答', { exact: true }).waitFor();
    const roles = await page.evaluate(async () => (await window.testImport('/src/store/courseChat.ts')).useCourseChat.getState().messages.map(row => row.role));
    assert.deepEqual(roles, ['user', 'ai']);
    assert.ok(await page.getByTestId('chat-user-message-trigger').evaluate(el => !!(el.compareDocumentPosition(document.querySelector('.course-chat__message--ai')) & Node.DOCUMENT_POSITION_FOLLOWING)));
    assert.equal(await page.getByRole('button', { name: 'Bot', exact: true }).count(), 0);
    const toggle = page.getByTestId('chat-user-expand');
    await toggle.waitFor();
    const style = await toggle.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, radius: getComputedStyle(el).borderRadius }));
    assert.equal(style.background, 'rgba(0, 0, 0, 0)');
    assert.equal(style.radius, '4px');
    await toggle.focus();
    await page.keyboard.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  };
  await verify();
  await page.reload();
  await page.waitForFunction(async () => (await window.testImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  await page.evaluate(async () => (await window.testImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(991));
  await verify();
  if (process.env.SCREENSHOT_PATH) {
    await page.getByText('助手后回答', { exact: true }).click();
    await page.screenshot({ path: process.env.SCREENSHOT_PATH });
  }
  await page.setViewportSize({ width: 1200, height: 900 });
  assert.equal(await page.getByRole('button', { name: 'Bot', exact: true }).count(), 0);
  console.log('PASS: reversed cloud IDs render question first after refresh; mobile text toggle and keyboard activation; no header Bot on mobile/desktop.');
} finally { await browser.close(); }
