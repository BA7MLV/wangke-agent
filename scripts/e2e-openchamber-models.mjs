import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings')).state);
try {
  await page.route('https://models.dev/api.json*', (route) => route.fulfill({ json: {
    one: { models: { shared: { modalities: { input: ['text'], output: ['text'] }, limit: { context: 128000 }, tool_call: true } } },
    two: { models: { shared: { modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 256000 }, tool_call: true } } },
  } }));
  await page.route('https://discovery.test/**', (route) => route.fulfill({ json: { data: [
    { id: 'shared', context_window: 64000, capabilities: { input: ['text', 'image'], output: ['text'], tools: false } },
    { id: 'unknown-local' },
  ] } }));
  await page.goto(`${process.env.BASE_URL ?? 'http://localhost:5173'}/#/settings`);
  await page.getByTestId('card-api').waitFor();
  await page.evaluate(async () => {
    const { useSettings } = await import('/src/store/settings.ts');
    const s = useSettings.getState();
    s.update({ providers: s.providers.map((p) => ({ ...p, baseUrl: 'https://discovery.test/v1', apiKey: 'test', catalogId: '' })) });
  });
  await page.reload();
  await page.getByTestId('provider-summary-sf').click();
  await page.getByTestId('btn-check-models').click();
  await page.getByTestId('discovered-model-select').click();
  await page.getByRole('button', { name: '添加 shared', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).inputValue(), '64000');
  await page.getByRole('button', { name: /模型能力来源/ }).click();
  await page.getByRole('option', { name: 'two', exact: true }).click();
  assert.match(await page.getByTestId('model-metadata-details').innerText(), /不支持/);
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  let shared = (await state()).savedModels.find((m) => m.model === 'shared');
  assert.equal(shared.contextWindow, 64000);
  assert.equal(shared.toolCalling, false);
  assert.equal(shared.metadataCatalogId, 'two');
  await page.getByTestId('discovered-model-select').click();
  await page.getByRole('button', { name: '添加 unknown-local', exact: true }).click();
  assert.match(await page.getByTestId('model-metadata-details').innerText(), /默认开启（未验证）/);
  assert.equal(await page.getByRole('checkbox', { name: '支持工具调用', exact: true }).isChecked(), true);
  await page.getByRole('checkbox', { name: '自定义工具调用', exact: true }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('checkbox', { name: '支持工具调用', exact: true }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  assert.equal((await state()).savedModels.find((m) => m.model === 'unknown-local').toolCalling, false);
  await page.getByTestId('btn-check-models').click();
  assert.deepEqual((await state()).savedModels.find((m) => m.model === 'shared'), shared, 'rediscovery cannot overwrite saved fields');
  await page.reload();
  await page.getByTestId('provider-summary-sf').click();
  await page.getByRole('button', { name: '编辑 shared', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).inputValue(), '64000');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('PASS: no catalog key, discovery import, provider precedence, ambiguity confirmation, default tools, manual disable, rediscovery, persistence and mobile layout');
} catch (error) {
  console.error(await page.locator('[data-testid="card-api"]').innerText());
  throw error;
} finally {
  await browser.close();
}
