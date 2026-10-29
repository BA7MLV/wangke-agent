import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

/*
 * 主页 = 对话，Bot = 右侧辅助栏。验证：
 *   - 宽屏：左侧仍是 HeroUI 导航（没有 Telegram 式搜索顶行 / 筛选 / 悬浮新建），
 *     「资源」下面的 Bot 导航打开右侧栏，主列不被遮住；
 *   - 手机：Bot 以全屏面板推入，右上角关闭；「新会话」在顶栏；
 *   - #/bot 旧链接打开 Bot 栏并回到主页。
 */
const base = process.env.BASE_URL || 'http://localhost:4173';
const out = process.env.SHOTS || 'test-results/home-bot-panel';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  desktop.on('pageerror', (error) => errors.push(error.message));
  await desktop.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await desktop.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await desktop.goto(base);
  await desktop.getByTestId('course-chat-page').waitFor();
  assert.equal(await desktop.getByTestId('chat-sidebar-menu').count(), 0, 'Telegram 侧栏顶行不应存在');
  assert.equal(await desktop.getByTestId('chat-search').count(), 0);
  await desktop.getByTestId('nav-rail-chat').waitFor();
  assert.deepEqual(await desktop.locator('.page-shell__nav-item').allTextContents(), ['主页', '资源', 'Bot']);
  assert.equal(await desktop.getByTestId('chat-bot-toggle').count(), 0, '顶栏不应重复显示 Bot 入口');
  await desktop.screenshot({ path: `${out}/desktop-home.png` });
  await desktop.getByTestId('nav-rail-bot').click();
  await desktop.getByTestId('app-aside').waitFor();
  assert.equal(await desktop.getByTestId('nav-rail-bot').getAttribute('aria-current'), 'page');
  await desktop.waitForTimeout(800);
  await desktop.screenshot({ path: `${out}/desktop-bot.png` });
  assert.ok(await desktop.getByTestId('course-chat-page').isVisible(), '主列在 Bot 打开时仍可见');
  await desktop.getByTestId('bot-panel-close').click();
  await desktop.getByTestId('app-aside').waitFor({ state: 'detached' });
  assert.equal(await desktop.getByTestId('nav-rail-bot').getAttribute('aria-current'), null);
  await desktop.getByTestId('nav-rail-home').click();
  await desktop.waitForURL('**/#/library');
  await desktop.locator('[data-testid="nav-rail-home"][aria-current="page"]').waitFor();
  await desktop.getByTestId('nav-rail-bot').click();
  await desktop.getByTestId('course-chat-page').waitFor();
  await desktop.getByTestId('app-aside').waitFor();
  await desktop.getByTestId('bot-panel-close').click();
  await desktop.getByTestId('app-aside').waitFor({ state: 'detached' });
  await desktop.getByTestId('nav-rail-toggle').click();
  await desktop.getByTestId('nav-rail-compact').waitFor();
  await desktop.getByTestId('nav-rail-bot').click();
  await desktop.getByTestId('app-aside').waitFor();

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  phone.on('pageerror', (error) => errors.push(error.message));
  await phone.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await phone.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await phone.goto(base);
  await phone.getByTestId('course-chat-page').waitFor();
  await phone.getByTestId('chat-new-session').waitFor();
  await phone.screenshot({ path: `${out}/phone-home.png` });
  await phone.getByTestId('nav-rail-open').click();
  await phone.getByTestId('nav-rail-bot').click();
  await phone.getByTestId('app-aside').waitFor();
  await phone.getByRole('dialog', { name: 'DeepStudent Go', exact: true }).waitFor({ state: 'hidden' });
  await phone.waitForTimeout(800);
  const box = await phone.getByTestId('app-aside').boundingBox();
  assert.ok(box && box.width >= 389, `手机上 Bot 面板应铺满宽度，实际 ${box?.width}`);
  await phone.screenshot({ path: `${out}/phone-bot.png` });
  await phone.getByTestId('bot-panel-close').click();
  await phone.getByTestId('nav-rail-open').click();
  await phone.waitForTimeout(600);
  await phone.screenshot({ path: `${out}/phone-nav.png` });

  await phone.goto(`${base}/#/bot?thread=demo`);
  await phone.getByTestId('app-aside').waitFor();
  assert.ok(!phone.url().includes('/bot'), '#/bot 应回到主页');

  assert.deepEqual(errors, []);
  console.log(`Home/Bot panel passed. Screenshots: ${out}`);
} finally {
  await browser.close();
}
