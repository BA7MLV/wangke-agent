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
      ['settings-module-nav', 'settings-module-nav__item', 16, 8, 8],
      ['ask-card', 'ask-option', 16, 16, 8],
      ['material-image', 'material-image__preview', 16, 16, 8],
      ['chat-attachments__item', 'chat-attachments__thumb', 16, 8, 8],
      ['bh-segment', 'bh-segment__item', 12, 4, 8],
      ['imsg-bubble--file', 'imsg-file__icon', 24, 12, 12],
      ['quiz-card', 'quiz-option', 16, 16, 8],
      ['project-card', 'project-controls', 16, 16, 12],
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
  assert.deepEqual(actual.utilities, [8, 8, 12, 16, 24, 32], 'Tailwind utilities share the CSS radius tokens');
  assert.deepEqual(actual.checkboxRadii, ['4px', '4px'], 'checkbox and selected fill stay square');
  for (const item of actual.nested) {
    assert.deepEqual(item.actual, item.expected, item.outer);
    // These children have their own semantics, not a mandatory concentric formula.
    assert.ok(!actual.supported || ['round', 'superellipse(1)'].includes(item.curve), item.outer);
  }
  for (const [name, curve] of actual.pills) assert.ok(!actual.supported || ['round', 'superellipse(1)'].includes(curve), name);

  const defaults = await page.evaluate(() => {
    const host = document.createElement('div'); document.body.append(host);
    const classes = ['button', 'button button--icon-only', 'button rounded-full', 'card', 'modal__dialog', 'modal__dialog modal__dialog--full', 'popover', 'dropdown__popover', 'select__popover', 'combo-box__popover', 'menu-item', 'list-box-item', 'input', 'rounded-control', 'rounded-panel', 'rounded-dialog'];
    const values = classes.map(name => {
      const el = document.createElement('div'); el.className = name; host.append(el);
      return [name, parseFloat(getComputedStyle(el).borderTopLeftRadius)];
    });
    host.remove(); return values;
  });
  assert.deepEqual(defaults.map(item => Math.min(999, item[1])), [12, 999, 999, 16, 24, 0, 12, 12, 12, 12, 8, 8, 12, 12, 16, 24], JSON.stringify(defaults));
  const scaled = await page.evaluate(() => {
    const previous = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = '20px';
    const host = document.createElement('div'); document.body.append(host);
    const radii = ['rounded-control', 'rounded-panel', 'rounded-dialog'].map(name => {
      const el = document.createElement('div'); el.className = name; host.append(el);
      return parseFloat(getComputedStyle(el).borderTopLeftRadius);
    });
    host.remove(); document.documentElement.style.fontSize = previous; return radii;
  });
  assert.deepEqual(scaled, [15, 20, 30], 'semantic radii follow user font size');

  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await page.screenshot({ path: `${out}/desktop-${theme}.png`, animations: 'disabled' });
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByTestId('settings-modal');
  await dialog.waitFor();
  assert.equal(await dialog.evaluate(el => getComputedStyle(el).borderTopLeftRadius), '24px');
  if (actual.supported) assert.equal(await dialog.evaluate(el => getComputedStyle(el).cornerShape), 'superellipse(1.25)');
  await page.getByTestId('settings-nav-appearance').click();
  await page.getByTestId('settings-module-appearance').waitFor();
  await page.locator('.settings-module-fallback').waitFor({ state: 'detached' });
  const circles = await page.locator('.color-swatch-picker__item, .color-swatch-picker__swatch, .switch__thumb')
    .evaluateAll(elements => elements.map(el => getComputedStyle(el).cornerShape));
  assert.ok(circles.length > 0);
  assert.ok(circles.every(curve => !actual.supported || ['round', 'superellipse(1)'].includes(curve)), 'actual color swatches and switch thumbs remain round');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await page.screenshot({ path: `${out}/settings-desktop-${theme}.png`, animations: 'disabled' });
  }
  await page.keyboard.press('Tab');
  assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)), 'keyboard focus remains in modal');
  const checkProvider = async expected => {
    const provider = page.getByTestId('provider-add-card');
    await provider.waitFor();
    const values = await provider.evaluate(el => {
      const parent = getComputedStyle(el), child = getComputedStyle(el.querySelector('span'));
      return [parseFloat(parent.borderTopLeftRadius), parseFloat(parent.paddingTop), parseFloat(child.borderTopLeftRadius)];
    });
    assert.deepEqual(values, expected, 'provider panel and independent icon keep their semantic radii');
    if (actual.supported) {
      assert.equal(await provider.evaluate(el => getComputedStyle(el).cornerShape), 'superellipse(1.25)');
      assert.ok(await provider.locator('span').first().evaluate(el => ['round', 'superellipse(1)'].includes(getComputedStyle(el).cornerShape)), 'smoothing does not inherit into icons');
    }
  };
  await page.getByTestId('settings-nav-models').click();
  await checkProvider([16, 16, 16]);
  const search = page.getByTestId('provider-preset-search');
  await search.fill('open');
  const popup = page.locator('.combo-box__popover');
  await popup.waitFor();
  assert.equal(await popup.evaluate(el => getComputedStyle(el).borderTopLeftRadius), '12px');
  assert.ok(await popup.getByRole('option').count() > 0, 'portaled menu options remain visible');
  const popupBounds = await popup.boundingBox();
  assert.ok(popupBounds.x >= 0 && popupBounds.x + popupBounds.width <= 1441, 'menu stays in viewport');
  await page.screenshot({ path: `${out}/settings-menu-focus.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await search.fill('');
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('nav-rail-open').click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await dialog.waitFor();
  const mobile = await dialog.evaluate(el => {
    const css = getComputedStyle(el);
    return [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomLeftRadius];
  });
  assert.deepEqual(mobile, ['24px', '24px', '0px']);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await page.screenshot({ path: `${out}/settings-mobile-${theme}.png`, animations: 'disabled' });
  }
  await page.getByTestId('settings-nav-models').click();
  await checkProvider([16, 16, 16]);

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
  assert.equal(fallback[0], '24px');
  assert.ok(!actual.supported || ['round', 'superellipse(1)'].includes(fallback[1]));
  await page.screenshot({ path: `${out}/settings-mobile-fallback.png`, animations: 'disabled' });
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  for (const [device, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    for (const route of ['chat', 'bot', 'library']) {
      await page.goto(`${base}/#/${route}`);
      await page.locator('main').last().waitFor();
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
        await page.screenshot({ path: `${out}/${route}-${device}-${theme}.png`, animations: 'disabled' });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} ${device}: no document overflow`);
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(`PASS: semantic radius pairs; HeroUI/Tailwind defaults; pills/circles; light/dark desktop/mobile settings; focus; plain-radius fallback. Native smoothing supported: ${actual.supported}`);
} finally {
  await browser.close();
}
