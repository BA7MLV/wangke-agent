import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-cloud-models-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret'), FILES_DIR: path.join(directory, 'files') });
const { buildServer } = await import('../apps/api/src/server.ts');
const upstream = [];
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  upstream.push({ url, headers: init.headers });
  return String(url).includes('after_id=')
    ? Response.json({ data: [{ id: 'api-only-model' }], has_more: false })
    : Response.json({ data: [{ id: 'catalog-model', context_window: 64000 }], has_more: true, last_id: 'page/1' });
} });
let browser;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://localhost:${app.server.address().port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://models.dev/api.json*', route => route.fulfill({ json: {
    fixture: { name: 'Fixture Provider', api: 'https://fixture.example/v1', npm: '@ai-sdk/openai-compatible', models: {
      'catalog-model': { name: 'Catalog Model', modalities: { input: ['text', 'image'], output: ['text'] }, tool_call: true, reasoning: true, limit: { context: 128000, output: 8192 } },
    } },
  } }));
  await page.goto(`${origin}/#/setup`);
  await page.getByLabel('一次性初始化密钥', { exact: true }).fill(fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim());
  await page.getByLabel('密码', { exact: true }).fill('test-password-12345');
  await page.getByRole('button', { name: '设置密码并继续', exact: true }).click();
  await page.getByTestId('provider-add-card').waitFor();
  await page.getByTestId('model-meta-updated-at').locator('time').waitFor();
  await page.getByTestId('provider-add-card').click();
  await page.getByTestId('provider-preset-fixture').click();
  await page.getByTestId('api-key-draft').fill('secret-for-server-only');
  await page.getByTestId('provider-draft-save').click();
  await page.getByTestId('provider-back').waitFor();
  const noBrowserKey = async () => assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('secret-for-server-only'));
  await noBrowserKey();
  assert.equal(upstream.length, 0);
  await page.getByTestId('discovered-model-select').click();
  await page.getByRole('button', { name: '添加 catalog-model', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).getAttribute('placeholder'), '128000');
  await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).fill('96000');
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector('[data-slot="toast"]'));
  await page.getByTestId('provider-back').click();
  await page.getByTestId('model-button-llmModel').click();
  await page.getByTestId('model-option-catalog-model').click();
  await page.getByTestId('cloud-models-save').click();
  await page.getByText('模型设置已保存到服务器', { exact: true }).waitFor();
  const readConfig = async () => (await context.request.get(`${origin}/api/v1/cloud/config`)).json();
  const saved = await readConfig();
  assert.equal(saved.providers[0].catalogId, 'fixture');
  assert.equal(saved.providers[0].baseUrl, 'https://fixture.example/v1');
  assert.equal(saved.providers[0].configured, true);
  assert.equal(saved.providers[0].apiKey, undefined);
  assert.equal(saved.llmModel.model, 'catalog-model');
  await noBrowserKey();
  // Saving the account pane opened before the provider existed must not erase it.
  await page.getByRole('button', { name: '保存服务器配置', exact: true }).click();
  await page.getByText('服务器配置已保存', { exact: true }).waitFor();
  assert.equal((await readConfig()).providers.length, 1);
  await page.reload();
  const id = saved.providers[0].id;
  await page.getByTestId(`provider-summary-${id}`).click();
  assert.equal(await page.getByTestId(`api-key-${id}`).inputValue(), '');
  await page.getByTestId('btn-check-models').click();
  await page.getByText(/2 个可用模型/).first().waitFor();
  assert.equal(upstream[0].url, 'https://fixture.example/v1/models');
  assert.equal(upstream[1].url, 'https://fixture.example/v1/models?after_id=page%2F1', 'gateway preserves provider pagination');
  assert.equal(upstream[0].headers.authorization, 'Bearer secret-for-server-only');
  await page.getByRole('button', { name: '编辑 Catalog Model', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).inputValue(), '96000');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByTestId('cloud-models-save').click();
  await page.getByText('模型设置已保存到服务器', { exact: true }).waitFor();
  await page.getByTestId('btn-check-models').click();
  await page.getByText(/2 个可用模型/).first().waitFor();
  assert.ok(upstream.every(r => r.headers.authorization === 'Bearer secret-for-server-only'), 'blank editor keys preserve credentials');
  await noBrowserKey();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector('[data-slot="toast"]'));
  await page.getByRole('button', { name: '进入课程', exact: true }).click();
  await page.goto(`${origin}/#/settings/models`);
  await page.getByTestId('provider-add-card').waitFor();
  assert.equal(await page.getByRole('heading', { name: '云端账号与权限', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/cloud-models-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('provider-add-card').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile editor stays within the viewport');
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/cloud-models-mobile.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: shared setup/settings UI, live catalog selection, capability overrides, server-only keys/discovery, reload, account saves and mobile layout');
} finally {
  await browser?.close();
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
