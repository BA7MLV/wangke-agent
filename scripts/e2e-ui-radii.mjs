import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5193';
const out = process.env.SHOTS || 'test-results/ui-radii';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('textarea.course-chat__input')?.disabled === false);

  for (const file of ['cards.css', 'pages/bot.css', 'projects/projects.css',
    'components/ask-cards.css', 'components/chat-attachments.css', 'components/material-image.css',
    'components/settings-sheet.css', 'components/reasoning-effort-slider.css']) {
    await page.addStyleTag({ content: await readFile(`apps/web/src/${file}`, 'utf8') });
  }

  const actual = await page.evaluate(() => {
    const fixtures = document.createElement('div');
    fixtures.style.cssText = 'position:fixed;left:-10000px;top:0;width:500px';
    document.body.append(fixtures);
    const cases = [
      ['settings-module-nav', 'settings-module-nav__item', 24, 8, 16],
      ['ask-card', 'ask-option', 24, 16, 8],
      ['material-image', 'material-image__preview', 24, 16, 8],
      ['chat-attachments__item', 'chat-attachments__thumb', 16, 8, 8],
      ['bh-segment', 'bh-segment__item', 12, 4, 8],
      ['imsg-bubble--file', 'imsg-file__icon', 24, 12, 12],
      ['quiz-card', 'quiz-option', 24, 16, 8],
      ['project-card', 'project-controls', 32, 16, 16],
    ];
    const nested = cases.map(([outer, inner, radius, padding, childRadius]) => {
      const parent = document.createElement('div'); parent.className = outer;
      const child = document.createElement(outer === 'project-card' ? 'select' : 'div');
      child.className = inner;
      // Native project selects use the project-controls ancestor selector.
      if (outer === 'project-card') parent.classList.add('project-controls');
      parent.append(child); fixtures.append(parent);
      const a = getComputedStyle(parent), b = getComputedStyle(child);
      return { outer, expected: [radius, padding, childRadius],
        actual: [parseFloat(a.borderTopLeftRadius), parseFloat(a.paddingTop), parseFloat(b.borderTopLeftRadius)],
        curve: a.cornerShape };
    });
    const utilities = ['sm', 'md', 'lg', 'xl', '2xl', '3xl'].map(size => {
      const el = document.createElement('div'); el.className = `rounded-${size}`; fixtures.append(el);
      return parseFloat(getComputedStyle(el).borderTopLeftRadius);
    });
    const checkbox = document.createElement('div'); checkbox.className = 'checkbox__control'; fixtures.append(checkbox);
    const checkboxRadii = [getComputedStyle(checkbox).borderTopLeftRadius, getComputedStyle(checkbox, '::before').borderTopLeftRadius];
    const pills = ['rounded-full', 'list-box-item rounded-full', 'chip', 'tag', 'badge', 'avatar', 'chat-send', 'imsg-composer__send', 'reasoning-slider__tick'].map(name => {
      const el = document.createElement('div'); el.className = name; fixtures.append(el);
      return [name, getComputedStyle(el).cornerShape];
    });
    fixtures.remove();
    return { supported: CSS.supports('corner-shape', 'superellipse(1.25)'), nested, pills, utilities, checkboxRadii };
  });
  assert.equal(actual.supported, true);
  assert.deepEqual(actual.utilities, [8, 8, 12, 16, 24, 32], 'Tailwind utilities share the CSS radius tokens');
  assert.deepEqual(actual.checkboxRadii, ['4px', '4px'], 'checkbox and selected fill stay square');
  for (const item of actual.nested) {
    assert.deepEqual(item.actual, item.expected, item.outer);
    assert.equal(item.actual[2], Math.max(4, item.actual[0] - item.actual[1]), item.outer);
    assert.equal(item.curve, 'superellipse(1.25)', item.outer);
  }
  for (const [name, curve] of actual.pills) assert.ok(['round', 'superellipse(1)'].includes(curve), name);

  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await page.screenshot({ path: `${out}/desktop-${theme}.png`, animations: 'disabled' });
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByTestId('settings-modal');
  await dialog.waitFor();
  assert.equal(await dialog.evaluate(el => getComputedStyle(el).borderTopLeftRadius), '32px');
  await page.getByTestId('settings-nav-appearance').click();
  await page.getByTestId('settings-module-appearance').waitFor();
  await page.locator('.settings-module-fallback').waitFor({ state: 'detached' });
  const circles = await page.locator('.color-swatch-picker__item, .color-swatch-picker__swatch, .switch__thumb')
    .evaluateAll(elements => elements.map(el => getComputedStyle(el).cornerShape));
  assert.ok(circles.length > 0);
  assert.ok(circles.every(curve => ['round', 'superellipse(1)'].includes(curve)), 'actual color swatches and switch thumbs remain round');
  await page.screenshot({ path: `${out}/settings-desktop.png`, animations: 'disabled' });
  const checkProvider = async expected => {
    const provider = page.getByTestId('provider-add-card');
    await provider.waitFor();
    const values = await provider.evaluate(el => {
      const parent = getComputedStyle(el), child = getComputedStyle(el.querySelector('span'));
      return [parseFloat(parent.borderTopLeftRadius), parseFloat(parent.paddingTop), parseFloat(child.borderTopLeftRadius)];
    });
    assert.deepEqual(values, expected, 'provider card and icon share a corner center');
  };
  await page.getByTestId('settings-nav-models').click();
  await checkProvider([32, 16, 16]);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('nav-rail-open').click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await dialog.waitFor();
  const mobile = await dialog.evaluate(el => {
    const css = getComputedStyle(el);
    return [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomLeftRadius];
  });
  assert.deepEqual(mobile, ['32px', '32px', '0px']);
  await page.screenshot({ path: `${out}/settings-mobile.png`, animations: 'disabled' });
  await page.getByTestId('settings-nav-models').click();
  await checkProvider([32, 16, 16]);

  // Simulate a browser that ignores corner-shape @supports: border-radius must survive.
  const fallback = await page.evaluate(() => {
    function removeEnhancement(rules, owner) {
      for (let i = rules.length - 1; i >= 0; i--) {
        const rule = rules[i];
        if (rule instanceof CSSSupportsRule && rule.conditionText.includes('corner-shape')) owner.deleteRule(i);
        else if (rule.cssRules) removeEnhancement(rule.cssRules, rule);
      }
    }
    for (const sheet of document.styleSheets) removeEnhancement(sheet.cssRules, sheet);
    const css = getComputedStyle(document.querySelector('[data-testid="settings-modal"]'));
    return [css.borderTopLeftRadius, css.cornerShape];
  });
  assert.equal(fallback[0], '32px');
  assert.ok(['round', 'superellipse(1)'].includes(fallback[1]));
  assert.deepEqual(errors, []);
  console.log('PASS: eight concentric radius pairs; pills/circles; light/dark; desktop/mobile settings; plain-radius fallback.');
} finally {
  await browser.close();
}
