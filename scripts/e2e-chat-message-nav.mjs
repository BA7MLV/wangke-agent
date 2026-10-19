import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.BASE_URL || 'http://127.0.0.1:5173');
  await page.waitForSelector('[data-testid="course-chat-messages"]');
  await page.waitForFunction(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    return useCourseChat.getState().ready && useCourseChat.getState().loaded;
  });
  await page.evaluate(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    useCourseChat.setState({ loaded: true, hasOlder: false, messages: Array.from({ length: 120 }, (_, index) => ({
      key: `nav-${index}`, role: index % 2 ? 'ai' : 'user',
      content: index % 2 ? `回答 ${index}\n\n${'这是高度不同的回答内容。\n\n'.repeat(index % 7 + 2)}` : `定位提问 ${index / 2 + 1}`,
    })) });
  });
  const nav = page.getByTestId('chat-message-nav');
  await nav.waitFor();
  assert.equal(await nav.locator('button').count(), 60);
  await page.waitForFunction(() => document.querySelector('[aria-current="location"]')?.getAttribute('aria-label')?.includes('第 60 条'));
  await nav.getByRole('button', { name: '第 7 条提问：定位提问 7', exact: true }).click();
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-index="12"]');
    const scroll = document.querySelector('[data-testid="course-chat-messages"]');
    if (!row || !scroll) return false;
    const gap = row.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    return gap >= 80 && gap < 110;
  });
  await page.waitForFunction(() => document.querySelector('[aria-current="location"]')?.getAttribute('aria-label')?.includes('第 7 条'));
  assert.ok(await page.locator('.course-chat__message').count() < 30);
  await page.mouse.move(200, 200);
  await nav.getByRole('button', { name: '第 7 条提问：定位提问 7', exact: true }).hover();
  await page.getByRole('tooltip').waitFor();
  await page.screenshot({ path: 'e2e-shots/chat-message-nav-desktop.png' });
  console.log('✓ Off-screen virtualized messages can be located; current tick and preview work');

  await page.setViewportSize({ width: 390, height: 844 });
  await nav.getByRole('button', { name: '第 20 条提问：定位提问 20', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-current="location"]')?.getAttribute('aria-label')?.includes('第 20 条'));
  const geometry = await page.evaluate(() => {
    const nav = document.querySelector('[data-testid="chat-message-nav"]').getBoundingClientRect();
    const row = document.querySelector('[data-index="38"]').getBoundingClientRect();
    const composer = document.querySelector('.course-chat__composer-wrap').getBoundingClientRect();
    return { navRight: nav.right, navBottom: nav.bottom, rowRight: row.right, navLeft: nav.left, composerTop: composer.top, width: innerWidth };
  });
  assert.ok(geometry.navRight <= geometry.width && geometry.rowRight <= geometry.navLeft, JSON.stringify(geometry));
  assert.ok(geometry.navBottom <= geometry.composerTop, JSON.stringify(geometry));
  await page.screenshot({ path: 'e2e-shots/chat-message-nav-mobile.png' });
  console.log('✓ Mobile rail does not cover messages or composer');

  await page.evaluate(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    useCourseChat.setState({ messages: [{ key: 'thinking', role: 'ai', content: '', streaming: true, reasoning: '正在分析。\n'.repeat(200) }] });
  });
  const body = page.locator('.reasoning-chain__body--live');
  await body.waitFor();
  await page.waitForTimeout(600);
  const before = await body.evaluate((el) => ({ width: el.clientWidth, scroll: getComputedStyle(el).overflowY,
    gutter: getComputedStyle(el).scrollbarGutter, distance: el.scrollHeight - el.clientHeight - el.scrollTop }));
  assert.equal(before.scroll, 'scroll');
  assert.equal(before.gutter, 'stable');
  assert.ok(before.distance < 4, JSON.stringify(before));
  await page.evaluate(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    useCourseChat.setState({ messages: useCourseChat.getState().messages.map((m) => ({ ...m, reasoning: m.reasoning + '继续思考。\n'.repeat(50) })) });
  });
  assert.equal(await body.evaluate((el) => el.clientWidth), before.width);
  assert.equal(await nav.count(), 0);
  assert.deepEqual(errors, []);
  console.log('✓ Reasoning gutter stays stable across streaming updates, follows bottom, no page errors');
} finally {
  await browser.close();
}
