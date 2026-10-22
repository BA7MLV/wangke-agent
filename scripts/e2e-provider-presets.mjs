import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const presets = [
  ['openai', 'https://api.openai.com/v1', 'openai-chat'],
  ['deepseek', 'https://api.deepseek.com', 'openai-chat'],
  ['openrouter', 'https://openrouter.ai/api/v1', 'openai-chat'],
  ['anthropic', 'https://api.anthropic.com/v1', 'anthropic-messages'],
  ['siliconflow-cn', 'https://api.siliconflow.cn/v1', 'openai-chat'],
  ['google', 'https://generativelanguage.googleapis.com/v1beta/openai', 'openai-chat'],
  ['vercel', 'https://ai-gateway.vercel.sh/v1', 'openai-chat'],
];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const errors = [];
const modelRequests = [];
page.on('pageerror', (error) => errors.push(error.message));
const settings = () => page.evaluate(async () => {
  const persisted = JSON.parse(localStorage.getItem('wangke-settings') ?? 'null');
  if (persisted) return persisted.state;
  const { useSettings } = await import('/src/store/settings.ts');
  return JSON.parse(JSON.stringify(useSettings.getState()));
});
const openPicker = async () => {
  await page.getByTestId('provider-add-card').click();
  await page.getByTestId('provider-presets').waitFor();
};
let failMeta = false;
let releaseMeta;
let holdMeta = false;
try {
  await page.route('https://models.dev/api.json', async (route) => {
    if (holdMeta) await new Promise((resolve) => { releaseMeta = resolve; });
    if (failMeta) return route.fulfill({ status: 503, body: 'Unavailable' });
    return route.fulfill({ json: {
      deepseek: { models: { 'deepseek-chat': { limit: { context: 128000, output: 8192 } } } },
    } });
  });
  for (const [, baseUrl] of presets) {
    const host = new URL(baseUrl).hostname;
    await page.route(`https://${host}/**`, (route) => {
      modelRequests.push(route.request().url());
      return route.fulfill({ json: { data: [] } });
    });
  }
  await page.goto(`${BASE}/#/settings`);
  await page.getByTestId('card-api').waitFor();
  await page.getByTestId('model-meta-updated-at').locator('time').waitFor();
  assert.equal(await page.getByTestId('btn-add-provider').count(), 0);
  assert.equal(await page.getByTestId('btn-refresh-meta').innerText(), '', 'refresh is an icon, not a text action');
  assert.equal(await page.getByTestId('btn-refresh-meta').getAttribute('aria-label'), '刷新能力数据');
  const initial = await settings();
  await openPicker();
  assert.equal((await settings()).providers.length, initial.providers.length, 'opening the picker does not create an empty connection');
  assert.equal(await page.getByTestId('provider-presets').locator('button[data-testid^="provider-preset-"]').count(), 8);
  assert.equal(await page.getByTestId('card-models').count(), 0, 'picker is a dedicated page');
  assert.deepEqual(modelRequests, [], 'browsing presets never sends credentials or fetches provider models');
  await mkdir('scripts/out', { recursive: true });
  await page.screenshot({ path: 'scripts/out/provider-presets-desktop.png' });
  await page.getByTestId('provider-presets-back').click();
  assert.equal((await settings()).providers.length, initial.providers.length, 'back leaves settings unchanged');

  for (const [catalogId, baseUrl, protocol] of presets) {
    await openPicker();
    const before = await settings();
    const button = page.getByTestId(`provider-preset-${catalogId}`);
    if (catalogId === 'openai') {
      await button.focus();
      await page.keyboard.press('Enter');
    } else await button.click();
    await page.getByTestId('provider-back').waitFor();
    const after = await settings();
    const provider = after.providers.find((p) => p.baseUrl === baseUrl);
    assert.ok(provider, `${catalogId}: endpoint is prefilled`);
    assert.equal(provider.protocol, protocol);
    assert.equal(provider.catalogId, catalogId);
    assert.equal(provider.apiKey, '');
    assert.equal(after.providers.length, before.providers.length + (catalogId === 'siliconflow-cn' ? 0 : 1));
    assert.equal(await page.getByTestId(`base-url-${provider.id}`).inputValue(), baseUrl);
    assert.equal(await page.getByTestId(`api-key-${provider.id}`).isVisible(), true);
    await page.getByTestId('provider-back').click();
  }

  // 旧版 DeepSeek 的 /v1/ 写法也复用，且保留所有用户配置，不只保留密钥。
  await page.evaluate(async () => {
    const saved = JSON.parse(localStorage.getItem('wangke-settings'));
    saved.state.providers = saved.state.providers.map((p) => p.catalogId === 'deepseek'
      ? { ...p, name: '我的 DeepSeek', baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'test-key', protocol: 'openai-responses', serves: ['chat', 'vision'], catalogId: 'custom-catalog' }
      : p);
    localStorage.setItem('wangke-settings', JSON.stringify(saved));
  });
  await page.reload();
  await page.getByTestId('provider-add-card').waitFor();
  const saved = await settings();
  await openPicker();
  assert.match(await page.getByTestId('provider-preset-deepseek').innerText(), /已添加/);
  await page.getByTestId('provider-preset-deepseek').click();
  await page.getByTestId('provider-back').waitFor();
  assert.deepEqual((await settings()).providers, saved.providers, 'existing endpoints are not duplicated or overwritten');
  await page.getByTestId('provider-back').click();

  await openPicker();
  await page.getByTestId('provider-preset-custom').click();
  await page.getByTestId('provider-back').waitFor();
  const custom = (await settings()).providers.at(-1);
  assert.equal(custom.baseUrl, '');
  assert.equal(custom.apiKey, '');
  assert.equal(custom.protocol, 'openai-chat');
  await page.getByTestId(`provider-name-${custom.id}`).fill('自定义测试端点');
  await page.getByTestId(`base-url-${custom.id}`).fill('https://custom.test/v1');
  await page.getByTestId('provider-back').click();
  assert.equal((await settings()).providers.at(-1).name, '自定义测试端点');

  // 刷新失败保留最后成功时间；处理中禁用，再次成功后更新时间。
  const oldTime = await page.getByTestId('model-meta-updated-at').locator('time').getAttribute('datetime');
  failMeta = true;
  await page.getByTestId('btn-refresh-meta').click();
  await page.getByTestId('card-api').getByRole('alert').waitFor();
  assert.equal(await page.getByTestId('model-meta-updated-at').locator('time').getAttribute('datetime'), oldTime);
  failMeta = false;
  holdMeta = true;
  await page.getByTestId('btn-refresh-meta').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="btn-refresh-meta"]').disabled);
  assert.equal(await page.getByTestId('card-api').getByRole('alert').count(), 0);
  assert.equal(typeof releaseMeta, 'function');
  releaseMeta();
  await page.waitForFunction((old) => document.querySelector('[data-testid="model-meta-updated-at"] time').dateTime !== old, oldTime);

  await openPicker();
  await page.getByTestId('settings-module-models').evaluate((el) => { el.scrollTop = 0; });
  for (const [id] of presets) {
    const response = await page.request.get(`${BASE}/provider-logos/${id}.svg`);
    assert.equal(response.status(), 200, `${id} logo is bundled locally`);
    assert.match(await response.text(), /<svg/);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('provider-add-card').click(); // 响应式 Modal → Drawer 会重新挂载模块。
  await page.getByTestId('provider-presets').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.getByTestId('settings-module-models').evaluate((el) => el.scrollWidth > el.clientWidth), false);
  await page.screenshot({ path: 'scripts/out/provider-presets-mobile.png' });
  await page.getByTestId('provider-preset-deepseek').click();
  await page.getByTestId('provider-back').waitFor();
  assert.equal(await page.getByRole('textbox', { name: '供应商名称', exact: true }).inputValue(), '我的 DeepSeek');
  await page.getByTestId('provider-back').click();
  await openPicker();
  await page.evaluate(async () => {
    const { applyTheme } = await import('/src/ui/theme.ts');
    applyTheme('dark');
  });
  await page.screenshot({ path: 'scripts/out/provider-presets-dark.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: preset page, seven endpoints, keyboard selection, preserved existing connections, custom endpoint, icon refresh, update timestamp, failure/retry, mobile and dark layout');
} catch (error) {
  console.error(await page.locator('body').innerText());
  throw error;
} finally {
  releaseMeta?.();
  await browser.close();
}
