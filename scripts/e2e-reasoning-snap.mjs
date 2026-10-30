import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5198';
const output = process.env.SHOTS || 'test-results/reasoning-snap';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function openSlider(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference', serviceWorkers: 'block', ...options });
  await context.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/#/chat`);
  await page.getByRole('button', { name: '添加内容或调整模型', exact: true }).click();
  await page.getByTestId('model-picker').click();
  const input = page.getByRole('slider', { name: '思考深度', exact: true });
  await input.click({ trial: true });
  await input.focus(); await input.press('Home');
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    const { useSettings } = await import('/src/store/settings.ts');
    window.reasoningCommits = [];
    useSettings.subscribe((state, previous) => {
      if (state.thinkingEnabled !== previous.thinkingEnabled || state.thinkingEffort !== previous.thinkingEffort) {
        window.reasoningCommits.push({ enabled: state.thinkingEnabled, effort: state.thinkingEffort });
      }
    });
    window.reasoningTransitions = [];
    document.querySelector('.reasoning-slider__thumb').addEventListener('transitionrun', event => window.reasoningTransitions.push(event.propertyName));
  });
  const box = await input.boundingBox();
  const thumbSize = await input.evaluate(el => parseFloat(getComputedStyle(el).getPropertyValue('--reasoning-thumb-size')));
  const point = value => ({ x: box.x + thumbSize / 2 + (box.width - thumbSize) * value / 5, y: box.y + box.height / 2 });
  return { context, page, input, point, errors };
}

async function assertBounds(page) {
  const bounds = await page.getByTestId('chat-effort-slider').evaluate(root => {
    const rect = selector => root.querySelector(selector).getBoundingClientRect();
    const track = rect('.reasoning-slider__track'), fill = rect('.reasoning-slider__fill');
    const thumb = rect('.reasoning-slider__thumb'), control = rect('.reasoning-slider__control');
    const inside = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
    const value = Number(root.querySelector('input').value);
    return {
      value: value >= 0 && value <= 5,
      fill: inside(fill, track),
      thumb: inside(thumb, control) && thumb.left >= track.left - 0.5 && thumb.right <= track.right + 0.5,
      clip: getComputedStyle(root.querySelector('.reasoning-slider__rail-clip')).overflow === 'hidden',
    };
  });
  assert.deepEqual(bounds, { value: true, fill: true, thumb: true, clip: true }, 'value, fill, thumb and painted effects remain inside their bounds');
}

try {
  const { context, page, input, point, errors } = await openSlider();
  const start = point(0);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  const samples = [];
  for (let i = 1; i <= 18; i++) {
    const target = point(i * 2.37 / 18);
    await page.mouse.move(target.x, target.y);
    samples.push(await input.evaluate(el => {
      const root = el.closest('.reasoning-slider');
      const thumb = root.querySelector('.reasoning-slider__thumb'), fill = root.querySelector('.reasoning-slider__fill');
      const t = thumb.getBoundingClientRect(), f = fill.getBoundingClientRect();
      return { value: Number(el.value), x: t.x + t.width / 2, fill: f.right, transition: getComputedStyle(thumb).transitionDuration, dragging: root.dataset.dragging };
    }));
    assert.ok(Math.abs(samples.at(-1).x - target.x) < 1, 'thumb follows the pointer without easing lag');
    await assertBounds(page);
  }
  assert.equal(new Set(samples.map(s => s.value)).size, 18, 'dragging is continuous, not six discrete jumps');
  assert.ok(samples.every(s => Math.abs(s.x - s.fill) < 1 && s.transition === '0s' && s.dragging === 'true'), 'thumb and fill stay aligned without transitions while held');
  assert.ok(Math.abs(Number(await input.inputValue()) - 2.37) < 0.03);
  assert.equal(await page.evaluate(() => window.reasoningCommits.length), 0, 'dragging never writes global settings');
  const texture = page.getByTestId('reasoning-texture');
  const moving = await texture.evaluate(el => el.toDataURL());
  await page.waitForFunction(image => document.querySelector('[data-testid="reasoning-texture"]').toDataURL() !== image, moving);
  await page.getByTestId('chat-effort-slider').screenshot({ path: `${output}/dragging.png` });
  await page.mouse.up();
  assert.equal(await input.inputValue(), '2', 'release selects the nearest stop');
  assert.equal(await page.evaluate(() => window.reasoningCommits.length), 1, 'release writes exactly once');
  await page.waitForTimeout(220);
  assert.ok(await page.evaluate(() => window.reasoningTransitions.includes('left')), 'release animates the visual thumb to its stop');
  const settled = await page.locator('.reasoning-slider__thumb').boundingBox();
  assert.ok(Math.abs(settled.x + settled.width / 2 - point(2).x) < 1);
  await page.getByTestId('chat-effort-slider').screenshot({ path: `${output}/snapped.png` });

  // Pointer capture keeps a drag alive outside the rail, then clamps to an endpoint.
  const current = point(2);
  await page.mouse.move(current.x, current.y); await page.mouse.down();
  await page.mouse.move(point(5).x + 120, current.y - 90, { steps: 8 });
  assert.equal(await input.inputValue(), '5');
  await assertBounds(page);
  await page.mouse.up();
  assert.equal(await input.inputValue(), '5');
  assert.equal(await page.getByTestId('chat-effort-slider').getAttribute('data-dragging'), null);
  await page.mouse.move(point(5).x, current.y); await page.mouse.down();
  for (const value of [-3, 8, -2]) {
    const outside = point(value);
    await page.mouse.move(outside.x, outside.y, { steps: 8 });
    assert.equal(await input.inputValue(), value < 0 ? '0' : '5');
    await assertBounds(page);
  }
  await page.mouse.up();
  assert.equal(await input.inputValue(), '0');

  // Check every animation frame while keyboard changes animate between endpoints.
  const animationBounds = page.evaluate(async () => {
    const root = document.querySelector('.reasoning-slider');
    const frames = [];
    const start = performance.now();
    while (performance.now() - start < 500) {
      await new Promise(requestAnimationFrame);
      const t = root.querySelector('.reasoning-slider__track').getBoundingClientRect();
      const f = root.querySelector('.reasoning-slider__fill').getBoundingClientRect();
      const thumb = root.querySelector('.reasoning-slider__thumb').getBoundingClientRect();
      frames.push(f.left >= t.left - 0.5 && f.right <= t.right + 0.5 && thumb.left >= t.left - 0.5 && thumb.right <= t.right + 0.5);
    }
    return frames;
  });
  await input.press('End'); await page.waitForTimeout(90); await input.press('Home');
  const frames = await animationBounds;
  assert.ok(frames.length > 5 && frames.every(Boolean), 'snapping/reversal animations never overshoot either edge');

  // Browser/OS cancellation must revert the preview, not save a partial gesture.
  await input.press('Home'); await page.waitForTimeout(200);
  await page.evaluate(() => window.reasoningCommits = []);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  const cancelled = point(3.2);
  await page.mouse.move(cancelled.x, cancelled.y, { steps: 8 });
  await input.dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  assert.equal(await input.inputValue(), '0');
  assert.equal(await page.evaluate(() => window.reasoningCommits.length), 0);

  await input.focus();
  for (let i = 1; i <= 5; i++) { await input.press('ArrowRight'); assert.equal(await input.inputValue(), String(i)); }
  await input.press('ArrowRight'); assert.equal(await input.inputValue(), '5');
  await input.press('PageDown'); assert.equal(await input.inputValue(), '4');
  await input.press('Home'); assert.equal(await input.inputValue(), '0');
  assert.equal(await page.locator('.reasoning-slider__thumb').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.reasoning-slider__thumb').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  assert.deepEqual(errors, []);
  await context.close();

  // Real touch events exercise the browser's native range behavior, not synthetic changes.
  const mobile = await openSlider({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const cdp = await mobile.context.newCDPSession(mobile.page);
  const touchStart = mobile.point(0), touchEnd = mobile.point(3.64);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchStart] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchStart.x + (touchEnd.x - touchStart.x) * i / 12, y: touchStart.y }] });
  }
  assert.ok(Math.abs(Number(await mobile.input.inputValue()) - 3.64) < 0.05);
  assert.equal(await mobile.page.evaluate(() => window.reasoningCommits.length), 0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await mobile.input.inputValue(), '4');
  assert.equal(await mobile.page.evaluate(() => window.reasoningCommits.length), 1);
  await mobile.page.waitForTimeout(200);
  await mobile.page.getByTestId('chat-effort-slider').screenshot({ path: `${output}/touch-snapped.png` });
  const mobileStart = mobile.point(4);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [mobileStart] });
  for (const x of [389, 1, 389, 1]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: mobileStart.y }] });
    assert.equal(await mobile.input.inputValue(), x === 1 ? '0' : '5');
    await assertBounds(mobile.page);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await mobile.input.inputValue(), '0');
  await assertBounds(mobile.page);
  assert.deepEqual(mobile.errors, []);
  await mobile.context.close();
  console.log('PASS: bounded mouse/touch overscroll and reversal; clipped fill/effects; no animation overshoot; continuous drag; single nearest-stop commit; cancellation; keyboard; reduced motion.');
} finally { await browser.close(); }
