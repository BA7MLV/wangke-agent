import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let catalogInput = ['text'];
const base = process.env.BASE_URL ?? 'http://localhost:5173';
const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings')).state);
const setCheckbox = async (name, checked) => {
  const input = page.getByRole('checkbox', { name, exact: true });
  if (await input.isChecked() !== checked) await input.locator('xpath=ancestor::label').click();
  assert.equal(await input.isChecked(), checked);
};
try {
  await page.route('https://models.dev/api.json', (route) => route.fulfill({ json: {
    test: { models: { shared: { modalities: { input: catalogInput, output: ['text'] }, limit: { context: 128000, output: 8192 }, reasoning: false, tool_call: false } } },
  } }));
  await page.route('https://models.test/v1/models', (route) => route.fulfill({ json: { data: [{ id: 'shared' }] } }));
  await page.addInitScript(() => {
    if (localStorage.getItem('wangke-settings')) return;
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      providers: [{ id: 'test', name: 'Test', baseUrl: 'https://models.test/v1', apiKey: 'test', protocol: 'openai-chat', catalogId: 'test', serves: ['chat', 'vision'] }],
      llmModel: { providerId: 'test', model: 'shared' },
      visionModel: { providerId: '', model: '' },
      savedModels: [{ providerId: 'test', model: 'shared', name: '', slots: ['chat', 'vision'] }],
    } }));
  });
  await page.goto(`${base}/#/settings`);
  await page.getByTestId('card-api').waitFor();
  await page.getByTestId('btn-refresh-meta').click();
  await page.getByTestId('provider-summary-test').click();
  await page.getByRole('button', { name: '编辑 shared', exact: true }).click();
  await page.getByTestId('model-metadata-details').getByRole('img', { name: 'LLM · 文本', exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: '输入 image', exact: true }).isDisabled(), true);
  await page.getByRole('textbox', { name: '模型名称', exact: true }).fill('我的模型');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  assert.equal((await state()).savedModels[0].inputCapabilities, undefined, 'editing only the name must not freeze catalog defaults');

  await page.getByRole('button', { name: '编辑 我的模型', exact: true }).click();
  await setCheckbox('自定义输入能力', true);
  await setCheckbox('输入 image', true);
  await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).fill('16000');
  await page.getByRole('spinbutton', { name: '最大输出令牌数', exact: true }).fill('2048');
  await setCheckbox('自定义工具调用', true);
  await setCheckbox('支持工具调用', true);
  await setCheckbox('自定义推理等级', true);
  await page.getByRole('textbox', { name: '推理等级', exact: true }).fill('low, high');
  await page.getByTestId('model-metadata-details').getByRole('img', { name: 'VLM · 视觉', exact: true }).waitFor();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  assert.deepEqual((await state()).savedModels[0].inputCapabilities, ['text', 'image']);
  assert.equal((await state()).contextWindow, 16000);
  await page.getByTestId('provider-back').click();
  await page.getByTestId('model-button-llmModel').getByRole('img', { name: 'VLM · 视觉', exact: true }).waitFor();
  await page.getByTestId('btn-refresh-meta').click();
  assert.equal((await state()).savedModels[0].contextWindow, 16000);
  assert.equal((await state()).contextWindow, 16000, 'refresh preserves history budgets too');
  await page.reload();
  await page.getByTestId('provider-summary-test').click();
  await page.getByRole('button', { name: '编辑 我的模型', exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { name: '输入 image', exact: true }).isChecked(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  // 设置在移动端切换为 Drawer，会重新挂载模块；重新进入已保存的模型。
  await page.getByTestId('provider-summary-test').click();
  await page.getByRole('button', { name: '编辑 我的模型', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile editor must not overflow');
  await page.getByRole('button', { name: '恢复 models.dev 默认能力', exact: true }).click();
  await page.getByTestId('model-metadata-details').getByRole('img', { name: 'LLM · 文本', exact: true }).waitFor();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  const saved = (await state()).savedModels[0];
  for (const field of ['inputCapabilities', 'toolCalling', 'reasoningEffort', 'contextWindow', 'maxOutputTokens']) assert.equal(saved[field], undefined);

  catalogInput = ['text', 'image'];
  await page.getByTestId('btn-refresh-meta').click();
  await page.getByTestId('provider-back').click();
  await page.getByTestId('model-button-llmModel').getByRole('img', { name: 'VLM · 视觉', exact: true }).waitFor();
  await page.getByTestId('provider-summary-test').click();
  await page.getByRole('button', { name: '编辑 我的模型', exact: true }).click();
  await setCheckbox('自定义输入能力', true);
  await setCheckbox('输入 image', false);
  await setCheckbox('自定义工具调用', true);
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  assert.equal((await state()).savedModels[0].toolCalling, false, 'explicit false is persisted');
  assert.deepEqual((await state()).savedModels[0].inputCapabilities, ['text']);
  await page.getByTestId('provider-back').click();
  await page.getByTestId('model-button-llmModel').getByRole('img', { name: 'LLM · 文本', exact: true }).waitFor();
  await setCheckbox('自动：优先主模型，否则使用读图模型', false);
  assert.equal((await state()).visionModel.model, 'shared', 'explicit model selection remains available');
  await setCheckbox('自动：优先主模型，否则使用读图模型', true);
  assert.equal((await state()).visionModel.model, '');
  assert.deepEqual(errors, []);
  console.log('PASS: editor inheritance, overrides, badges, refresh, persistence, reset, explicit false, automatic vision selection and mobile layout');
} catch (error) {
  console.error({ url: page.url(), errors, visibleText: (await page.locator('body').innerText()).slice(0, 6000) });
  throw error;
} finally {
  await browser.close();
}
