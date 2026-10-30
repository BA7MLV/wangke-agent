import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5198';
const output = process.env.SHOTS || 'test-results/reasoning-theme';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/#/chat`);
  await page.getByRole('button', { name: '添加内容或调整模型', exact: true }).click();
  await page.getByTestId('model-picker').click();
  const depth = page.getByRole('slider', { name: '思考深度', exact: true });
  await depth.waitFor();
  await depth.click({ trial: true }); // Wait for the enclosing popover's opening transform.
  assert.equal(await page.locator('.effect-panel, [data-testid="reasoning-effect-panel"]').count(), 0, 'no effect settings UI');
  const states = [];
  await depth.focus(); await depth.press('Home');
  for (let i = 0; i < 6; i++) {
    if (i) await depth.press('ArrowRight');
    states.push(await page.locator('.reasoning-slider__fill').evaluate(el => ({ opacity: +el.style.opacity, width: el.style.width })));
  }
  assert.equal(await depth.inputValue(), '5');
  assert.ok(states.every((s, i) => i === 0 || s.opacity > states[i - 1].opacity));
  assert.equal(states[0].width, '0%');
  assert.equal(states[5].width, '100%');
  assert.equal(await page.locator('.reasoning-slider__track').evaluate(el => el.getBoundingClientRect().height), 36);
  const inputBox = await depth.boundingBox();
  assert.equal(inputBox.height, 64, 'large, comfortable click/touch area');
  assert.ok(inputBox.width >= 280, 'rail uses the full panel width');
  assert.equal(await page.locator('.reasoning-slider__labels').count(), 0, 'no extra text row');
  const texture = page.getByTestId('reasoning-meteor-texture');
  await page.waitForFunction(() => document.querySelector('[data-testid="reasoning-meteor-texture"]')?.width > 100);
  const before = await texture.evaluate(el => el.toDataURL());
  await page.waitForFunction(image => document.querySelector('[data-testid="reasoning-meteor-texture"]').toDataURL() !== image, before);
  assert.equal(await page.locator('.reasoning-slider__header label').count(), 1);
  const ticks = await page.locator('.reasoning-slider__tick').evaluateAll(elements => elements.map(el => {
    const box = el.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }));
  for (let i = 0; i < ticks.length; i++) {
    await page.mouse.click(ticks[i].x, ticks[i].y);
    assert.equal(await depth.inputValue(), String(i), `tick ${i} matches native thumb position`);
  }
  // The visually empty area above the rail is still an active pointer target.
  await page.mouse.click(ticks[2].x, inputBox.y + 3);
  assert.equal(await depth.inputValue(), '2');
  await depth.focus(); await depth.press('End');
  assert.equal(await depth.evaluate(el => el.matches(':focus-visible')), true);
  // Pointer presentation should match the reference, without a keyboard focus ring.
  await page.getByRole('searchbox', { name: '搜索已添加模型', exact: true }).click();
  await page.mouse.click(ticks[5].x, ticks[5].y);
  await page.mouse.move(0, 0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await page.locator('.model-picker__panel').screenshot({ path: `${output}/desktop-${theme}.png`, animations: 'disabled' });
    await page.getByTestId('chat-effort-slider').screenshot({ path: `${output}/slider-${theme}.png`, animations: 'disabled' });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.reasoning-slider__fill').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  const paused = await texture.evaluate(el => el.toDataURL());
  await page.waitForTimeout(400);
  assert.equal(await texture.evaluate(el => el.toDataURL()), paused, 'reduced motion freezes the meteor texture');
  const originalAccent = await page.evaluate(() => ({
    accent: document.documentElement.style.getPropertyValue('--accent'),
    foreground: document.documentElement.style.getPropertyValue('--accent-foreground'),
  }));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    const palettes = [], images = [];
    for (const accent of ['blue', 'violet', 'rose', 'orange', 'green', 'amber']) {
      await page.evaluate(async accent => {
        const { applyAccentColor } = await import('/src/ui/theme.ts');
        applyAccentColor(accent);
      }, accent);
      palettes.push(await page.getByTestId('chat-effort-slider').evaluate(el => ({
        fill: getComputedStyle(el.querySelector('.reasoning-slider__fill')).backgroundImage,
        ring: getComputedStyle(el.querySelector('.reasoning-slider__control')).boxShadow,
        rest: getComputedStyle(el.querySelector('.reasoning-slider__track')).backgroundColor,
        ink: getComputedStyle(el.querySelector('.reasoning-slider__value')).color,
        streak: getComputedStyle(el.querySelector('canvas')).color,
      })));
      images.push(await texture.evaluate(el => el.toDataURL()));
      await page.getByTestId('chat-effort-slider').screenshot({ path: `${output}/slider-${theme}-${accent}.png`, animations: 'disabled' });
    }
    for (const key of ['fill', 'ring', 'rest', 'ink', 'streak']) {
      assert.equal(new Set(palettes.map(p => p[key])).size, 6, `${theme}: ${key} follows all six theme accents`);
    }
    assert.equal(new Set(images).size, 6, `${theme}: frozen canvas repaints to match each accent`);
  }
  await page.evaluate(({ accent, foreground }) => {
    const root = document.documentElement;
    if (accent) root.style.setProperty('--accent', accent); else root.style.removeProperty('--accent');
    if (foreground) root.style.setProperty('--accent-foreground', foreground); else root.style.removeProperty('--accent-foreground');
  }, originalAccent);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const resumed = await texture.evaluate(el => el.toDataURL());
  await page.waitForFunction(image => document.querySelector('[data-testid="reasoning-meteor-texture"]').toDataURL() !== image, resumed);
  await page.locator('.reasoning-slider__meteors').evaluate(el => el.style.display = 'none');
  await page.waitForTimeout(100); // IntersectionObserver delivers asynchronously.
  const offscreen = await texture.evaluate(el => el.toDataURL());
  await page.waitForTimeout(400);
  assert.equal(await texture.evaluate(el => el.toDataURL()), offscreen, 'invisible texture stops drawing');
  await page.locator('.reasoning-slider__meteors').evaluate(el => el.style.display = '');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.model-picker__panel').screenshot({ path: `${output}/mobile-dark.png`, animations: 'disabled' });
  const box = await page.locator('.model-picker__panel').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator('.model-picker__panel').screenshot({ path: `${output}/small-mobile-dark.png`, animations: 'disabled' });
  const smallBox = await page.locator('.model-picker__panel').boundingBox();
  assert.ok(smallBox.x >= 0 && smallBox.x + smallBox.width <= 320 && smallBox.y + smallBox.height <= 568);
  await depth.focus(); await depth.press('Home');
  assert.equal(await depth.getAttribute('aria-valuetext'), '不思考');
  assert.equal(await page.locator('.reasoning-slider__meteors').evaluate(el => el.style.opacity), '0');
  const idle = await texture.evaluate(el => el.toDataURL());
  assert.equal(await texture.evaluate(el => {
    const pixels = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
    return pixels.some((value, i) => i % 4 === 3 && value !== 0);
  }), false, 'off clears all remaining light trails');
  await page.waitForTimeout(400);
  assert.equal(await texture.evaluate(el => el.toDataURL()), idle, 'no-thinking is still');
  assert.deepEqual(errors, []);
  console.log('PASS: six accents × light/dark; theme-colored rail/ring/label/trails; paused canvas recolors; six levels; warp motion; reduced-motion/offscreen pause; mobile; no settings UI.');
} finally { await browser.close(); }
