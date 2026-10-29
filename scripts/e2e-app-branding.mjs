import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5196';
const out = process.env.SHOTS || 'test-results/app-branding';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.goto(base);
  const menu = page.getByTestId('nav-rail-open');
  const newSession = page.getByTestId('chat-new-session');
  await menu.waitFor();
  await newSession.waitFor();
  const svg = await readFile(new URL('../apps/web/public/icon.svg', import.meta.url), 'utf8');
  const logo = await readFile(new URL('../apps/web/src/ui/BrandLogo.tsx', import.meta.url), 'utf8');
  assert.deepEqual([...svg.matchAll(/ d="([^"]+)"/g)].map(match => match[1]),
    [...logo.matchAll(/ d="([^"]+)"/g)].map(match => match[1]), 'favicon uses the supplied logo paths');
  const favicon = await page.locator('link[rel="icon"]').getAttribute('href');
  assert.match(favicon, /^\/icon\.svg\?v=deepstudent$/);
  const response = await page.request.get(new URL(favicon, base).href);
  assert.equal(response.status(), 200);
  assert.equal(await response.text(), svg);

  const appearance = button => button.evaluate(el => {
    const css = getComputedStyle(el);
    return Object.fromEntries(['width', 'height', 'borderTopWidth', 'borderTopStyle', 'borderTopColor',
      'borderRadius', 'backgroundColor', 'color'].map(key => [key, css[key]]));
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(async theme => {
      const path = '/src/store/settings.ts';
      const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      const { useSettings } = await import(entry?.name ?? path);
      useSettings.setState({ theme });
    }, theme);
    await page.waitForFunction(theme => document.documentElement.classList.contains('dark') === (theme === 'dark'), theme);
    const style = await appearance(menu);
    assert.equal(style.width, '44px');
    assert.equal(style.height, '44px');
    assert.equal(style.borderTopWidth, '1px');
    assert.equal(style.borderTopStyle, 'solid');
    assert.deepEqual(style, await appearance(newSession), `${theme}: hamburger and new session have matching borders and surfaces`);
    assert.equal(await menu.locator('svg.tabler-icon-menu-2').count(), 1);
    await page.screenshot({ path: `${out}/${theme}-mobile.png`, animations: 'disabled' });
    await menu.click();
    const drawer = page.getByRole('dialog', { name: 'DeepStudent Go' });
    await drawer.waitFor();
    await drawer.getByRole('button', { name: '关闭导航' }).click();
    await drawer.waitFor({ state: 'detached' });
  }
  for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    const pixels = await page.evaluate(async name => {
      const image = new Image();
      image.src = `/${name}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = image.naturalWidth;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      let colored = 0;
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i] < 128) dark++;
        if (rgba[i] !== rgba[i + 1] || rgba[i + 1] !== rgba[i + 2]) colored++;
      }
      return { width: image.naturalWidth, height: image.naturalHeight, dark, colored };
    }, name);
    assert.equal(pixels.width, size);
    assert.equal(pixels.height, size);
    assert(pixels.dark > size * size / 4, `${name}: contains the dark logo`);
    assert.equal(pixels.colored, 0, `${name}: no old blue icon remains`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('nav-rail-toggle').waitFor();
  assert.equal(await menu.count(), 0, 'desktop retains its own sidebar toggle');
  assert.deepEqual(errors, []);
  console.log('PASS: supplied DeepStudent favicon and PNG icons; matching mobile toolbar borders in light/dark; drawer and desktop controls.');
} finally {
  await browser.close();
}
