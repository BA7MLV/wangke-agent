import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// 隔离存储 + 假供应商：不接触真实 Key，不调用付费接口。
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.text().includes('[Sym] 未知图标')) errors.push(message.text()); });
const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings')).state);
const requests = [];
try {
  await page.addInitScript(() => {
    if (localStorage.getItem('wangke-settings')) return;
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      providers: [{ id: 'gateway', name: '测试供应商', baseUrl: 'https://decision-gateway.test/v1', apiKey: 'fake-decision-key', protocol: 'openai-chat', serves: [], catalogId: 'gateway' }],
      savedModels: [], favorites: { chat: [], vision: [], asr: [] },
      llmModel: { providerId: 'gateway', model: '' }, asrModel: { providerId: 'gateway', model: '' }, visionModel: { providerId: '', model: '' },
    } }));
  });
  await page.route('https://models.dev/**', (route) => route.fulfill({ json: {
    gateway: { models: { 'jev-test': { type: 'decision', modalities: { input: ['text'], output: ['text'] }, limit: { context: 64000, output: 0 } } } },
  } }));
  await page.route('https://decision-gateway.test/**', async (route) => {
    const request = route.request();
    if (request.url().endsWith('/models')) return route.fulfill({ json: { data: [{ id: 'jev-test' }] } });
    requests.push({ url: request.url(), body: request.postDataJSON(), key: request.headers().authorization });
    return route.fulfill({ json: { answers: { connected: { noul: 0.99 } } } });
  });
  await page.goto(`${process.env.BASE_URL ?? 'http://localhost:5173'}/#/settings`);
  await page.getByTestId('model-meta-updated-at').locator('time').waitFor();
  await page.getByTestId('model-button-decisionModel').waitFor();
  await page.getByTestId('provider-summary-gateway').click();
  await page.getByTestId('btn-check-models').click();
  await page.getByTestId('discovered-model-select').click();
  await page.getByRole('button', { name: '添加 jev-test', exact: true }).click();
  const editor = page.getByTestId('model-editor');
  assert.equal(await editor.getByRole('checkbox', { name: '决策模型', exact: true }).isChecked(), true);
  assert.equal(await editor.getByRole('checkbox', { name: '主模型', exact: true }).isChecked(), false);
  await editor.getByRole('button', { name: '添加模型', exact: true }).click();
  await editor.getByRole('alert').filter({ hasText: '协议' }).waitFor();
  await editor.getByTestId('decision-protocol-trigger').click();
  await page.getByRole('option', { name: 'TypeSafe System One' }).click();
  await editor.getByRole('button', { name: '添加模型', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(requests.length, 0);
  assert.deepEqual((await state()).savedModels[0].slots, ['decision']);
  await page.getByTestId('provider-back').click();
  await page.getByTestId('model-button-decisionModel').scrollIntoViewIfNeeded();
  await page.getByTestId('model-button-decisionModel').click();
  await page.locator('[data-model-picker="decisionModel"]').getByTestId('model-option-jev-test').click();
  assert.equal((await state()).decisionModel.model, 'jev-test');
  const card = page.getByTestId('card-jev');
  await card.getByRole('button', { name: '展开配置', exact: true }).click();
  assert.equal(await card.getByRole('textbox').count(), 0);
  const compression = card.getByRole('checkbox', { name: '长对话上下文压缩（实验性）', exact: true });
  assert.equal(await compression.isChecked(), false);
  await compression.focus();
  await compression.press('Space');
  assert.equal(requests.length, 0, '选择与授权不能隐式请求');
  await card.getByRole('button', { name: '测试决策连接', exact: true }).click();
  await card.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://decision-gateway.test/v1/systemone');
  assert.equal(requests[0].key, 'Bearer fake-decision-key');
  assert.equal(requests[0].body.model, 'jev-test');
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['model', 'questions', 'state']);
  await page.reload();
  await page.getByTestId('model-button-decisionModel').waitFor();
  assert.equal((await state()).jev.contextCompression, true);
  await page.setViewportSize({ width: 390, height: 844 });
  const picker = await page.getByTestId('model-button-decisionModel').boundingBox();
  assert.ok(picker.x >= 0 && picker.x + picker.width <= 390);
  await page.getByRole('button', { name: '不使用决策模型', exact: true }).click();
  assert.deepEqual((await state()).jev, { skillRouting: false, contextCompression: false });
  assert.deepEqual((await state()).decisionModel, { providerId: '', model: '' });
  assert.deepEqual(errors, []);
  console.log('PASS: 决策目录预选、供应商模型管理、协议确认、第四槽位、独立授权、专用请求、持久化、手机布局与停用');
} catch (error) {
  console.error(await page.locator('body').innerText());
  console.error(errors);
  throw error;
} finally {
  await browser.close();
}
