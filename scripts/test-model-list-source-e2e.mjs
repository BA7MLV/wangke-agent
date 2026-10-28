import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/model-list-source-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret'), FILES_DIR: path.join(directory, 'files') });
const { buildServer } = await import('../apps/api/src/server.ts');
let mode = 'success';
const upstream = [];
const response = () => mode === 'unsupported' ? Response.json({ error: 'not_found' }, { status: 404 })
  : Response.json({ data: mode === 'empty' ? [] : mode === 'changed' ? [{ id: 'new-api-model' }]
    : [{ id: 'shared-model', context_window: 64000, tool_call: false }, { id: 'api-only-model' }] });
const metadata = { fixture: { name: 'Fixture', api: 'https://source.example/v1', npm: '@ai-sdk/openai-compatible', models: {
  'shared-model': { name: 'Shared Model', modalities: { input: ['text', 'image'], output: ['text'] }, tool_call: true, limit: { context: 128000, output: 8192 } },
  'catalog-only-model': { name: 'Not On This Connection', limit: { context: 256000, output: 16384 } },
} } };
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  upstream.push({ url: String(url), headers: init.headers });
  return response();
} });
let browser, web;
let page;
const errors = [];
const openResults = async () => {
  const toggle = page.getByTestId('discovered-model-select');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
};
const assertNoCatalogCandidates = async () => {
  assert.equal(await page.getByRole('button', { name: '添加 catalog-only-model', exact: true }).count(), 0);
  assert.equal(await page.getByText('Not On This Connection', { exact: true }).count(), 0);
};
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { startWebFixture } = await import('./lib/web-fixture.mjs');
  web = await startWebFixture(`http://127.0.0.1:${app.server.address().port}`);
  const origin = web.origin;
  browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' });
  const headers = { origin };
  const initialized = await context.request.post(`${origin}/api/v1/bootstrap/initialize`, {
    headers: { ...headers, 'X-Bootstrap-Secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'test-password-12345' },
  });
  assert.ok(initialized.ok(), await initialized.text());
  assert.ok((await context.request.post(`${origin}/api/v1/auth/password/login`, { headers, data: { password: 'test-password-12345' } })).ok());
  const config = await (await context.request.get(`${origin}/api/v1/cloud/config`)).json();
  const provider = { id: 'p1', name: 'Fixture', baseUrl: 'https://source.example/v1', apiKey: 'server-only-secret', catalogId: 'fixture', protocol: 'openai-chat', serves: ['chat'] };
  const saved = await context.request.put(`${origin}/api/v1/cloud/providers/p1`, { headers, data: { provider, modelRevision: config.modelRevision } });
  assert.ok(saved.ok(), await saved.text());
  await context.route('https://models.dev/api.json*', route => route.fulfill({ json: metadata }));
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#/setup`);
  await page.getByTestId('provider-summary-p1').waitFor();
  await page.getByTestId('model-meta-updated-at').locator('time').waitFor();
  assert.equal(upstream.length, 0, 'overview does not fetch every connection');
  await page.getByTestId('provider-summary-p1').click();
  await page.getByTestId('provider-note-p1').filter({ hasText: '2 个可用模型' }).waitFor();
  assert.equal(upstream.length, 1, 'entering a saved provider automatically fetches /models');
  assert.equal(upstream[0].url, 'https://source.example/v1/models');
  assert.equal(upstream[0].headers.authorization, 'Bearer server-only-secret');
  await openResults();
  await page.getByRole('button', { name: '添加 shared-model', exact: true }).waitFor();
  await assertNoCatalogCandidates();
  assert.equal(await page.getByRole('list', { name: '接口模型结果' }).getByRole('button', { name: /^添加 / }).count(), 2);
  await page.getByRole('button', { name: '添加 shared-model', exact: true }).click();
  const editor = page.getByTestId('model-editor');
  assert.equal(await editor.getByRole('textbox', { name: '模型名称', exact: true }).inputValue(), 'Shared Model', 'metadata can fill a missing display name');
  assert.equal(await editor.getByRole('spinbutton', { name: '上下文窗口', exact: true }).inputValue(), '64000', 'the provider declaration wins over metadata');
  assert.equal(await editor.getByRole('spinbutton', { name: '最大输出令牌数', exact: true }).getAttribute('placeholder'), '8192', 'metadata fills missing output limits');
  assert.equal(await editor.getByRole('checkbox', { name: '输入 image', exact: true }).isChecked(), true, 'metadata fills missing modalities');
  assert.equal(await editor.getByRole('checkbox', { name: '支持工具调用', exact: true }).isChecked(), false, 'an explicit API false is not overwritten');
  await editor.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector('[data-slot="toast"]'));
  mode = 'empty';
  await page.getByTestId('provider-back').click();
  await page.getByTestId('provider-summary-p1').click();
  await page.getByTestId('provider-note-p1').filter({ hasText: '0 个可用模型' }).waitFor();
  assert.equal(upstream.length, 2, 'reentering revalidates cached lists');
  assert.equal(await page.getByTestId('discovered-models').count(), 0, 'a successful empty list does not fall back to the catalog or old results');
  await page.getByTestId('saved-models').getByText('Shared Model', { exact: true }).waitFor();
  mode = 'unsupported';
  await page.getByTestId('btn-check-models').click();
  await page.getByTestId('provider-note-p1').filter({ hasText: '接口未提供模型列表' }).waitFor();
  await assertNoCatalogCandidates();
  assert.equal(await page.getByTestId('discovered-models').count(), 0);
  await page.getByRole('button', { name: '新模型', exact: true }).click();
  await editor.getByRole('textbox', { name: '模型 ID', exact: true }).fill('manual-model');
  await editor.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByTestId('saved-models').getByText('manual-model', { exact: true }).waitFor();
  await page.getByTestId('onboarding-models-done').click();
  await page.waitForFunction(() => !document.querySelector('.ob'));
  mode = 'changed';
  await page.goto(`${origin}/#/settings/models`);
  await page.getByTestId('provider-summary-p1').click();
  await page.getByTestId('provider-note-p1').filter({ hasText: '1 个可用模型' }).waitFor();
  await openResults();
  await page.getByRole('button', { name: '添加 new-api-model', exact: true }).waitFor();
  await assertNoCatalogCandidates();
  await page.getByTestId('saved-models').getByText('Shared Model', { exact: true }).waitFor();
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('server-only-secret'));

  // The same source policy applies in local settings, without issuing requests per typed key.
  const local = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' });
  await local.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await local.route('https://models.dev/api.json*', route => route.fulfill({ json: metadata }));
  mode = 'success';
  let localCalls = 0;
  await local.route('https://source.example/**', async route => {
    localCalls++;
    const result = response();
    await route.fulfill({ status: result.status, body: await result.text(), contentType: 'application/json' });
  });
  await local.addInitScript(provider => {
    if (localStorage.getItem('wangke-settings')) return;
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: { uiLanguage: 'zh-CN', providers: [provider],
      savedModels: [], llmModel: { providerId: '', model: '' }, visionModel: { providerId: '', model: '' }, asrModel: { providerId: '', model: '' } } }));
  }, { ...provider, apiKey: 'local-key' });
  page = await local.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#/settings/models`);
  await page.getByTestId('provider-summary-p1').click();
  await page.getByTestId('provider-note-p1').filter({ hasText: '2 个可用模型' }).waitFor();
  assert.equal(localCalls, 1);
  await openResults();
  await assertNoCatalogCandidates();
  await page.getByTestId('api-key-p1').fill('new-local-key');
  assert.equal(await page.getByTestId('discovered-models').count(), 0, 'a changed credential never inherits the old list');
  assert.equal(localCalls, 1, 'typing a key does not issue automatic requests');
  await page.getByTestId('btn-check-models').click();
  await page.getByTestId('provider-note-p1').filter({ hasText: '2 个可用模型' }).waitFor();
  assert.equal(localCalls, 2);
  assert.deepEqual(errors, []);
  console.log('PASS: onboarding, cloud and local settings use automatic /models discovery only; metadata supplements parameters, API declarations win, empty/error lists never fall back to catalogs, saved/manual models remain intact and credentials stay isolated');
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/model-list-source-failure.png') });
    console.error(await page.locator('body').innerText());
  }
  throw error;
} finally {
  await browser?.close();
  await web?.close();
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
