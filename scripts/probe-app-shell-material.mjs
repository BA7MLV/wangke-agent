/* eslint-disable no-console */
// Only synthetic, empty-profile state. Run after a local dev/preview server starts:
// BASE_URL=http://127.0.0.1:5180 node scripts/probe-app-shell-material.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = (process.env.BASE_URL || 'http://127.0.0.1:5180').replace(/\/$/, '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Use a local test server');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
const routes = [['/', 'home', '课程库'], ['/chat', 'chat', '课程助手'], ['/study', 'study', '学习'], ['/settings', 'settings', '设置']];
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
// mdui-top-app-bar-title projects slotted light-DOM content into its open shadow
// tree. Playwright's default locator traversal sees that projection twice, so
// target the authored light-DOM heading for native heading assertions.
const titleHeading = page.locator('mdui-top-app-bar > mdui-top-app-bar-title > h1.app-bar__title');
const go = async (path) => { await page.goto(`${base}/#${path}`, { waitUntil: 'networkidle' }); await titleHeading.waitFor(); await settle(); };

try {
  await go('/');
  const toggle = page.locator('[data-testid="nav-rail-toggle"]');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await toggle.evaluate((element) => !!document.getElementById(element.getAttribute('aria-controls'))), true);
  await toggle.press('Enter');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await toggle.getAttribute('aria-label'), '展开侧边栏');
  assert.equal(await page.locator('.app-sidebar').getAttribute('data-collapsed'), 'true');
  const compact = await page.locator('.app-sidebar__item').evaluateAll((items) => items.map((item) => {
    const label = item.querySelector('.app-sidebar__item-label');
    const icon = item.querySelector('.app-sidebar__item-icon');
    const labelBox = label.getBoundingClientRect();
    const iconBox = icon.getBoundingClientRect();
    return { label: label.textContent.trim(), visible: labelBox.width > 0 && labelBox.height > 0 && getComputedStyle(label).visibility !== 'hidden',
      indicator: getComputedStyle(icon).backgroundColor, width: iconBox.width, height: iconBox.height, active: item.getAttribute('aria-current') === 'page' };
  }));
  assert.deepEqual(compact.map((item) => item.label), routes.map(([, , label]) => label));
  assert(compact.every((item) => item.visible), 'Compact rail keeps four visible labels');
  const active = compact.find((item) => item.active);
  assert(active && active.width >= 48 && active.height >= 28, 'Selected rail icon has a visible pill indicator');
  assert.notEqual(active.indicator, compact.find((item) => !item.active).indicator);
  await toggle.press('Space');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await toggle.getAttribute('aria-label'), '收起侧边栏');
  console.log('✓ Desktop compact rail labels, indicator, and collapse semantics');

  await page.setViewportSize({ width: 390, height: 844 });
  await settle();
  const bottom = page.locator('[data-testid="bottom-nav"]');
  assert.equal(await bottom.isVisible(), true);
  assert.equal(await bottom.getAttribute('label-visibility'), 'labeled');
  assert.equal(await bottom.locator('mdui-navigation-bar-item').count(), 4);
  assert.equal(await page.locator('[data-testid="nav-rail"]').isVisible(), false);
  for (const [path, key] of [routes[1], routes[2], routes[3], routes[0]]) {
    const item = page.locator(`[data-testid="nav-bottom-${key}"]`);
    await item.focus();
    await item.press(key === 'chat' || key === 'settings' ? 'Space' : 'Enter');
    await page.waitForURL(`${base}/#${path}`);
    assert.equal(await item.getAttribute('aria-current'), 'page');
  }
  console.log('✓ Phone bottom navigation shows four labels and supports Space/Enter');

  for (const theme of ['light', 'dark']) {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      for (const [path, key, title] of routes) {
        await go(path);
        await page.evaluate((value) => {
          document.documentElement.classList.remove('mdui-theme-auto', 'mdui-theme-light', 'mdui-theme-dark');
          document.documentElement.classList.add(`mdui-theme-${value}`);
        }, theme);
        await settle();
        const scope = `${theme} ${viewport.width}×${viewport.height} ${path}`;
        assert.equal(await page.locator('mdui-top-app-bar > mdui-top-app-bar-title > h1').count(), 1, `${scope}: exactly one authored native H1`);
        assert.equal(await titleHeading.innerText(), title);
        assert(await page.locator('.section-card__title').evaluateAll((headings) => headings.every((heading) => heading.tagName === 'H2')), `${scope}: native section H2`);
        if (key === 'settings' || key === 'study') assert(await page.locator('.section-card h2').count() > 0, `${scope}: sections retain headings`);
        const railVisible = await page.locator('[data-testid="nav-rail"]').isVisible();
        const bottomVisible = await bottom.isVisible();
        assert(railVisible || bottomVisible, `${scope}: at least one main navigation stays visible`);
        const activeNav = page.locator(`[data-testid="nav-${railVisible ? 'rail' : 'bottom'}-${key}"]`);
        assert.equal(await activeNav.getAttribute('aria-current'), 'page');
        const geometry = await page.evaluate(() => [...document.querySelectorAll('.app-sidebar, .app-bar, .page-inner, [data-testid="bottom-nav"]')]
          .filter((element) => element.getClientRects().length > 0).map((element) => {
            const box = element.getBoundingClientRect();
            return { name: element.className || element.tagName, left: box.left, right: box.right };
          }));
        for (const box of geometry) assert(box.left >= -1 && box.right <= viewport.width + 1, `${scope}: ${box.name} exceeds the viewport`);
        assert(await page.locator('.page-inner').evaluate((inner) => inner.scrollWidth <= inner.clientWidth + 1), `${scope}: content has no horizontal overflow`);
        const hash = new URL(page.url()).hash;
        await page.locator('.skip-link').focus();
        await page.locator('.skip-link').press('Enter');
        assert.equal(new URL(page.url()).hash, hash, `${scope}: skip link preserves HashRouter route`);
        assert.equal(await page.locator('mdui-layout-main').evaluate((main) => document.activeElement === main), true, `${scope}: main receives focus`);
      }
    }
  }
  assert.deepEqual(errors, [], 'No uncaught page errors');
  console.log('✓ All four routes retain navigation, heading hierarchy, skip focus, and light/dark viewport fit');
} finally {
  await context.close();
  await browser.close();
}
