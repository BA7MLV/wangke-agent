import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ reducedMotion: 'reduce' });
const errors = [];
const jevRequests = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (new URL(request.url()).hostname === 'typesafe.test') jevRequests.push(request.url());
});
try {
  await page.route('https://models.dev/api.json', (route) => route.fulfill({ json: {
    test: { models: { 'layout-model': { limit: { context: 2560000, output: 100000 } } } },
  } }));
  await page.goto(`${process.env.BASE_URL ?? 'http://localhost:5173'}/#/settings`);
  await page.getByTestId('card-api').waitFor();
  assert.equal(await page.getByTestId('context-window').count(), 0, 'no duplicate global context input');
  assert.equal(await page.getByTestId('btn-toggle-jev').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.getByRole('textbox', { name: 'Jev API 地址' }).isVisible(), false);
  await page.getByTestId('btn-toggle-jev').click();
  assert.equal(await page.getByRole('textbox', { name: 'Jev API 地址' }).isVisible(), true);
  await page.getByRole('textbox', { name: 'Jev API 地址' }).fill('https://typesafe.test/v1');
  await page.getByTestId('btn-toggle-jev').click();
  assert.equal(await page.getByTestId('btn-check-jev').isVisible(), false);
  await page.getByTestId('btn-toggle-jev').click();
  assert.equal(await page.getByRole('textbox', { name: 'Jev API 地址' }).inputValue(), 'https://typesafe.test/v1');

  await page.evaluate(async () => {
    const { useSettings } = await import('/src/store/settings.ts');
    const { refreshModelMeta } = await import('/src/api/modelMeta.ts');
    await refreshModelMeta(['test']);
    const s = useSettings.getState();
    s.update({
      providers: s.providers.map((p) => ({ ...p, catalogId: 'test' })),
      savedModels: [{ providerId: s.providers[0].id, model: 'layout-model', name: 'Layout model', slots: ['chat'] }],
    });
  });
  await page.reload();
  await page.getByTestId('card-api').waitFor();
  await page.getByTestId('provider-summary-sf').click();
  for (const id of ['card-models', 'card-tuning', 'card-jev']) {
    assert.equal(await page.getByTestId(id).count(), 0, `${id} must not appear inside a provider`);
  }
  await page.getByRole('button', { name: '编辑 Layout model', exact: true }).click();
  const context = page.getByRole('spinbutton', { name: '上下文窗口', exact: true });
  const output = page.getByRole('spinbutton', { name: '最大输出令牌数', exact: true });
  assert.equal(await context.getAttribute('placeholder'), '2560000', 'model editor reads models.dev context');
  assert.equal(await output.getAttribute('placeholder'), '100000', 'model editor reads models.dev output');
  await context.fill('128000');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByRole('button', { name: '编辑 Layout model', exact: true }).click();
  assert.equal(await context.inputValue(), '128000', 'per-model override is persisted');
  await page.getByTestId('provider-back').click();
  assert.equal(await page.getByTestId('card-tuning').isVisible(), true);
  assert.equal(await page.getByTestId('btn-toggle-jev').getAttribute('aria-expanded'), 'false', 'Jev starts collapsed on return');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(jevRequests, [], 'opening settings never tests Jev automatically');
  assert.deepEqual(errors, []);
  console.log('PASS: collapsed Jev, preserved config, provider-only details, no duplicate context input, models.dev defaults, saved override, mobile layout');
} catch (error) {
  console.error(await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
