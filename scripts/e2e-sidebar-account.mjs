import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:4173';
const out = process.env.SHOTS || 'test-results/sidebar-account';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];

async function newPage(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', ...options });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/**', route => route.fulfill({ json: { cloud: false } }));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.addInitScript(() => {
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: { theme: 'light', uiLanguage: 'zh-CN', userName: '林同学' } }));
  });
  await page.goto(base);
  await page.getByTestId('course-chat-page').waitFor();
  return page;
}

async function checkRow(page) {
  const trigger = page.getByTestId('nav-rail-account');
  await trigger.waitFor();
  assert.equal(await page.getByTestId('account-name').textContent(), '林同学');
  assert.equal(await page.getByTestId('account-avatar').textContent(), '林');
  const footerStyle = await page.getByTestId('nav-rail-footer').evaluate(el => {
    const style = getComputedStyle(el);
    return { border: style.borderTopWidth, shadow: style.boxShadow };
  });
  assert.deepEqual(footerStyle, { border: '0px', shadow: 'none' }, '账号区上方没有分割线或阴影');
  const avatar = await page.getByTestId('account-avatar').boundingBox();
  const name = await page.getByTestId('account-name').boundingBox();
  const gear = await page.getByTestId('nav-rail-settings').boundingBox();
  assert.ok(avatar.x + avatar.width <= name.x && name.x + name.width <= gear.x, '头像、用户名、设置依次从左到右排列');
  assert.ok(gear.width >= 44 && gear.height >= 44, '设置图标保持触控尺寸');
}

async function openMenu(page) {
  await page.getByTestId('nav-rail-account').click();
  await page.getByRole('menu').waitFor();
  await page.locator('.dropdown__popover[data-entering="true"]').waitFor({ state: 'hidden' });
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['设置', '已归档', '登出']);
  assert.equal(await page.getByTestId('settings-modal').count(), 0, '第一次点击头像和称呼只打开菜单');
}

async function closeSettings(page) {
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByTestId('settings-modal').waitFor({ state: 'hidden' });
}

try {
  const desktop = await newPage();
  await checkRow(desktop);
  await desktop.screenshot({ path: `${out}/desktop-light.png` });
  await openMenu(desktop);
  assert.equal(await desktop.getByTestId('account-menu-logout').getAttribute('aria-disabled'), 'true', '本机模式没有可登出的云端账号');
  const menu = await desktop.getByRole('menu').boundingBox();
  const trigger = await desktop.getByTestId('nav-rail-account').boundingBox();
  assert.ok(menu.y + menu.height <= trigger.y, '账号菜单向上展开');
  await desktop.screenshot({ path: `${out}/desktop-menu.png` });
  await desktop.keyboard.press('Escape');
  await desktop.getByRole('menu').waitFor({ state: 'hidden' });
  assert.equal(await desktop.getByTestId('nav-rail-account').evaluate(el => el === document.activeElement), true, 'Esc 将焦点还给头像入口');
  await desktop.keyboard.press('Enter');
  await desktop.getByTestId('account-menu-settings').waitFor();
  await desktop.keyboard.press('Enter');
  await desktop.getByTestId('settings-modal').waitFor();
  await closeSettings(desktop);
  await desktop.getByTestId('nav-rail-settings').click();
  await desktop.getByTestId('settings-modal').waitFor();
  assert.equal(await desktop.getByRole('menu').count(), 0, '齿轮直接打开设置，不打开账号菜单');
  await closeSettings(desktop);

  const archivedId = await desktop.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const { LIBRARY_ASSISTANT_ID } = await import('/src/harness/libraryAssistant.ts');
    return db.chatSessions.add({ videoId: LIBRARY_ASSISTANT_ID, title: '归档入口回归测试', archived: true, createdAt: Date.now() });
  });
  await openMenu(desktop);
  await desktop.getByTestId('account-menu-archived').click();
  await desktop.getByTestId(`archived-${archivedId}`).waitFor();
  assert.equal(await desktop.getByTestId('settings-modal').count(), 0, '直接展示已归档，不绕进设置');
  await desktop.getByTestId(`archived-restore-${archivedId}`).click();
  await desktop.getByTestId('archived-empty').waitFor();
  assert.equal(await desktop.evaluate(async id => (await (await import('/src/store/db.ts')).db.chatSessions.get(id)).archived, archivedId), undefined, '恢复操作实际移除归档标记');
  await desktop.getByRole('button', { name: '关闭已归档', exact: true }).click();
  await desktop.getByTestId('archived-sessions-dialog').waitFor({ state: 'hidden' });

  await desktop.evaluate(async () => (await import('/src/store/settings.ts')).useSettings.getState().update({ theme: 'dark' }));
  await desktop.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await checkRow(desktop);
  await openMenu(desktop);
  await desktop.screenshot({ path: `${out}/desktop-dark-menu.png` });
  await desktop.keyboard.press('Escape');
  await desktop.getByRole('menu').waitFor({ state: 'hidden' });
  await desktop.getByTestId('nav-rail-toggle').click();
  await desktop.getByTestId('nav-rail-compact').waitFor();
  assert.equal(await desktop.getByTestId('account-avatar').isVisible(), true, '折叠后保留头像');
  assert.equal(await desktop.getByTestId('account-name').isVisible(), false, '折叠后隐藏称呼');
  assert.equal(await desktop.getByTestId('nav-rail-settings').isVisible(), false, '折叠后设置从菜单访问');
  await openMenu(desktop);
  await desktop.getByTestId('account-menu-settings').click();
  await desktop.getByTestId('settings-modal').waitFor();
  await closeSettings(desktop);
  await desktop.getByTestId('nav-rail-toggle').click();
  await desktop.getByTestId('nav-rail').waitFor();
  await desktop.evaluate(async () => (await import('/src/store/settings.ts')).useSettings.getState().update({ userName: '这是一段很长的用户名用于确认设置按钮不会被挤出侧栏' }));
  assert.equal(await desktop.getByTestId('account-name').evaluate(el => el.scrollWidth > el.clientWidth), true, '长用户名截断');
  assert.ok((await desktop.getByTestId('nav-rail-settings').boundingBox()).x < 252, '长用户名不挤出设置按钮');
  await desktop.evaluate(async () => (await import('/src/store/settings.ts')).useSettings.getState().update({ userName: '', uiLanguage: 'en-US' }));
  await desktop.getByTestId('account-name').filter({ hasText: 'User' }).waitFor();
  await desktop.getByTestId('nav-rail-account').click();
  assert.deepEqual(await desktop.getByRole('menuitem').allTextContents(), ['Settings', 'Archived', 'Log out']);

  const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.getByTestId('nav-rail-open').click();
  await checkRow(phone);
  await openMenu(phone);
  await phone.screenshot({ path: `${out}/phone-menu.png` });
  await phone.getByTestId('account-menu-archived').click();
  await phone.getByTestId('archived-empty').waitFor();
  const dialog = await phone.getByTestId('archived-sessions-dialog').boundingBox();
  assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= 390, '手机归档列表不超出屏幕');
  await phone.getByRole('button', { name: '关闭已归档', exact: true }).click();
  await phone.getByTestId('archived-sessions-dialog').waitFor({ state: 'hidden' });
  await openMenu(phone);
  await phone.getByTestId('account-menu-settings').click();
  await phone.getByTestId('settings-modal').waitFor();
  await phone.getByRole('dialog', { name: 'DeepStudent Go', exact: true }).waitFor({ state: 'hidden' });
  await closeSettings(phone);
  await phone.getByTestId('nav-rail-open').click();
  await phone.getByTestId('nav-rail-settings').click();
  await phone.getByTestId('settings-modal').waitFor();
  await closeSettings(phone);

  // 在隔离的页面里切换账号状态，所有请求均由 fixture 截获，绝不登出真实账号。
  const cloudPage = await newPage();
  let logoutRequests = 0;
  let failSync = true;
  let failLogout = false;
  await cloudPage.route('**/api/v1/cloud/config', route => route.fulfill({ json: { providers: [], llmModel: {}, visionModel: {}, asrModel: {}, policy: { maxSteps: 100 } } }));
  await cloudPage.route('**/api/v1/cloud/records?*', route => route.fulfill(failSync
    ? { status: 503, json: { error: 'offline-fixture' } }
    : { json: { records: [], cursor: 0, more: false } }));
  await cloudPage.route('**/api/v1/auth/logout', route => {
    logoutRequests++;
    return route.fulfill(failLogout ? { status: 503, json: { error: 'logout-fixture-error' } } : { json: { ok: true } });
  });
  await cloudPage.evaluate(async () => {
    (await import('/src/cloud/state.ts')).cloud.enabled = true;
    // 触发订阅让页脚重新读取账号状态。
    (await import('/src/store/settings.ts')).useSettings.getState().update({ userName: '云端用户' });
  });
  await openMenu(cloudPage);
  await cloudPage.getByTestId('account-menu-logout').click();
  await cloudPage.getByTestId('confirm-dialog-danger').waitFor();
  await cloudPage.getByTestId('confirm-dialog-cancel').click();
  assert.equal(logoutRequests, 0, '取消不同步退出时不发送登出请求');
  await cloudPage.getByTestId('nav-rail-account').waitFor({ state: 'visible' });
  await openMenu(cloudPage);
  await cloudPage.getByTestId('account-menu-logout').click();
  await cloudPage.getByTestId('confirm-dialog-danger').waitFor();
  const reload = cloudPage.waitForEvent('load');
  await cloudPage.getByTestId('confirm-dialog-confirm').click();
  await reload;
  await cloudPage.getByTestId('nav-rail-account').waitFor();
  assert.equal(logoutRequests, 1, '确认后登出并重新加载登录入口');

  failSync = false;
  failLogout = true;
  await cloudPage.evaluate(async () => {
    (await import('/src/cloud/state.ts')).cloud.enabled = true;
    (await import('/src/store/settings.ts')).useSettings.getState().update({ userName: '云端用户' });
  });
  await openMenu(cloudPage);
  await cloudPage.getByTestId('account-menu-logout').click();
  await cloudPage.getByText('logout-fixture-error', { exact: true }).waitFor();
  assert.equal(logoutRequests, 2, '同步成功后直接登出；登出失败会提示且保留当前页面');
  assert.equal(await cloudPage.getByTestId('course-chat-page').isVisible(), true);

  assert.deepEqual(errors, []);
  console.log(`Sidebar account passed (desktop light/dark, keyboard, collapsed, mobile, archives, guarded logout). Screenshots: ${out}`);
} finally {
  await browser.close();
}
