import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Local message fixtures only: no model requests or changes to the user's data.
const base = process.env.BASE_URL || 'http://localhost:5192';
const out = process.env.SHOTS || 'test-results/reasoning-hover';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
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
  await page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true }).waitFor();
  await page.locator('.course-chat__empty h2').waitFor();
  await page.evaluate(async () => {
    const { useCourseChat } = await window.loadTestModule('/src/store/courseChat.ts');
    useCourseChat.setState({ messages: [
      { key: 'hover-question', role: 'user', content: '请梳理这节课的重点。' },
      { key: 'hover-answer', role: 'ai', content: '可以从核心概念、关键步骤和练习三个方面梳理。',
        reasoning: '先梳理核心概念，再整理关键步骤，最后结合练习归纳重点。', reasoningMs: 1800 },
    ] });
  });
  const toggle = page.getByTestId('response-process-toggle');
  const chain = page.getByTestId('response-process');
  const style = () => toggle.evaluate(el => {
    const css = getComputedStyle(el);
    return { background: css.backgroundColor, radius: css.borderRadius,
      corner: css.getPropertyValue('corner-shape'), decoration: css.textDecorationLine };
  });
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame);
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(async theme => {
      const { useSettings } = await window.loadTestModule('/src/store/settings.ts');
      useSettings.setState({ theme });
    }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await toggle.evaluate(el => el.blur());
      await page.mouse.move(0, 899);
      await settle();
      const normal = await style();
      await toggle.locator('.reasoning-chain__title').hover();
      await settle();
      const hover = await style();
      assert.notEqual(hover.background, normal.background, `${theme}/${width}: neutral hover background appears`);
      assert.equal(hover.radius, '10px', 'hover matches the import action corner radius');
      assert.equal(hover.decoration, 'none', 'hover never underlines the text');
      if (await page.evaluate(() => CSS.supports('corner-shape', 'squircle'))) {
        assert(['squircle', 'superellipse(2)'].includes(hover.corner), 'hover uses continuous corners');
      }
      await toggle.locator('.reasoning-chain__indicator').hover();
      await settle();
      assert.equal((await style()).background, hover.background, 'text and arrow share one hover background');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
        'hover padding does not cause horizontal page overflow');
      const message = await page.locator('.course-chat__message--ai').boundingBox();
      await page.screenshot({ path: `${out}/${theme}-${width}.png`, animations: 'disabled',
        clip: { x: message.x - 16, y: message.y - 8, width: message.width + 32, height: message.height + 16 } });
      await toggle.click();
      await page.waitForFunction(() => document.querySelector('[data-testid="response-process"]')?.dataset.mode === 'expanded');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'click still expands reasoning');
      await toggle.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-testid="response-process"]')?.dataset.mode === 'closed');
      assert.equal(await chain.getAttribute('data-mode'), 'closed', 'keyboard still collapses reasoning');
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: continuous reasoning hover corners, shared text/arrow target, light/dark desktop/mobile, click expansion and keyboard collapse.');
} finally {
  await browser.close();
}
