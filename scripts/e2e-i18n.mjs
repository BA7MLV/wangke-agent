import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// BASE_URL 指向 dev 或 preview；仅模拟启动探测，不访问真实账号/模型。
const BASE = process.env.BASE_URL || 'http://localhost:4173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
await mkdir('e2e-shots/i18n', { recursive: true });

async function context(options = {}, cloud = false) {
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 }, ...options });
  await ctx.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud } }));
  await ctx.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  ctx.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return ctx;
}

async function selectLanguage(page, label) {
  await page.getByTestId('ui-language-select').getByRole('button').click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await page.getByTestId('ui-language-options').waitFor({ state: 'hidden' });
}

async function localeIs(page, locale) {
  await page.waitForFunction(value => document.documentElement.lang === value, locale);
  assert.equal(await page.locator('html').getAttribute('dir'), 'ltr');
}

try {
  const ctx = await context();
  await ctx.addInitScript(() => {
    window.SpeechRecognition = class {
      start() { window.__recognizedLanguage = this.lang; this.onstart?.(); }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    };
  });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).fill('保留我的草稿 Keep my draft');
  await page.evaluate(() => {
    window.__localeComposer = document.querySelector('textarea');
    window.__localeDocument = document;
    location.hash = '/settings/appearance';
  });
  await page.getByTestId('card-appearance').waitFor();
  await localeIs(page, 'en-US');
  assert.equal(await page.title(), 'Wangke Learning Assistant');
  assert.equal(await page.getByTestId('card-appearance').getByRole('heading').textContent(), 'Appearance');
  await ctx.setOffline(true);
  await selectLanguage(page, '简体中文');
  await localeIs(page, 'zh-CN');
  assert.equal(await page.getByTestId('card-appearance').getByRole('heading').textContent(), '外观');
  assert.equal(await page.getByTestId('ui-language-select').getByRole('button').textContent(), '简体中文');
  await selectLanguage(page, 'English');
  await ctx.setOffline(false);
  await localeIs(page, 'en-US');
  assert.equal(await page.getByTestId('settings-nav-appearance').textContent(), 'Appearance');
  assert.equal(await page.evaluate(() => window.__localeComposer === document.querySelector('textarea') && window.__localeDocument === document), true);
  assert.equal(await page.locator('textarea').inputValue(), '保留我的草稿 Keep my draft');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings')).state.uiLanguage), 'en-US');
  await page.screenshot({ path: 'e2e-shots/i18n/appearance-en-desktop.png' });
  await page.reload();
  await page.getByTestId('card-appearance').waitFor();
  await localeIs(page, 'en-US');
  await selectLanguage(page, 'Follow system');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings')).state.uiLanguage), 'auto');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByTestId('chat-voice').click();
  await page.waitForFunction(() => window.__recognizedLanguage === 'zh-CN');
  await page.getByTestId('chat-voice').click();
  console.log('OK: language switching, translated labels, persistence, auto sentinel, draft and DOM preservation');
  console.log('OK: English UI keeps existing Chinese speech recognition');
  await ctx.close();

  // 旧用户即使运行在英文浏览器，升级仍保留中文与其他偏好。
  const legacy = await context();
  await legacy.addInitScript(origin => {
    if (location.origin !== origin) return;
    if (!localStorage.getItem('wangke-settings')) localStorage.setItem('wangke-settings', JSON.stringify({ version: 4, state: { theme: 'dark', fontScale: 'large' } }));
  }, new URL(BASE).origin);
  const oldPage = await legacy.newPage();
  await oldPage.goto(`${BASE}/#/settings/appearance`);
  await oldPage.getByTestId('card-appearance').waitFor();
  await localeIs(oldPage, 'zh-CN');
  assert.equal(await oldPage.locator('html').evaluate(node => node.classList.contains('dark')), true);
  assert.equal(await oldPage.locator('html').evaluate(node => node.style.fontSize), '18px');
  console.log('OK: v4 -> v5 upgrade preserves Chinese, theme, and text size');
  await legacy.close();

  const mobile = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${BASE}/#/settings/appearance`);
  await mobilePage.getByTestId('card-appearance').waitFor();
  await mobilePage.getByTestId('font-scale-select').getByRole('radio', { name: 'Extra large', exact: true }).click();
  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) {
    await mobilePage.setViewportSize(viewport);
    await mobilePage.getByTestId('card-appearance').waitFor();
    const overflow = await mobilePage.getByTestId('settings-modal').evaluate(node => node.scrollWidth > node.clientWidth + 1);
    assert.equal(overflow, false, `settings overflow at ${viewport.width}px with extra-large English text`);
  }
  await mobilePage.setViewportSize({ width: 390, height: 844 });
  await selectLanguage(mobilePage, 'English'); // 等待 Drawer 完成重新布局后再截图。
  await mobilePage.screenshot({ path: 'e2e-shots/i18n/appearance-en-mobile.png' });
  await selectLanguage(mobilePage, '简体中文');
  await localeIs(mobilePage, 'zh-CN');
  console.log('OK: narrow and tablet layouts, extra-large English labels, mobile language picker');
  await mobile.close();

  // 门禁无需登录即可访问切换器，切换后不丢账号/密码输入。
  const gate = await context({}, true);
  await gate.route('**/api/v1/bootstrap/status', route => route.fulfill({ json: { initialized: true } }));
  await gate.route('**/api/v1/auth/session', route => route.fulfill({ json: { authenticated: false, user: null } }));
  const gatePage = await gate.newPage();
  await gatePage.goto(BASE);
  await gatePage.getByTestId('ui-language-select').waitFor();
  await gatePage.locator('input[autocomplete="username"]').fill('keep-my-name');
  await gatePage.locator('input[type="password"]').fill('keep-my-password');
  await selectLanguage(gatePage, '简体中文');
  await localeIs(gatePage, 'zh-CN');
  assert.equal(await gatePage.locator('input[autocomplete="username"]').inputValue(), 'keep-my-name');
  assert.equal(await gatePage.locator('input[type="password"]').inputValue(), 'keep-my-password');
  console.log('OK: pre-login language picker preserves form input');
  await gate.close();
  assert.deepEqual(errors, [], 'browser runtime errors');
} finally {
  await browser.close();
}
