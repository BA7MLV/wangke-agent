import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.BASE_URL || 'http://localhost:5186');
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).waitFor();
  const ids = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const now = Date.now();
    const videoId = '__library_assistant__';
    const ids = await db.chatSessions.bulkAdd([
      { videoId, title: '微积分 · 从直觉到公式', createdAt: now - 60_000 },
      { videoId, title: '本周学习计划', createdAt: now - 120_000, pinned: true },
      { videoId, title: '概率论与统计复习', createdAt: now - 180_000 },
    ], { allKeys: true });
    await db.chats.bulkAdd([
      { sessionId: ids[0], videoId, role: 'user', content: '导数到底在描述什么？', createdAt: now - 50_000 },
      { sessionId: ids[0], videoId, role: 'user', content: '能用生活里的例子讲清楚吗？', createdAt: now - 40_000 },
      { sessionId: ids[0], videoId, role: 'assistant', content: '导数描述的是 **瞬时变化率**。\n\n想象你正在开车：平均速度告诉你整段路开得多快，仪表盘上的速度则告诉你「此刻」有多快。导数就像这块仪表盘。\n\n### 从直觉到公式\n\n当时间间隔越来越小时，距离变化量与时间变化量的比值，趋近于这一刻的速度。\n\n接下来可以用链式法则计算复合函数的变化率。', createdAt: now - 30_000 },
      { sessionId: ids[1], videoId, role: 'user', content: '每天留出半小时复习，周末回顾错题。', createdAt: now - 120_000 },
      { sessionId: ids[2], videoId, role: 'user', content: '下一次复习贝叶斯公式。', createdAt: now - 180_000 },
    ]);
    return ids;
  });
  await page.reload();
  await page.getByTestId(`chat-recent-${ids[0]}`).click();
  await page.getByText('导数描述的是', { exact: false }).first().waitFor();
  const rows = page.locator('.recent-item');
  assert.equal(await rows.count(), 3);
  assert.equal(await rows.first().getAttribute('data-testid'), `chat-recent-${ids[1]}`, 'pinned session stays first');
  assert.match(await page.getByTestId(`chat-recent-${ids[0]}`).innerText(), /链式法则/);
  assert.equal(await page.locator('.course-chat__timestamp').count(), 3);
  assert.equal(await page.locator('.course-chat__date').count(), 1);
  assert.equal(await page.locator('[data-chat-message]').nth(1).getAttribute('data-group-first'), 'false');
  assert.ok(await page.evaluate(() => {
    const rows = document.querySelectorAll('[data-chat-message]');
    return rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom <= 8;
  }), 'hidden desktop actions do not leave a gap between grouped messages');
  const search = page.getByTestId('chat-search');
  await search.fill('链式法则');
  assert.equal(await rows.count(), 1, 'search matches latest-message preview');
  await search.fill('不存在的会话');
  await page.getByText('没有匹配的会话', { exact: true }).waitFor();
  await search.press('Escape');
  assert.equal(await rows.count(), 3);

  // Context-menu actions must not open a different chat as a side effect.
  const other = page.getByTestId(`chat-recent-${ids[2]}`);
  await other.click({ button: 'right' });
  await page.getByTestId(`chat-recent-${ids[2]}-menu-delete`).click();
  await page.getByTestId('confirm-dialog-cancel').click();
  assert.equal(await page.getByTestId('page-title').innerText(), '微积分 · 从直觉到公式');
  await page.mouse.move(1350, 800);
  await page.screenshot({ path: 'e2e-shots/telegram-chat-desktop.png', animations: 'disabled' });

  // Dark theme and mobile use the same data and controls, without horizontal overflow.
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: 'e2e-shots/telegram-chat-dark.png', animations: 'disabled' });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('nav-rail-open').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'e2e-shots/telegram-chat-mobile.png', animations: 'disabled' });
  await page.getByTestId('nav-rail-open').click();
  await page.getByTestId('chat-search').fill('贝叶斯');
  await page.getByTestId(`chat-recent-${ids[2]}`).click();
  await page.getByTestId('chat-search').waitFor({ state: 'hidden' });
  assert.equal(await page.getByTestId('page-title').innerText(), '概率论与统计复习');
  assert.deepEqual(errors, []);
  console.log('Telegram chat: preview search, pin ordering, message grouping/time, menu isolation, light/dark screenshots and mobile navigation passed.');
} finally {
  await browser.close();
}
