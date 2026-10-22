// Run against Vite: BASE_URL=http://localhost:5188 node scripts/e2e-icons.mjs
// Isolated browser context: no changes to the user's settings or library.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5188';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ reducedMotion: 'reduce', serviceWorkers: 'block' });
const errors = [];
const warnings = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.text().includes('[Sym]')) warnings.push(message.text());
});

try {
  await page.route('**/__icons-test', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<html><head><title>Tabler icon regression</title></head><body><div id="root"></div></body></html>',
  }));
  await page.goto(`${base}/__icons-test`);
  const counts = await page.evaluate(async () => {
    const { default: refresh } = await import('/@react-refresh');
    refresh.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { Sym, SYMBOL_NAMES } = await import('/src/ui/icons.tsx');
    const { playerLayoutIcons } = await import('/src/ui/player-icons.tsx');
    const { SuccessCheck } = await import('/src/components/motion.tsx');
    await import('/node_modules/@heroui/styles/dist/index.css');
    await import('/src/theme.css');
    await import('/src/transitions.css');
    const h = React.createElement;
    const mediaIcons = Object.entries(playerLayoutIcons).flatMap(([group, icons]) =>
      Object.entries(icons).map(([name, Icon]) => h(Icon, {
        key: `${group}.${name}`, 'data-media-icon': `${group}.${name}`,
        className: 'vds-icon', width: 24, height: 24,
      })));
    ReactDOM.createRoot(document.getElementById('root')).render(h('div', null,
      ...SYMBOL_NAMES.flatMap((name) => [false, true].map((filled) => h('span', {
        key: `${name}:${filled}`, 'data-symbol': name, 'data-filled': String(filled),
      }, h(Sym, { name, filled })))),
      ...mediaIcons,
      h(Sym, { name: 'star-half', filled: true, 'data-testid': 'kebab-filled' }),
      h(Sym, { name: 'check', filled: true, 'data-testid': 'filled-fallback' }),
      h(Sym, { name: 'cloud_upload', style: { fontSize: 40 }, 'data-testid': 'font-sized' }),
      h(Sym, { name: 'check', size: 18, 'data-testid': 'explicit-sized' }),
      h(Sym, { name: 'check', size: '2em', 'data-testid': 'string-sized' }),
      h(Sym, { name: 'check', size: 40, className: 'size-5', 'data-testid': 'class-sized' }),
      h(Sym, { name: 'check', decorative: false, role: 'img', 'aria-label': '已完成', 'data-testid': 'accessible' }),
      h('span', { 'data-testid': 'unknown' }, h(Sym, { name: 'unknown-icon-for-test' })),
      h(SuccessCheck, { size: 14, color: '#16a34a' }),
    ));
    return { symbols: SYMBOL_NAMES.length, media: mediaIcons.length };
  });
  await page.getByTestId('class-sized').waitFor();
  assert.equal(await page.locator('[data-symbol] > svg.tabler-icon').count(), counts.symbols * 2);
  assert.equal(await page.locator('[data-media-icon].tabler-icon.vds-icon').count(), counts.media);
  const iconProblems = await page.locator('[data-symbol] > svg, [data-media-icon]').evaluateAll((icons) =>
    icons.flatMap((icon) => {
      const rect = icon.getBoundingClientRect();
      const issues = [];
      if (rect.width <= 0 || rect.height <= 0 || rect.width > 48 || rect.height > 48) issues.push('size');
      if (icon.getAttribute('aria-hidden') !== 'true' || icon.getAttribute('focusable') !== 'false') issues.push('accessibility');
      if (icon.getAttribute('fill') === 'none' && icon.getAttribute('stroke-width') !== '1.75') issues.push('stroke');
      return issues.length ? [{ name: icon.parentElement.dataset.symbol || icon.dataset.mediaIcon, issues }] : [];
    }));
  assert.deepEqual(iconProblems, []);
  for (const name of ['star', 'star_half', 'play', 'image', 'folder', 'mic', 'stop', 'pin']) {
    const filled = page.locator(`[data-symbol="${name}"][data-filled="true"] > svg`);
    assert.match(await filled.getAttribute('class'), /-filled\b/);
    assert.equal(await filled.getAttribute('fill'), 'currentColor');
    assert.equal(await filled.getAttribute('stroke'), 'none');
  }
  assert.match(await page.getByTestId('kebab-filled').getAttribute('class'), /star-half-filled/);
  assert.equal(await page.getByTestId('filled-fallback').getAttribute('fill'), 'none');
  assert.equal(await page.getByTestId('font-sized').getAttribute('width'), '1em');
  for (const [id, size] of [['font-sized', 40], ['explicit-sized', 18], ['string-sized', 32], ['class-sized', 20]]) {
    const rect = await page.getByTestId(id).boundingBox();
    assert.equal(rect.width, size, id);
    assert.equal(rect.height, size, id);
  }
  assert.equal(await page.getByTestId('accessible').getAttribute('aria-hidden'), null);
  assert.equal(await page.getByRole('img', { name: '已完成' }).count(), 1);
  assert.equal(await page.getByTestId('unknown').locator('svg').count(), 0);
  await page.waitForFunction(() => document.querySelector('.t-success-check')?.dataset.state === 'in');
  assert.equal(await page.locator('.t-success-check .tabler-icon-check').count(), 1);
  assert.equal(await page.locator('.t-success-check path').evaluate((path) =>
    parseFloat(getComputedStyle(path).strokeDasharray) > path.getTotalLength()), true);
  assert.equal(warnings.length, 1);
  assert.match(warnings.pop(), /unknown-icon-for-test/);
  console.log(`PASS ${counts.symbols} symbol mappings (outline/filled), ${counts.media} player icons, sizing, accessibility and success check`);

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['/', '/library', '/bot']) {
      await page.goto(`${base}/#${route}`);
      await page.locator('svg.tabler-icon').first().waitFor();
      assert.equal(await page.locator('svg[class*="lucide"]').count(), 0);
    }
    console.log(`PASS app routes at ${width}px`);
  }
  assert.deepEqual(warnings, []);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
