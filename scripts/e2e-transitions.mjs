/** Run against the web dev server: BASE_URL=http://127.0.0.1:5194 node scripts/e2e-transitions.mjs */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://127.0.0.1:5194';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.route('https://motion.invalid/**', route => route.fulfill({ json: { data: [{ id: 'motion-model' }] } }));
  await page.goto(`${base}/#/study`);
  const today = page.getByTestId('tile-today').locator('.t-digit-group');
  await today.waitFor();
  // Reuse Vite's HMR URL: importing an unversioned feedback module would create
  // a second command queue without the application's FeedbackHost subscriber.
  await page.evaluate(() => {
    window.motionImport = path => {
      const loaded = performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === path).at(-1);
      return import(loaded?.name ?? path);
    };
  });
  assert.equal(await today.evaluate(el => el.classList.contains('is-animating')), false, 'initial statistics do not animate from a fake zero');

  await page.evaluate(async () => {
    const { useSettings } = await window.motionImport('/src/store/settings.ts');
    useSettings.getState().update({ studyTrackingEnabled: false });
    const { useStudyTime } = await window.motionImport('/src/store/studyTime.ts');
    const { dateKey } = await window.motionImport('/src/utils/studyLog.ts');
    useStudyTime.setState({ pending: { [dateKey(Date.now())]: 180 } });
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="tile-today"] .t-digit-group')?.textContent === '3 分');
  assert.equal(await today.evaluate(el => el.classList.contains('is-animating')), true);
  assert.ok(await today.locator('.t-digit').nth(1).evaluate(el => el.getBoundingClientRect().width > 0), 'unit spacing survives digit splitting');

  const aligned = () => page.waitForFunction(() => {
    const bar = document.querySelector('.study-range');
    const selected = bar?.querySelector('[aria-checked="true"]');
    const pill = bar?.querySelector('.t-tabs-pill');
    if (!selected || !pill) return false;
    const a = selected.getBoundingClientRect(), b = pill.getBoundingClientRect();
    return Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1;
  });
  await aligned();
  await page.getByTestId('study-range-3m').click();
  assert.ok(await page.locator('.t-tabs-pill').evaluate(el => el.getAnimations().some(animation => animation instanceof CSSTransition && animation.transitionProperty === 'transform')), 'selection actually slides rather than snapping');
  await aligned();
  assert.equal(await page.getByTestId('study-range-3m').getAttribute('aria-checked'), 'true');
  await page.getByTestId('study-range-3m').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByTestId('study-range-6m').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('[data-testid="study-range-6m"]')?.getAttribute('aria-checked') === 'true');
  await aligned();
  // ResizeObserver must realign after geometry changes without playing a new transition.
  await page.addStyleTag({ content: '.study-range .t-tab { padding-inline: 24px; }' });
  await aligned();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await aligned();
  }
  const colors = [];
  for (const dark of [false, true]) {
    colors.push(await page.evaluate(dark => {
      document.documentElement.classList.toggle('dark', dark);
      return getComputedStyle(document.querySelector('.t-tabs-pill')).backgroundColor;
    }, dark));
  }
  assert.notEqual(...colors, 'pill follows the light/dark theme');
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  const openPrompt = () => page.evaluate(async () => {
    const { promptDialog } = await window.motionImport('/src/ui/feedback.tsx');
    window.motionPromptResult = undefined;
    void promptDialog({ headline: 'Motion validation', defaultValue: 'duplicate', validate: value => value === 'duplicate' ? 'Name already exists' : null })
      .then(result => { window.motionPromptResult = result; });
  });
  await openPrompt();
  const input = page.getByTestId('prompt-dialog-input');
  const submit = page.getByTestId('prompt-dialog-confirm');
  await submit.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="prompt-dialog-input"]')?.classList.contains('is-shaking'));
  assert.equal(await input.getAttribute('aria-invalid'), 'true');
  assert.ok(await input.getAttribute('aria-describedby'));
  await page.waitForFunction(() => !document.querySelector('[data-testid="prompt-dialog-input"]')?.classList.contains('is-shaking'));
  await submit.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="prompt-dialog-input"]')?.classList.contains('is-shaking'));
  await page.waitForTimeout(3500);
  assert.equal(await page.getByTestId('prompt-dialog-error').textContent(), 'Name already exists', 'error persists beyond the animation/hold period');
  await input.fill('unique');
  assert.equal(await page.getByTestId('prompt-dialog-error').count(), 0);
  assert.equal(await input.evaluate(el => el.classList.contains('is-shaking')), false);
  await input.press('Enter');
  await page.waitForFunction(() => window.motionPromptResult === 'unique');

  // Exercise the actual provider connection disclosure and model favorite, not a CSS fixture.
  await page.evaluate(async () => {
    const { useSettings } = await window.motionImport('/src/store/settings.ts');
    const provider = { id: 'motion-test', name: 'Motion provider', baseUrl: 'https://motion.invalid/v1', apiKey: 'test-motion-key', protocol: 'openai-chat', serves: ['chat'], catalogId: '' };
    const model = { providerId: provider.id, model: 'motion-model' };
    useSettings.getState().update({ providers: [provider], savedModels: [{ ...model, name: 'Motion model', slots: ['chat'] }], llmModel: model, favorites: { chat: [], vision: [], asr: [], decision: [] } });
    const { openSettings } = await window.motionImport('/src/components/settingsDialogStore.ts');
    openSettings('models');
  });
  await page.getByTestId('provider-summary-motion-test').click();
  const connection = page.getByRole('button', { name: '连接设置 · 地址、密钥与协议', exact: true });
  const connectionPanel = page.locator(`[id="${await connection.getAttribute('aria-controls')}"]`);
  if (await connection.getAttribute('aria-expanded') === 'true') await connection.click();
  assert.equal(await connection.getAttribute('aria-expanded'), 'false');
  assert.equal(await connectionPanel.getAttribute('inert'), '');
  await connection.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-testid="api-key-motion-test"]')?.getBoundingClientRect().height > 0);
  assert.equal(await connection.getAttribute('aria-expanded'), 'true');
  assert.equal(await connectionPanel.getAttribute('inert'), null);
  await connection.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="api-key-motion-test"]');
    return input?.closest('[inert]')?.getBoundingClientRect().height === 0;
  });
  await page.getByTestId('model-button-llmModel').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.getByTestId('model-button-llmModel').click();
  const favorite = page.getByTestId('fav-chat-Motion provider-motion-model').first();
  assert.equal(await favorite.locator('.t-icon-swap').getAttribute('data-state'), 'a');
  await favorite.click();
  assert.equal(await favorite.locator('.t-icon-swap').getAttribute('data-state'), 'b');
  assert.equal(await favorite.getAttribute('aria-label'), '取消收藏 motion-model');
  await favorite.click();
  assert.equal(await favorite.locator('.t-icon-swap').getAttribute('data-state'), 'a');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await favorite.locator('.t-icon').first().evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  assert.equal(await connectionPanel.evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal').getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByTestId('settings-modal').waitFor({ state: 'detached' });

  // Reduced-motion applies to each added/reused animation, while validation still works.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByTestId('study-range-1y').click();
  await aligned();
  assert.equal(await page.locator('.t-tabs-pill').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  await openPrompt();
  await submit.click();
  await page.getByTestId('prompt-dialog-error').waitFor();
  assert.equal(await input.evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.equal(await input.evaluate(el => el.classList.contains('is-shaking')), false);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.motionPromptResult === null);

  // Mount the real MCP settings with mocked requests in this isolated browser.
  // This does not enable cloud mode or change data in the user's real session.
  await page.route('**/api/v1/cloud/mcp', route => route.fulfill({ json: { servers: [{ id: 'motion-mcp', name: 'Motion MCP', url: 'https://motion.invalid/mcp', transport: 'streamable-http', auth: 'none', enabled: true, timeoutMs: 30000, disabledTools: [], status: 'connected', toolCount: 1 }] } }));
  await page.route('**/api/v1/cloud/mcp/motion-mcp/test', route => route.fulfill({ json: { durationMs: 1, tools: [{ name: 'motion-tool', originalName: 'Motion tool', description: 'Disclosure test', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] } }));
  await page.evaluate(async () => {
    const { cloud } = await window.motionImport('/src/cloud/state.ts');
    cloud.enabled = true;
    const react = await window.motionImport('/node_modules/.vite/deps/react.js');
    const reactDom = await window.motionImport('/node_modules/.vite/deps/react-dom_client.js');
    const { createElement } = react.default ?? react;
    const { createRoot } = reactDom.default ?? reactDom;
    const { default: McpSettings } = await window.motionImport('/src/mcp/McpSettings.tsx');
    const host = document.createElement('div');
    host.id = 'motion-mcp-fixture';
    host.style.cssText = 'position:fixed;inset:0;z-index:200000;background:var(--background);overflow:auto;padding:16px';
    document.body.append(host);
    window.motionMcpRoot = createRoot(host);
    window.motionMcpRoot.render(createElement(McpSettings));
  });
  const mcp = page.locator('#motion-mcp-fixture');
  await mcp.getByRole('button', { name: '测试连接', exact: true }).click();
  const parameters = mcp.getByRole('button', { name: '参数定义', exact: true });
  const parameterPanel = page.locator(`[id="${await parameters.getAttribute('aria-controls')}"]`);
  assert.equal(await parameters.getAttribute('aria-expanded'), 'false');
  assert.equal(await parameterPanel.getAttribute('inert'), '');
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion });
    await parameters.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#motion-mcp-fixture pre')?.closest('.t-acc-panel')?.getAttribute('aria-hidden') === 'false');
    assert.equal(await parameters.getAttribute('aria-expanded'), 'true');
    assert.ok((await parameterPanel.textContent()).includes('query'));
    await parameters.press('Space');
    await page.waitForFunction(() => document.querySelector('#motion-mcp-fixture pre')?.closest('[inert]')?.getBoundingClientRect().height === 0);
  }
  await page.evaluate(async () => {
    window.motionMcpRoot.unmount();
    document.getElementById('motion-mcp-fixture').remove();
    const { cloud } = await window.motionImport('/src/cloud/state.ts');
    cloud.enabled = false;
  });
  assert.deepEqual(errors, []);
  console.log('PASS: initial/update numbers; unit spacing; sliding range; keyboard; resize; theme; replayable persistent validation; provider/MCP accordions; favorite icon; reduced motion.');
} finally {
  await browser.close();
}
