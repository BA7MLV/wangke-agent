import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await page.goto(process.env.BASE_URL || 'http://localhost:5188');
  await page.getByTestId('course-chat-page').waitFor();
  await page.evaluate(async () => {
    const load = path => {
      const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(entry?.name ?? path);
    };
    const { db } = await load('/src/store/db.ts');
    const { useCourseChat } = await load('/src/store/courseChat.ts');
    const sessionId = 9991, videoId = '__library_assistant__';
    await db.chatSessions.put({ id: sessionId, videoId, title: '输入栏裁切检查', createdAt: 100 });
    await db.chats.bulkPut([
      { id: 9991, sessionId, videoId, role: 'user', content: '长回答', createdAt: 100 },
      { id: 9992, sessionId, videoId, role: 'assistant', content: Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段：滚动内容应在输入卡边界消失。`).join('\n\n'), createdAt: 101 },
    ]);
    await useCourseChat.getState().loadSession(sessionId);
  });
  await page.getByText('第 1 段：滚动内容应在输入卡边界消失。', { exact: true }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const draft of ['', '多行输入\n'.repeat(7)]) {
      await page.locator('.course-chat__input').fill(draft);
      await page.waitForFunction(() => {
        const messages = document.querySelector('.course-chat__messages');
        const composer = document.querySelector('.course-chat__composer');
        const inset = parseFloat(getComputedStyle(messages).clipPath.match(/[\d.]+px/g)?.[2]);
        return Math.abs(messages.getBoundingClientRect().bottom - inset - composer.getBoundingClientRect().top) < 1;
      });
      const result = await page.evaluate(() => {
        const messages = document.querySelector('.course-chat__messages');
        messages.scrollTop = messages.scrollHeight / 2;
        const wrap = document.querySelector('.course-chat__composer-wrap');
        const top = document.querySelector('.course-chat__composer').getBoundingClientRect().top;
        const x = messages.getBoundingClientRect().left + 5;
        const probe = document.createElement('span');
        probe.style.cssText = `position:fixed;top:${top - 12}px;left:${x}px;width:10px;height:24px;background:red;z-index:99`;
        messages.append(probe);
        const above = document.elementsFromPoint(x + 2, top - 4).includes(probe);
        const below = document.elementsFromPoint(x + 2, top + 4).includes(probe);
        probe.remove();
        return { above, below, background: getComputedStyle(wrap).backgroundColor, image: getComputedStyle(wrap).backgroundImage };
      });
      assert.deepEqual(result, { above: true, below: false, background: 'rgba(0, 0, 0, 0)', image: 'none' });
    }
  }
  assert.equal(await page.locator('.page-shell__rail').count(), 0, 'mobile retains the navigation drawer');
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.locator('.page-shell__rail').evaluate(el => getComputedStyle(el).transitionDuration), '0s', 'reduced motion disables sidebar tween');
  console.log('PASS: message clipping aligns with the actual composer edge at desktop/mobile and multiline sizes; no colored overlay; reduced motion supported.');
} finally { await browser.close(); }
