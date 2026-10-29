import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Isolated browser profile; no model requests or changes to the user's conversations.
const base = process.env.BASE_URL || 'http://localhost:5192';
const out = process.env.SHOTS || 'test-results/sidebar-controls';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.addInitScript(() => {
    window.loadTestModule = path => {
      const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(entry?.name ?? path);
    };
  });
  await page.goto(base);
  await page.waitForFunction(() => !document.querySelector('textarea.course-chat__input')?.disabled);

  const toggle = page.getByTestId('nav-rail-toggle');
  const newChat = page.getByTestId('nav-rail-chat');
  const checkToggle = async label => {
    const expanded = label === '收起侧边栏';
    assert.equal(await toggle.getAttribute('aria-label'), label);
    assert.equal(await toggle.getAttribute('aria-expanded'), String(expanded));
    assert.equal(await toggle.locator('svg[viewBox="182 192 650 650"]').count(), expanded ? 0 : 1,
      'only the collapsed toggle uses the brand logo');
    assert.equal(await toggle.locator('svg.tabler-icon-layout-sidebar').count(), expanded ? 1 : 0,
      'expanded sidebar has a separate panel toggle');
    const { width, height } = await toggle.boundingBox();
    assert(width >= 44 && height >= 44, 'toggle retains a touch-sized target');
    const brand = page.getByTestId('app-brand');
    assert.equal(await brand.getAttribute('aria-label'), 'DeepStudent Go');
    if (expanded) {
      const brandBox = await brand.boundingBox();
      const toggleBox = await toggle.boundingBox();
      assert(toggleBox.x >= brandBox.x + brandBox.width, 'collapse button sits to the right of the brand');
    }
  };
  const checkNeutral = async (button, label, selected = 'page', textColor = '--foreground') => {
    await button.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
    const colors = await button.evaluate((el, textColor) => {
      const probe = document.createElement('span');
      el.append(probe);
      const resolve = property => {
        probe.style.color = `var(${property})`;
        return getComputedStyle(probe).color;
      };
      const result = {
        foreground: resolve(textColor),
        color: getComputedStyle(el).color,
        icon: getComputedStyle(el.querySelector('svg')).color,
        background: getComputedStyle(el).backgroundColor,
        hoverBackground: resolve('--button-bg-hover'),
        persistentHover: el.classList.contains('page-shell__new-chat') && el.getAttribute('data-pressed') !== 'true',
        accent: resolve('--accent'),
        accentSoft: resolve('--accent-soft'),
        selected: el.getAttribute('aria-selected') ?? el.getAttribute('aria-current'),
      };
      probe.remove();
      return result;
    }, textColor);
    assert.equal(colors.color, colors.foreground, `${label}: neutral text`);
    assert.equal(colors.icon, colors.foreground, `${label}: neutral icon`);
    assert.notEqual(colors.background, colors.accent, `${label}: no accent background`);
    assert.notEqual(colors.background, colors.accentSoft, `${label}: no soft accent background`);
    assert.equal(colors.selected, selected, `${label}: home is a selected destination; new-session toolbar remains an action`);
    if (colors.persistentHover) {
      assert.equal(colors.background, colors.hoverBackground, `${label}: default appearance matches hover`);
    }
  };
  const checkSelected = async label => {
    const item = page.getByTestId('nav-rail-home');
    assert.equal(await page.getByRole('link', { name: '资源', exact: true }).getAttribute('data-testid'), 'nav-rail-home',
      `${label}: resources retain link semantics`);
    assert.equal(await item.getAttribute('href'), '#/library', `${label}: resources expose a copyable URL`);
    assert.equal(await newChat.evaluate(el => el.tagName), 'BUTTON', `${label}: home remains an action`);
    await item.click();
    if (page.viewportSize().width <= 900) {
      await page.getByRole('dialog', { name: 'DeepStudent Go' }).waitFor({ state: 'detached' });
      // Suspense may briefly retain the previous PageShell as hidden DOM.
      await page.getByRole('button', { name: '打开导航', exact: true }).click();
    }
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="nav-rail-home"]');
      if (el?.getAttribute('aria-selected') !== 'true' && el?.getAttribute('aria-current') !== 'page') return false;
      const probe = document.createElement('span');
      el.append(probe);
      probe.style.backgroundColor = 'var(--surface)';
      probe.style.color = 'var(--foreground)';
      const matches = getComputedStyle(el).backgroundColor === getComputedStyle(probe).backgroundColor
        && getComputedStyle(el).color === getComputedStyle(probe).color;
      probe.remove();
      return matches;
    });
    assert.equal(await item.locator('svg').evaluate(el => getComputedStyle(el).color),
      await item.evaluate(el => getComputedStyle(el).color), `${label}: selected icon inherits neutral text`);
    await newChat.click();
  };
  const checkInteractionColors = async (button, label, selected = 'page', idleTextColor = '--foreground') => {
    await page.mouse.move(1000, 700);
    await checkNeutral(button, label, selected, idleTextColor);
    await button.hover();
    await checkNeutral(button, `${label} hovered`, selected);
    await page.mouse.down();
    await checkNeutral(button, `${label} pressed`, selected);
    await page.mouse.up();
  };

  for (const theme of ['light', 'dark']) {
    await page.evaluate(async theme => {
      const { useSettings } = await window.loadTestModule('/src/store/settings.ts');
      useSettings.setState({ theme });
    }, theme);
    await page.waitForFunction(theme => document.documentElement.classList.contains('dark') === (theme === 'dark'), theme);
    await checkToggle('收起侧边栏');
    await checkInteractionColors(newChat, `${theme} expanded`);
    await checkInteractionColors(page.getByTestId('nav-rail-home'), `${theme} expanded resources`, null, '--muted');
    await newChat.click();
    await checkSelected(`${theme} expanded`);
    await page.screenshot({ path: `${out}/${theme}-expanded.png`, animations: 'disabled' });
    await toggle.click();
    await page.getByTestId('nav-rail-compact').waitFor();
    await checkToggle('展开侧边栏');
    await checkInteractionColors(newChat, `${theme} compact`);
    await checkInteractionColors(page.getByTestId('nav-rail-home'), `${theme} compact resources`, null);
    await newChat.click();
    await checkSelected(`${theme} compact`);
    await page.screenshot({ path: `${out}/${theme}-compact.png`, animations: 'disabled' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('nav-rail').waitFor();
    await checkToggle('收起侧边栏');
  }

  await toggle.click();
  await page.reload();
  await page.getByTestId('nav-rail-compact').waitFor();
  await checkToggle('展开侧边栏');
  await toggle.click();
  await page.getByTestId('nav-rail').waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMenu = page.getByTestId('nav-rail-open');
  await mobileMenu.waitFor({ state: 'visible' });
  assert.equal(await mobileMenu.locator('svg.tabler-icon-menu-2').count(), 1, 'mobile keeps the hamburger menu');
  assert.equal(await mobileMenu.locator('svg[viewBox="182 192 650 650"]').count(), 0, 'mobile menu is not replaced by the logo');
  await mobileMenu.click();
  const drawer = page.getByRole('dialog', { name: 'DeepStudent Go' });
  await drawer.waitFor();
  await checkNeutral(newChat, 'mobile drawer');
  await checkSelected('mobile drawer');
  await drawer.waitFor({ state: 'detached' });
  await page.getByTestId('nav-rail-open').click();
  await drawer.waitFor();
  await page.screenshot({ path: `${out}/mobile-drawer.png`, animations: 'disabled' });
  await newChat.click();
  await drawer.waitFor({ state: 'detached' });
  await checkNeutral(page.getByTestId('chat-new-session'), 'mobile app bar', null);
  assert.deepEqual(errors, []);
  console.log('PASS: desktop panel toggle, collapsed logo, persistence and keyboard controls; mobile hamburger; home and resource navigation stay neutral in light/dark, compact, and mobile navigation.');
} finally {
  await browser.close();
}
