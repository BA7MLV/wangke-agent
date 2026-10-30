// Uses an isolated context; never changes the user's conversations.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const base = process.env.BASE_URL ?? 'http://localhost:5173';
try {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await page.context().route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.goto(`${base}/#/library`);
  await page.getByTestId('nav-rail').waitFor();
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const createdAt = Date.now();
    await db.chatSessions.add({ id: 91001, videoId: '__library_assistant__', title: '侧栏稳定性测试', createdAt });
    await db.chats.add({ sessionId: 91001, videoId: '__library_assistant__', role: 'user', content: '测试消息', createdAt });
    for (let index = 0; index < 35; index++) {
      const id = 91002 + index;
      const time = createdAt - (index + 1) * 1000;
      await db.chatSessions.add({ id, videoId: '__library_assistant__', title: `滚动测试 ${index + 1}`, createdAt: time });
      await db.chats.add({ sessionId: id, videoId: '__library_assistant__', role: 'user', content: '测试历史消息', createdAt: time });
    }
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
    window.sidebarNode = document.querySelector('[data-testid="nav-rail"]');
    window.sidebarFooter = document.querySelector('[data-testid="nav-rail-footer"]');
    window.sidebarScroll = window.sidebarNode.querySelector('.overflow-y-auto');
    window.sidebarScroll.scrollTop = 120;
    window.sidebarScrollTop = window.sidebarScroll.scrollTop;
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
    assert.equal(await page.getByTestId('nav-rail-chat').getAttribute('aria-current'), 'page');
    assert.equal(await page.getByTestId('page-title').innerText(), '');
    await page.getByTestId('nav-rail-home').click();
    await page.waitForURL('**/#/library');
    await page.getByTestId('chat-recent-91001').waitFor();
    assert.equal(await page.evaluate(() => window.sidebarNode === document.querySelector('[data-testid="nav-rail"]')
      && window.sidebarFooter === document.querySelector('[data-testid="nav-rail-footer"]')), true,
    'navigation and account DOM must survive page changes, not just look the same');
    assert.equal(await page.evaluate(() => window.sidebarScrollTop > 0 && window.sidebarScroll.scrollTop === window.sidebarScrollTop), true,
      'Recent retains its actual scroll offset across page changes');
  }
  const samples = await page.evaluate(() => {
    window.sidebarObserver.disconnect();
    return window.sidebarSamples;
  });
  assert.equal(samples.filter((sample) => !sample.hasRecent || sample.empty).length, 0,
    `Recent must not disappear during navigation: ${JSON.stringify(samples.filter((sample) => !sample.hasRecent || sample.empty))}`);
  await page.getByTestId('chat-recent-91001').click();
  await page.waitForURL('**/#/');
  await page.getByTestId('course-chat-messages').getByText('测试消息', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('chat-recent-91001').getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByTestId('nav-rail-chat').getAttribute('aria-current'), null,
    'a history conversation highlights Recent, not the blank home');
  await page.getByTestId('nav-rail-chat').click();
  const input = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await input.fill('保留主页草稿');
  await page.getByTestId('nav-rail-chat').click();
  assert.equal(await input.inputValue(), '保留主页草稿', 'returning to the selected home is idempotent');
  assert.equal(await input.evaluate(el => el === document.activeElement), true, 'home focuses the composer');

  const resourceLink = page.getByRole('link', { name: '资源', exact: true });
  assert.equal(await resourceLink.getAttribute('href'), '#/library', 'resource navigation exposes a real browser link');
  assert.equal(await page.getByTestId('nav-rail-chat').evaluate(el => el.tagName), 'BUTTON', 'home keeps its new-session action');
  assert.equal(await page.getByTestId('nav-rail-bot').evaluate(el => el.tagName), 'BUTTON', 'Bot keeps its panel action');
  // Native middle-click tabs have no opener, so observe the context rather than popup.
  const popupPromise = page.context().waitForEvent('page');
  await resourceLink.click({ button: 'middle' });
  const popup = await popupPromise;
  try {
    popup.on('pageerror', error => errors.push(error.message));
    await popup.waitForURL('**/#/library');
    await popup.getByTestId('nav-rail-home').waitFor();
    assert.equal(new URL(page.url()).hash, '#/', 'opening resources in a new tab leaves the current page alone');
    assert.equal(await input.inputValue(), '保留主页草稿', 'opening a new tab does not clear the current draft');
  } finally {
    await popup.close();
  }
  await resourceLink.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL('**/#/library');
  await page.goBack();
  await page.waitForURL('**/#/');
  assert.equal(await page.evaluate(() => window.sidebarNode === document.querySelector('[data-testid="nav-rail"]')), true,
    'keyboard navigation and browser history retain the shared navigation');
  assert.equal(await input.inputValue(), '保留主页草稿', 'keyboard navigation and browser history preserve the draft');

  await page.getByTestId('nav-rail-toggle').click();
  await page.getByTestId('nav-rail-compact').waitFor();
  await page.evaluate(() => { window.compactSidebar = document.querySelector('[data-testid="nav-rail-compact"]'); });
  await page.getByTestId('nav-rail-home').click();
  await page.waitForURL('**/#/library');
  await page.getByTestId('nav-rail-chat').click();
  await page.waitForURL('**/#/');
  assert.equal(await page.evaluate(() => window.compactSidebar === document.querySelector('[data-testid="nav-rail-compact"]')), true);
  await page.getByTestId('nav-rail-toggle').click();
  await page.getByTestId('nav-rail').waitFor();
  // The shared query must remain reactive without a module-level cache.
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    await db.chats.clear();
  });
  await page.getByTestId('chat-recent-91001').waitFor({ state: 'detached' });
  await page.getByText('开始对话后，会话会显示在这里', { exact: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'DeepStudent Go', exact: true });
  await drawer.waitFor();
  const modifiedTabPromise = page.context().waitForEvent('page');
  await resourceLink.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  const modifiedTab = await modifiedTabPromise;
  try {
    modifiedTab.on('pageerror', error => errors.push(error.message));
    await modifiedTab.waitForURL('**/#/library');
    assert.equal(await drawer.isVisible(), true, 'modified link clicks do not dismiss the current drawer');
    assert.equal(new URL(page.url()).hash, '#/', 'modified link clicks do not navigate the current page');
  } finally {
    await modifiedTab.close();
  }
  await resourceLink.click();
  await page.waitForURL('**/#/library');
  await drawer.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('PASS: persistent sidebar/account DOM, cold Recent, live updates, home/history selection, retained draft, native resource links, keyboard/history, compact navigation and modifier-aware mobile drawer.');
} finally {
  await browser.close();
}
