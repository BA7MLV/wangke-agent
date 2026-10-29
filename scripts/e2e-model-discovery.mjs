import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const base = process.env.BASE_URL ?? 'http://localhost:5173';
let calls = 0;
let mode = 'success';
let release;
const models = Array.from({ length: 93 }, (_, i) => ({
  id: i ? `model-${String(i).padStart(2, '0')}` : 'model-a',
  name: i === 92 ? 'Tail Model' : undefined,
  context_window: 64000,
}));
const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings')).state);
const updateKey = (key) => page.getByTestId('api-key-sf').fill(key);
try {
  await page.route('https://models.dev/**', (route) => route.fulfill({ json: {} }));
  await page.route('https://discovery.test/**', async (route) => {
    calls++;
    const auth = route.request().headers().authorization;
    if (mode === 'hold') await new Promise((resolve) => { release = resolve; });
    try {
      if (mode === 'fail') await route.fulfill({ status: 401, json: { error: { message: 'invalid key' } } });
      else await route.fulfill({ json: { data: mode === 'empty' ? [] : auth === 'Bearer key-b' ? [{ id: 'model-b' }] : models } });
    } catch { /* A cancelled browser request may already have been disposed. */ }
  });
  await page.goto(`${base}/#/settings`);
  await page.getByTestId('card-api').waitFor();
  await page.evaluate(async () => {
    const { useSettings } = await import('/src/store/settings.ts');
    const s = useSettings.getState();
    s.update({ providers: [{ ...s.providers[0], baseUrl: 'https://discovery.test/v1', apiKey: 'key-a', catalogId: '' }] });
  });
  await page.reload();
  assert.equal(calls, 0, 'overview does not fetch closed providers');
  await page.getByTestId('provider-summary-sf').click();
  const note = page.getByTestId('provider-note-sf');
  const find = page.getByTestId('btn-check-models');
  await find.waitFor();
  assert.equal(await find.innerText(), '获取模型列表');
  await note.filter({ hasText: '93 个可用模型' }).waitFor();
  assert.equal(calls, 1, 'opening a configured provider automatically fetches /models');
  assert.equal(await page.getByRole('list', { name: '接口模型结果', exact: true }).count(), 0, 'results remain collapsed');
  assert.equal(await page.getByRole('button', { name: /^添加 model-/ }).count(), 0, 'no expanded add-button list');
  const beforeModels = (await state()).savedModels;
  const picker = page.getByTestId('discovered-model-select');
  await picker.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '添加 model-a', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^添加 model-/ }).count(), 93, 'all results are reachable, not just the first 30');
  const search = page.getByRole('searchbox', { name: '搜索接口模型', exact: true });
  await search.fill('no-such-model');
  await page.getByText('没有匹配的模型', { exact: true }).waitFor();
  await search.fill('tail model');
  await page.getByRole('button', { name: '添加 model-92', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^添加 model-/ }).count(), 1, 'search matches display names case-insensitively');
  await search.fill('model-92');
  await page.getByRole('button', { name: '添加 model-92', exact: true }).focus();
  await page.keyboard.press('Enter');
  const editor = page.getByTestId('model-editor');
  await editor.waitFor();
  assert.equal(await page.getByRole('list', { name: '接口模型结果', exact: true }).count(), 0, 'selection closes the dropdown');
  assert.equal(await editor.getByRole('textbox', { name: '模型 ID', exact: true }).inputValue(), 'model-92');
  assert.equal(await editor.getByRole('spinbutton', { name: '上下文窗口', exact: true }).inputValue(), '64000');
  assert.deepEqual((await state()).savedModels, beforeModels, 'selecting a result only opens a draft');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await picker.click();
  await page.getByRole('button', { name: '添加 model-92', exact: true }).click();
  await editor.getByRole('button', { name: '添加模型', exact: true }).click();
  assert.ok((await state()).savedModels.some((m) => m.model === 'model-92'));
  await picker.click();
  await page.getByRole('list', { name: '接口模型结果', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '添加 model-92', exact: true }).count(), 0, 'saved models are excluded');
  await picker.click();
  await page.getByRole('searchbox', { name: '搜索已保存模型', exact: true }).fill('no-match');
  assert.match(await page.getByTestId('discovered-models').innerText(), /92/, 'saved-model search does not filter discovery results');
  assert.equal(calls, 1, 'opening, searching and selecting use local results only');

  await mkdir('scripts/out', { recursive: true });
  await page.screenshot({ path: 'scripts/out/model-discovery-collapsed-desktop.png' });
  await picker.click();
  await page.screenshot({ path: 'scripts/out/model-discovery-dropdown-desktop.png' });
  await picker.click();
  await page.getByTestId('provider-back').click();
  const revalidated = page.waitForResponse('https://discovery.test/**');
  await page.getByTestId('provider-summary-sf').click();
  await revalidated;
  await note.filter({ hasText: '93 个可用模型' }).waitFor();
  assert.equal(calls, 2, 'reopening revalidates the interface cache');

  mode = 'fail';
  await page.getByTestId('btn-check-models').click();
  await note.filter({ hasText: '拉取失败' }).waitFor();
  assert.equal(calls, 3, '401 is not retried');
  const count = await page.getByTestId('provider-summary-sf').innerText();
  assert.match(count, /93\s*个模型/, 'failed refresh keeps the previous list');

  mode = 'hold';
  const pendingRequest = page.waitForRequest((request) => request.url().includes('discovery.test') && request.headers().authorization === 'Bearer key-b');
  await updateKey('key-b');
  await page.waitForTimeout(200);
  assert.equal(calls, 3, 'typing credentials does not fetch automatically');
  assert.equal(await note.count(), 0, 'new credential does not inherit old result/error');
  assert.equal(await page.getByTestId('discovered-models').count(), 0);
  await find.click();
  await pendingRequest;
  await page.waitForFunction(() => document.querySelector('[data-testid="btn-check-models"]')?.disabled);
  assert.equal(await note.count(), 0, 'new credential does not inherit old result/error');
  await page.getByTestId('provider-back').click();
  mode = 'success';
  release?.();
  await page.getByTestId('provider-summary-sf').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="btn-check-models"]')?.disabled);
  assert.equal(await page.getByTestId('btn-check-models').isEnabled(), true, 'cancellation does not leave loading stuck');
  await note.filter({ hasText: '1 个可用模型' }).waitFor();
  assert.equal(calls, 5, 'returning after cancellation automatically starts a fresh request');
  const cache = await page.evaluate(() => localStorage.getItem('wangke-model-list'));
  assert.ok(!cache.includes('key-a') && !cache.includes('key-b'));

  await page.evaluate(() => {
    const cache = JSON.parse(localStorage.getItem('wangke-model-list'));
    for (const entry of Object.values(cache.entries)) entry.updatedAt = Date.now() - 48 * 3600 * 1000;
    localStorage.setItem('wangke-model-list', JSON.stringify(cache));
  });
  mode = 'hold';
  release = undefined;
  await page.reload();
  const staleRequest = page.waitForRequest('https://discovery.test/**');
  await page.getByTestId('provider-summary-sf').click();
  await note.filter({ hasText: '过期缓存' }).waitFor();
  await staleRequest;
  // The cache remains visible while the default refresh is in flight.
  assert.equal(await find.isEnabled(), false);
  mode = 'success';
  release?.();
  await note.filter({ hasText: '1 个可用模型' }).waitFor();
  assert.equal(calls, 6, 'stale cache is revalidated on entry');
  await picker.click();
  await page.getByRole('button', { name: '添加 model-b', exact: true }).waitFor();
  await picker.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('settings-nav-models').click();
  await page.getByTestId('provider-summary-sf').click();
  await picker.click();
  await page.getByRole('button', { name: '添加 model-b', exact: true }).waitFor();
  await page.screenshot({ path: 'scripts/out/model-discovery-dropdown-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.getByTestId('settings-module-models').evaluate((el) => el.scrollWidth > el.clientWidth), false);
  await picker.click();
  mode = 'empty';
  await find.click();
  await note.filter({ hasText: '0 个可用模型' }).waitFor();
  assert.equal(await page.getByTestId('discovered-models').count(), 0, 'empty results leave manual model creation available');
  assert.equal(await page.getByRole('button', { name: '新模型', exact: true }).isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: default interface discovery, 93 collapsed results, searchable dropdown, keyboard selection, draft import, cache revalidation, failed-refresh retention, credential isolation, cancellation, loading recovery, empty results and mobile width');
} catch (error) {
  console.error(await page.locator('body').innerText());
  throw error;
} finally {
  release?.();
  await browser.close();
}
