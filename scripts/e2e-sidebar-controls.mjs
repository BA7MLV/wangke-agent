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

  const logo = page.getByTestId('nav-rail-toggle');
  const newChat = page.getByTestId('nav-rail-chat');
  const checkLogo = async label => {
    assert.equal(await logo.getAttribute('aria-label'), label);
    assert.equal(await logo.getAttribute('aria-expanded'), String(label === '收起侧边栏'));
    assert.equal(await logo.locator('svg[viewBox="0 0 126 126"]').count(), 1, 'brand logo is the toggle');
    assert.equal(await logo.locator('svg.tabler-icon').count(), 0, 'no separate menu icon');
    const { width, height } = await logo.boundingBox();
    assert(width >= 44 && height >= 44, 'logo retains a touch-sized target');
  };
  const checkNeutral = async (button, label) => {
    await button.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
    const colors = await button.evaluate(el => {
      const probe = document.createElement('span');
      el.append(probe);
      const resolve = property => {
        probe.style.color = `var(${property})`;
        return getComputedStyle(probe).color;
      };
      const result = {
        foreground: resolve('--foreground'),
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
    });
    assert.equal(colors.color, colors.foreground, `${label}: neutral text`);
    assert.equal(colors.icon, colors.foreground, `${label}: neutral icon`);
    assert.notEqual(colors.background, colors.accent, `${label}: no accent background`);
    assert.notEqual(colors.background, colors.accentSoft, `${label}: no soft accent background`);
    assert.equal(colors.selected, null, `${label}: new chat is an action, not a selected destination`);
    if (colors.persistentHover) {
      assert.equal(colors.background, colors.hoverBackground, `${label}: default appearance matches hover`);
    }
  };
  const checkSelected = async label => {
    const item = page.getByTestId('nav-rail-home');
    await item.click();
    if (page.viewportSize().width <= 900) {
      await page.getByRole('dialog', { name: 'DeepStudent Go' }).waitFor({ state: 'detached' });
      await page.getByTestId('nav-rail-open').click();
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
  const checkInteractionColors = async (button, label) => {
    await page.mouse.move(1000, 700);
    await checkNeutral(button, label);
    await button.hover();
    await checkNeutral(button, `${label} hovered`);
    await page.mouse.down();
    await checkNeutral(button, `${label} pressed`);
    await page.mouse.up();
  };

  for (const theme of ['light', 'dark']) {
    await page.evaluate(async theme => {
      const { useSettings } = await window.loadTestModule('/src/store/settings.ts');
      useSettings.setState({ theme });
    }, theme);
    await page.waitForFunction(theme => document.documentElement.classList.contains('dark') === (theme === 'dark'), theme);
    await checkLogo('收起侧边栏');
    await checkInteractionColors(newChat, `${theme} expanded`);
    await checkSelected(`${theme} expanded`);
    await page.screenshot({ path: `${out}/${theme}-expanded.png`, animations: 'disabled' });
    await logo.click();
    await page.getByTestId('nav-rail-compact').waitFor();
    await checkLogo('展开侧边栏');
    await checkInteractionColors(newChat, `${theme} compact`);
    await checkSelected(`${theme} compact`);
    await page.screenshot({ path: `${out}/${theme}-compact.png`, animations: 'disabled' });
    await logo.focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('nav-rail').waitFor();
    await checkLogo('收起侧边栏');
  }

  await logo.click();
  await page.reload();
  await page.getByTestId('nav-rail-compact').waitFor();
  await checkLogo('展开侧边栏');
  await logo.click();
  await page.getByTestId('nav-rail').waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('nav-rail-open').click();
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
  await checkNeutral(page.getByTestId('chat-new-session'), 'mobile app bar');
  assert.deepEqual(errors, []);
  console.log('PASS: logo controls and persistence; new chat defaults to hover styling; selected navigation stays neutral in light/dark, compact, and mobile navigation.');
} finally {
  await browser.close();
}
