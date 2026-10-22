import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings')).state);
const entry = (input) => ({ modalities: { input, output: ['text'] }, limit: { context: 128000 } });
try {
  await page.addInitScript(() => {
    if (localStorage.getItem('wangke-settings')) return;
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      providers: [{ id: 'sf', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai-chat', apiKey: 'test-key', serves: [], catalogId: 'sh' }],
      savedModels: [], favorites: { chat: [], vision: [], asr: [] },
      llmModel: { providerId: 'sf', model: '' }, visionModel: { providerId: '', model: '' }, asrModel: { providerId: 'sf', model: '' },
    } }));
  });
  await page.route('https://models.dev/api.json', (route) => route.fulfill({ json: {
    'siliconflow-cn': { models: { 'catalog-vision': entry(['text', 'image']), 'api-vision': entry(['text']) } },
    other: { models: { 'catalog-vision': entry(['text']) } },
  } }));
  await page.route('https://api.siliconflow.cn/**', (route) => route.fulfill({ json: { data: [
    { id: 'catalog-vision' },
    { id: 'api-vision', capabilities: { input: ['text', 'image'], output: ['text'] } },
    { id: 'opaque-audio', capabilities: { input: ['audio'], output: ['text'] } },
    { id: 'unknown-vision-asr-name' },
  ] } }));
  await page.goto(`${BASE}/#/settings`);
  await page.getByTestId('model-meta-updated-at').locator('time').waitFor();
  await page.getByTestId('provider-summary-sf').click();
  assert.equal(await page.getByTestId('base-url-sf').count(), 0);
  assert.equal(await page.getByTestId('serves-sf').count(), 0);
  assert.equal(await page.getByTestId('catalog-sf').count(), 0);
  assert.equal(await page.getByRole('button', { name: /API 协议/ }).count(), 0);
  await mkdir('scripts/out', { recursive: true });
  await page.screenshot({ path: 'scripts/out/provider-connection-simple-desktop.png' });

  for (const [id, expected] of [
    ['catalog-vision', ['chat', 'vision']],
    ['api-vision', ['chat', 'vision']],
    ['opaque-audio', ['asr']],
    ['unknown-vision-asr-name', ['chat']],
  ]) {
    await page.getByRole('button', { name: `添加 ${id}`, exact: true }).click();
    const editor = page.getByTestId('model-editor');
    for (const [slot, label] of [['chat', '主模型'], ['vision', '图片理解'], ['asr', '语音识别']]) {
      const box = editor.getByRole('checkbox', { name: label, exact: true });
      assert.equal(await box.isEnabled(), true, 'no supplier-level capability lock');
      assert.equal(await box.isChecked(), expected.includes(slot), `${id}: preselected uses follow the model metadata`);
    }
    await editor.getByRole('button', { name: '添加模型', exact: true }).click();
    assert.deepEqual((await state()).savedModels.find((m) => m.model === id).slots, expected);
    assert.deepEqual((await state()).providers[0].serves, [], 'adding models does not require rewriting legacy serves');
  }

  await page.getByRole('button', { name: '新模型', exact: true }).click();
  const editor = page.getByTestId('model-editor');
  await editor.getByRole('textbox', { name: '模型 ID', exact: true }).fill('catalog-vision');
  assert.equal(await editor.getByRole('checkbox', { name: '图片理解', exact: true }).isChecked(), true, 'manually entered IDs also derive uses');
  // 用户仍可在模型上明确用途；后续输入不能偷偷覆盖用户选择。
  await editor.getByRole('checkbox', { name: '图片理解', exact: true }).focus();
  await page.keyboard.press('Space');
  await editor.getByRole('textbox', { name: '模型 ID', exact: true }).fill('manual-model');
  assert.equal(await editor.getByRole('checkbox', { name: '图片理解', exact: true }).isChecked(), false);
  await editor.getByRole('checkbox', { name: '语音识别', exact: true }).focus();
  await page.keyboard.press('Space');
  await editor.getByRole('button', { name: '添加模型', exact: true }).click();
  assert.deepEqual((await state()).savedModels.find((m) => m.model === 'manual-model').slots, ['chat', 'asr']);
  await page.getByTestId('provider-back').click();

  // 主模型、读图、转写三个候选列表都必须读模型用途，而非旧版空 serves。
  await page.getByTestId('model-button-llmModel').click();
  await page.locator('[data-model-picker="llmModel"]').getByTestId('model-option-catalog-vision').click();
  assert.equal((await state()).llmModel.model, 'catalog-vision');
  await page.getByTestId('model-button-asrModel').click();
  assert.equal(await page.locator('[data-model-picker="asrModel"]').getByTestId('model-option-catalog-vision').count(), 0, 'text/vision models are not ASR candidates');
  await page.locator('[data-model-picker="asrModel"]').getByTestId('model-option-opaque-audio').click();
  assert.equal((await state()).asrModel.model, 'opaque-audio');
  await page.getByRole('checkbox', { name: '自动：优先主模型，否则使用读图模型', exact: true }).focus();
  await page.keyboard.press('Space');
  await page.getByTestId('model-button-visionModel').click();
  assert.equal(await page.locator('[data-model-picker="visionModel"]').getByTestId('model-option-opaque-audio').count(), 0);
  await page.locator('[data-model-picker="visionModel"]').getByTestId('model-option-api-vision').click();
  assert.equal((await state()).visionModel.model, 'api-vision');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByTestId('settings-modal').waitFor({ state: 'hidden' });
  const picker = page.getByTestId('model-picker');
  await picker.first().click();
  await page.getByTestId(`model-picker-item-${JSON.stringify(['sf', 'catalog-vision'])}`).waitFor();
  await page.getByTestId(`model-picker-item-${JSON.stringify(['sf', 'unknown-vision-asr-name'])}`).waitFor();
  assert.equal(await page.getByTestId(`model-picker-item-${JSON.stringify(['sf', 'opaque-audio'])}`).count(), 0);
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/#/settings`);
  await page.getByTestId('provider-summary-sf').click();
  await page.getByRole('button', { name: '编辑 catalog-vision', exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { name: '图片理解', exact: true }).isChecked(), true, 'saved model uses survive reopening');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('provider-summary-sf').click();
  assert.equal(await page.getByTestId('base-url-sf').count(), 0);
  assert.equal(await page.getByTestId('api-key-sf').isVisible(), true);
  assert.equal(await page.getByTestId('settings-module-models').evaluate((el) => el.scrollWidth > el.clientWidth), false);
  await page.screenshot({ path: 'scripts/out/provider-connection-simple-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: minimal preset forms, automatic catalog resolution, model-based uses, API precedence, explicit model choices, default-model candidates, chat picker, persistence and mobile layout');
} catch (error) {
  console.error(await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
