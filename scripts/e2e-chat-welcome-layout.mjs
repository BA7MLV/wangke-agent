import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Isolated browser profile and local fixtures only: never sends a model request.
const base = process.env.BASE_URL || 'http://localhost:5192';
const out = process.env.SHOTS || 'test-results/chat-welcome-layout';
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
  const input = page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true });
  await input.waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea.course-chat__input')?.disabled);
  const heading = page.locator('.course-chat__empty h2');
  await heading.waitFor();
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame);
  });
  const checkWelcome = async (label, upperCenter = true) => {
    await settle();
    const geometry = await page.evaluate(() => {
      const bounds = selector => {
        const { x, y, width, height, bottom } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height, bottom };
      };
      return {
        heading: bounds('.course-chat__empty h2'),
        composer: bounds('.course-chat__composer'),
        main: bounds('.course-chat__main'),
        bar: bounds('[data-testid="top-app-bar"]'),
        importStrip: document.querySelector('.course-chat__import') ? {
          ...bounds('.course-chat__import'),
          label: bounds('.course-chat__import-label'),
          sharesComposerWrapper: document.querySelector('.course-chat__import').parentElement
            === document.querySelector('.course-chat__composer').parentElement,
        } : null,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    const { heading, composer, main, bar } = geometry;
    assert(!geometry.overflow, `${label}: no horizontal page overflow`);
    assert(heading.y >= bar.bottom, `${label}: title clears the app bar`);
    assert(composer.y - heading.bottom >= 19, `${label}: title and input retain breathing room`);
    assert(composer.bottom <= main.bottom, `${label}: input is fully visible`);
    assert(Math.abs(heading.x + heading.width / 2 - composer.x - composer.width / 2) < 1,
      `${label}: title and input share the same center axis`);
    if (geometry.importStrip) {
      const strip = geometry.importStrip;
      assert(strip.sharesComposerWrapper, `${label}: import and composer form one group`);
      assert(strip.y >= heading.bottom + 19, `${label}: import strip clears the heading`);
      assert(strip.x > composer.x && strip.width < composer.width, `${label}: import strip is inset from the card edges`);
      assert(strip.y < composer.y && strip.bottom > composer.y, `${label}: input card overlaps the strip's lower edge`);
      assert(strip.label.bottom <= composer.y, `${label}: input card does not cover the import label`);
    }
    if (upperCenter) {
      const center = ((heading.y + composer.bottom) / 2 - main.y) / main.height;
      // Short landscape windows prioritize clearing the app bar over the usual upper-center position.
      const maxCenter = main.height < 520 ? 0.52 : 0.48;
      assert(center >= 0.32 && center <= maxCenter, `${label}: visual group stays comfortably centered (${center})`);
    }
  };
  const checkLogo = async testId => {
    const button = page.getByTestId(testId);
    assert.equal(await button.locator('svg[viewBox="0 0 126 126"] path[fill-rule="evenodd"]').count(), 1);
    assert.equal(await button.locator('svg.tabler-icon').count(), 0, 'no generic navigation icon');
    const { width, height } = await button.boundingBox();
    assert(width >= 44 && height >= 44, 'logo retains an accessible touch target');
    assert.equal((await button.locator('svg').boundingBox()).width, 28, 'brand mark is not shrunk to the default button icon size');
  };

  for (const [width, height] of [[1440, 900], [1920, 1080], [768, 1024], [390, 844], [844, 390], [1280, 500]]) {
    await page.setViewportSize({ width, height });
    await checkWelcome(`${width}×${height}`);
    await checkLogo(width > 900 ? 'nav-rail-toggle' : 'nav-rail-open');
    if (width === 390) {
      assert.equal(await page.getByTestId('chat-import-close').evaluate(el => getComputedStyle(el).opacity), '1',
        'mobile close is available without hover');
    }
    if (width === 1440 || width === 390) {
      await page.screenshot({ path: `${out}/welcome-${width}.png`, animations: 'disabled' });
      await page.locator('.course-chat__composer-wrap').screenshot({ path: `${out}/import-strip-${width}.png`, animations: 'disabled' });
    }
  }

  const strip = page.getByTestId('chat-import-strip');
  const importLink = page.getByTestId('chat-go-import');
  const closeImport = page.getByTestId('chat-import-close');
  assert.equal(await strip.getByText('让回答有据可依').count(), 0, 'extra explanation is removed');
  assert((await importLink.boundingBox()).width < 140, 'only the icon and text are the import target');
  await page.mouse.move(1200, 480);
  assert.equal(await closeImport.evaluate(el => getComputedStyle(el).opacity), '0', 'desktop close starts hidden');
  const originalUrl = page.url();
  const stripWidth = (await strip.boundingBox()).width;
  await strip.click({ position: { x: stripWidth / 2, y: 16 } });
  assert.equal(page.url(), originalUrl, 'blank strip area does not navigate');
  const normalImportBackground = await importLink.evaluate(el => getComputedStyle(el).backgroundColor);
  await importLink.locator('svg').hover();
  await settle();
  assert.notEqual(await importLink.evaluate(el => getComputedStyle(el).backgroundColor), normalImportBackground,
    'hovering the icon highlights the whole icon/text group');
  const iconHoverBackground = await importLink.evaluate(el => getComputedStyle(el).backgroundColor);
  await importLink.locator('span').hover();
  await settle();
  assert.equal(await importLink.evaluate(el => getComputedStyle(el).backgroundColor), iconHoverBackground,
    'icon and text share exactly the same hover state');
  assert.equal(await importLink.evaluate(el => getComputedStyle(el).textDecorationLine), 'none', 'hover never underlines the text');
  assert.equal(await closeImport.evaluate(el => getComputedStyle(el).opacity), '1', 'hovering the strip reveals close');
  const corners = await page.evaluate(() => ({
    supported: CSS.supports('corner-shape', 'squircle'),
    shapes: ['.course-chat__import', '.course-chat__import-label', '.course-chat__composer']
      .map(selector => getComputedStyle(document.querySelector(selector)).getPropertyValue('corner-shape')),
  }));
  if (corners.supported) assert(corners.shapes.every(shape => ['squircle', 'superellipse(2)'].includes(shape)),
    'import strip, hover and input use continuous corners');
  await page.locator('.course-chat__composer-wrap').screenshot({ path: `${out}/import-strip-hover.png`, animations: 'disabled' });
  await importLink.locator('svg').click();
  await page.waitForURL('**/#/library');
  await page.evaluate(() => { location.hash = '#/'; });
  await heading.waitFor();
  await checkWelcome('return from import library');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('nav-rail-toggle').click();
  await page.getByTestId('nav-rail-compact').waitFor();
  await settle();
  await checkLogo('nav-rail-toggle');
  assert.equal(await page.getByTestId('app-brand').locator('svg').count(), 1, 'one brand mark, not a separate duplicate toggle');
  await checkWelcome('collapsed sidebar');
  await page.reload();
  await heading.waitFor();
  await page.getByTestId('nav-rail-compact').waitFor();
  await page.getByTestId('nav-rail-toggle').click();
  await page.getByTestId('nav-rail').waitFor();

  await page.evaluate(async () => {
    const { useCourseChat } = await window.loadTestModule('/src/store/courseChat.ts');
    useCourseChat.setState({ courseCount: 0 });
    const { useSettings } = await window.loadTestModule('/src/store/settings.ts');
    useSettings.setState({ theme: 'dark' });
  });
  await checkWelcome('empty library and dark theme');
  await page.screenshot({ path: `${out}/welcome-dark.png`, animations: 'disabled' });
  await page.locator('.course-chat__composer-wrap').screenshot({ path: `${out}/import-strip-dark.png`, animations: 'disabled' });

  await input.fill('关闭提示也保留这段草稿');
  await strip.hover();
  const beforeDismissUrl = page.url();
  await closeImport.click();
  assert.equal(await strip.count(), 0, 'close dismisses the entire import strip');
  assert.equal(page.url(), beforeDismissUrl, 'close never imports or navigates');
  assert.equal(await input.inputValue(), '关闭提示也保留这段草稿', 'dismissing preserves the draft');
  assert(await input.evaluate(el => el === document.activeElement), 'focus returns to the composer');
  await input.fill('');
  await page.reload();
  await heading.waitFor();
  await importLink.waitFor();
  await page.mouse.move(1200, 800);
  await importLink.focus();
  await page.keyboard.press('Tab');
  assert(await closeImport.evaluate(el => el === document.activeElement), 'close is keyboard reachable');
  assert.equal(await closeImport.evaluate(el => getComputedStyle(el).opacity), '1', 'keyboard focus reveals close');
  await page.keyboard.press('Enter');
  assert.equal(await strip.count(), 0, 'keyboard can dismiss the strip');
  await page.reload();
  await heading.waitFor();
  await importLink.waitFor();

  await page.evaluate(async () => {
    const { useCourseChat } = await window.loadTestModule('/src/store/courseChat.ts');
    useCourseChat.setState({ courseCount: 1 });
  });
  assert.equal(await page.getByTestId('chat-go-import').count(), 0, 'existing courses do not show the empty-library import strip');
  await checkWelcome('with courses');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('nav-rail-open').click();
  await page.getByRole('dialog', { name: 'DeepStudent Go' }).waitFor();
  await page.getByRole('button', { name: '关闭导航' }).click();
  await page.getByRole('dialog', { name: 'DeepStudent Go' }).waitFor({ state: 'detached' });
  await page.evaluate(async () => {
    const { useCourseChat } = await window.loadTestModule('/src/store/courseChat.ts');
    useCourseChat.setState({ courseCount: 0 });
  });
  await input.fill('这是多行草稿\n'.repeat(12));
  await page.evaluate(() => document.documentElement.style.setProperty('--vvh', '400px'));
  await checkWelcome('keyboard-height viewport with long draft', false);
  await page.screenshot({ path: `${out}/keyboard-long-draft.png`, animations: 'disabled' });
  await input.fill('');
  await input.blur();
  await page.evaluate(() => document.documentElement.style.removeProperty('--vvh'));

  // The regular conversation still keeps its composer at the bottom, not in the welcome position.
  await page.evaluate(async () => {
    const { useCourseChat } = await window.loadTestModule('/src/store/courseChat.ts');
    useCourseChat.setState({ messages: [
      { key: 'layout-question', role: 'user', content: '布局测试' },
      { key: 'layout-answer', role: 'ai', content: '已进入会话。' },
    ] });
  });
  await page.waitForFunction(() => !document.querySelector('.course-chat--empty'));
  assert.equal(await page.getByTestId('chat-go-import').count(), 0, 'import strip disappears in a conversation');
  await settle();
  const composer = await page.locator('.course-chat__composer').boundingBox();
  assert(Math.abs(844 - composer.y - composer.height - 10) < 2, 'conversation composer remains bottom anchored');
  assert.deepEqual(errors, []);
  console.log('PASS: welcome placement, shared icon/text hover and import, continuous corners, mouse and keyboard dismissal without navigation or draft loss, mobile close, light/dark themes, keyboard/long draft, bottom-anchored conversation.');
} finally {
  await browser.close();
}
