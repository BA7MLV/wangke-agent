// Uses an isolated context; never changes the user's conversations.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const base = process.env.BASE_URL ?? 'http://localhost:5173';
try {
  await page.goto(`${base}/#/library`);
  await page.getByTestId('nav-rail').waitFor();
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const createdAt = Date.now();
    await db.chatSessions.add({ id: 91001, videoId: '__library_assistant__', title: '侧栏稳定性测试', createdAt });
    await db.chats.add({ sessionId: 91001, videoId: '__library_assistant__', role: 'user', content: '测试消息', createdAt });
  });
  await page.addInitScript(() => {
    window.sidebarColdEmpty = false;
    new MutationObserver(() => {
      const rail = document.querySelector('[data-testid="nav-rail"]');
      if (rail?.textContent.includes('开始对话后')) window.sidebarColdEmpty = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  await page.getByTestId('chat-recent-91001').waitFor();
  assert.equal(await page.evaluate(() => window.sidebarColdEmpty), false,
    'Cold loading must not display the empty-conversation hint before the query finishes');
  await page.evaluate(() => {
    window.sidebarSamples = [];
    const sample = () => {
      const rail = document.querySelector('[data-testid="nav-rail"]');
      if (rail) window.sidebarSamples.push({
        hash: location.hash,
        hasRecent: !!rail.querySelector('[data-testid="chat-recent-91001"]'),
        empty: rail.textContent.includes('开始对话后'),
      });
    };
    window.sidebarObserver = new MutationObserver(sample);
    window.sidebarObserver.observe(document.getElementById('root'), { childList: true, subtree: true });
    sample();
  });
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('nav-rail-chat').click();
    await page.waitForURL('**/#/');
    await page.getByTestId('chat-recent-91001').waitFor();
    await page.getByTestId('nav-rail-home').click();
    await page.waitForURL('**/#/library');
    await page.getByTestId('chat-recent-91001').waitFor();
  }
  const samples = await page.evaluate(() => {
    window.sidebarObserver.disconnect();
    return window.sidebarSamples;
  });
  assert.equal(samples.filter((sample) => !sample.hasRecent || sample.empty).length, 0,
    `Recent must not disappear during navigation: ${JSON.stringify(samples.filter((sample) => !sample.hasRecent || sample.empty))}`);
  // Keeping the last result must not disable live database updates.
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    await db.chats.where('sessionId').equals(91001).delete();
  });
  await page.getByTestId('chat-recent-91001').waitFor({ state: 'detached' });
  await page.getByText('开始对话后，会话会显示在这里', { exact: true }).waitFor();
  console.log('Sidebar navigation stability and live updates passed.');
} finally {
  await browser.close();
}
