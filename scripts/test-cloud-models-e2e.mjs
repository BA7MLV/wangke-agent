import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-cloud-models-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret'), FILES_DIR: path.join(directory, 'files') });
const { buildServer } = await import('../apps/api/src/server.ts');
const upstream = [];
let upstreamStatus = 200;
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  upstream.push({ url, headers: init.headers });
  if (upstreamStatus !== 200) return Response.json({ error: 'not-supported' }, { status: upstreamStatus });
  return String(url).includes('after_id=')
    ? Response.json({ data: [{ id: 'api-only-model' }], has_more: false })
    : Response.json({ data: [{ id: 'catalog-model', context_window: 64000 }], has_more: true, last_id: 'page/1' });
} });
let browser, web;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { startWebFixture } = await import('./lib/web-fixture.mjs');
  web = await startWebFixture(`http://127.0.0.1:${app.server.address().port}`);
  const origin = web.origin;
  browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://models.dev/api.json*', route => route.fulfill({ json: {
    fixture: { name: 'Fixture Provider', api: 'https://fixture.example/v1', npm: '@ai-sdk/openai-compatible', models: {
      'catalog-model': { name: 'Catalog Model', modalities: { input: ['text', 'image'], output: ['text'] }, tool_call: true, reasoning: true, limit: { context: 128000, output: 8192 } },
      'catalog-only-model': { name: 'Catalog only', modalities: { input: ['text'], output: ['text'] } },
    } },
  } }));
  await page.goto(`${origin}/#/setup`);
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByLabel('一次性初始化密钥', { exact: true }).fill(fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim());
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByLabel('密码', { exact: true }).fill('test-password-12345');
  await page.getByRole('button', { name: '创建管理员', exact: true }).click();
  await page.getByLabel('你的称呼', { exact: true }).fill('模型测试');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByTestId('provider-add-card').waitFor();
  await page.getByTestId('model-meta-updated-at').locator('time').waitFor();
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/onboarding-models-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'onboarding editor stays within the mobile viewport');
  assert.ok(await page.getByTestId('card-api').evaluate(element => element.getBoundingClientRect().right <= innerWidth), 'onboarding cards are not clipped by the outer grid');
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/onboarding-models-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByTestId('provider-preset-search').fill('Fixture Provider');
  await page.getByRole('option').filter({ hasText: 'Fixture Provider' }).click();
  await page.getByTestId('api-key-draft').fill('secret-for-server-only');
  await page.getByTestId('provider-draft-save').click();
  await page.getByTestId('provider-back').waitFor();
  const noBrowserKey = async () => assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('secret-for-server-only'));
  await noBrowserKey();
  await page.getByText(/2 个可用模型/).first().waitFor();
  assert.equal(upstream.length, 2, 'saving a connection immediately fetches its paginated model list');
  await page.getByTestId('discovered-model-select').click();
  assert.equal(await page.getByRole('button', { name: '添加 catalog-only-model', exact: true }).count(), 0, 'reference catalog never invents candidates absent from this connection');
  await page.getByRole('button', { name: '添加 catalog-model', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).getAttribute('placeholder'), '128000');
  await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).fill('96000');
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector('[data-slot="toast"]'));
  await page.getByTestId('cloud-models-save').click();
  await page.getByText('模型设置已保存到服务器', { exact: true }).waitFor();
  const readConfig = async () => (await context.request.get(`${origin}/api/v1/cloud/config`)).json();
  const saved = await readConfig();
  assert.equal(saved.providers[0].catalogId, 'fixture');
  assert.equal(saved.providers[0].baseUrl, 'https://fixture.example/v1');
  assert.equal(saved.providers[0].configured, true);
  assert.equal(saved.providers[0].apiKey, undefined);
  await noBrowserKey();
  const id = saved.providers[0].id;
  assert.equal(await page.getByTestId(`api-key-${id}`).inputValue(), '');
  await page.getByTestId('btn-check-models').click();
  await page.getByText(/2 个可用模型/).first().waitFor();
  assert.equal(upstream[0].url, 'https://fixture.example/v1/models');
  assert.equal(upstream[1].url, 'https://fixture.example/v1/models?after_id=page%2F1', 'gateway preserves provider pagination');
  assert.equal(upstream[0].headers.authorization, 'Bearer secret-for-server-only');
  assert.equal(await page.getByTestId('saved-models').getByRole('button', { name: /^编辑 / }).count(), 1, 'discovery does not automatically add models');
  await page.getByTestId('discovered-model-select').click();
  await page.getByRole('button', { name: '添加 api-only-model', exact: true }).click();
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByTestId('saved-models').getByText('api-only-model', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑 Catalog Model', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).inputValue(), '96000');
  await page.getByTestId('model-editor').getByRole('button', { name: '取消', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector('[data-slot="toast"]'));
  await page.getByTestId('provider-back').click();
  await page.getByTestId('model-button-llmModel').evaluate(element => element.scrollIntoView({ block: 'center' }));
  await page.getByTestId('model-button-llmModel').click();
  await page.waitForFunction(() => {
    const popover = document.querySelector('[data-model-picker="llmModel"]');
    return popover && getComputedStyle(popover).opacity === '1' && !popover.hasAttribute('data-entering');
  });
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/onboarding-model-picker.png') });
  await page.getByTestId('model-option-catalog-model').click();
  // Completion must save pending model choices, and failures must keep the editor open.
  await page.route('**/api/v1/cloud/model-settings', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { error: 'test_save_failed' } }) : route.continue());
  await page.getByTestId('onboarding-models-done').click();
  await page.getByRole('alert').filter({ hasText: 'test_save_failed' }).waitFor();
  await page.getByTestId('onboarding-models-done').waitFor();
  await page.unroute('**/api/v1/cloud/model-settings');
  await page.getByTestId('onboarding-models-done').click();
  await page.waitForFunction(() => !document.querySelector('.ob'));
  assert.equal((await readConfig()).llmModel.model, 'catalog-model');
  await page.goto(`${origin}/#/settings/models`);
  await page.reload();
  await page.getByTestId(`provider-summary-${id}`).click();
  await page.getByTestId(`provider-name-${id}`).fill('Renamed connection');
  assert.equal(await page.getByTestId('btn-check-models').innerText(), '保存连接并获取模型', 'display name changes are not mistaken for a saved connection');
  await page.getByTestId('saved-models').getByText('api-only-model', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑 Catalog Model', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).inputValue(), '96000', 'onboarding capabilities survive reload in settings');
  await page.getByTestId('model-editor').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByTestId('btn-check-models').click();
  await page.getByText(/2 个可用模型/).first().waitFor();
  assert.ok(upstream.every(r => r.headers.authorization === 'Bearer secret-for-server-only'), 'blank editor keys preserve credentials');
  await noBrowserKey();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector('[data-slot="toast"]'));
  await page.getByTestId('provider-back').click();
  await page.getByTestId('provider-add-card').waitFor();
  assert.equal(await page.getByRole('heading', { name: '云端账号与权限', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/cloud-models-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('provider-add-card').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile editor stays within the viewport');
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/cloud-models-mobile.png') });
  // Saving rotated credentials succeeds even when the provider has no model-list endpoint.
  await page.getByTestId(`provider-summary-${id}`).click();
  await page.getByTestId(`api-key-${id}`).fill('rotated-secret');
  assert.equal(await page.getByTestId('btn-check-models').innerText(), '保存连接并获取模型');
  upstreamStatus = 404;
  await page.getByTestId('btn-check-models').click();
  await page.getByText(/接口未提供模型列表/).first().waitFor();
  assert.equal(await page.getByTestId(`api-key-${id}`).inputValue(), '', 'saved credentials are cleared from the editor after a discovery failure');
  assert.equal((await readConfig()).llmModel.model, 'catalog-model', 'connection save preserves defaults');
  assert.equal((await readConfig()).providers[0].configured, true);
  assert.equal(upstream.at(-1).headers.authorization, 'Bearer rotated-secret');
  upstreamStatus = 200;
  await page.getByTestId('btn-check-models').click();
  await page.getByText(/2 个可用模型/).first().waitFor();

  // Another page changes the connection; this editor must keep its key draft and show a conflict.
  const latest = await readConfig();
  const changed = await context.request.put(`${origin}/api/v1/cloud/providers/${id}`, { data: {
    provider: { ...latest.providers[0], name: 'Externally changed' }, modelRevision: latest.modelRevision,
  } });
  assert.equal(changed.status(), 200);
  await page.getByTestId(`api-key-${id}`).fill('unsaved-conflict-secret');
  await page.getByTestId('btn-check-models').click();
  await page.getByText(/服务器上的模型设置已被其他页面修改/).first().waitFor();
  assert.equal(await page.getByTestId(`api-key-${id}`).inputValue(), 'unsaved-conflict-secret');
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('unsaved-conflict-secret'));
  await page.getByRole('button', { name: '重新载入服务器设置', exact: true }).click();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: '重新载入', exact: true }).click();
  await page.getByTestId('provider-add-card').waitFor();
  await page.getByTestId(`provider-summary-${id}`).click();
  assert.equal(await page.getByTestId(`api-key-${id}`).inputValue(), '');

  // Deleting the active provider clears every default instead of silently changing providers.
  await page.getByTestId(`provider-remove-${id}`).click();
  const deletion = page.getByTestId('confirm-dialog-danger');
  await deletion.getByText(/清空聊天的默认模型/).waitFor();
  await deletion.getByRole('button', { name: '删除', exact: true }).click();
  assert.equal((await readConfig()).providers.length, 1, 'deletion stays in the draft until explicitly saved');
  await page.getByTestId('cloud-models-save').click();
  await page.getByText('模型设置已保存到服务器', { exact: true }).waitFor();
  const deleted = await readConfig();
  assert.equal(deleted.providers.length, 0);
  assert.deepEqual(deleted.llmModel, { providerId: '', model: '' });
  // Skipping a new in-memory connection must not save its credentials or config.
  await page.goto(`${origin}/#/setup`);
  await page.reload();
  await page.getByTestId('provider-add-card').click();
  await page.getByTestId('provider-name-draft').fill('Discarded provider');
  await page.getByTestId('base-url-draft').fill('https://discard.example/v1');
  await page.getByTestId('api-key-draft').fill('discard-this-secret');
  await page.getByRole('button', { name: '稍后再说', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.ob'));
  assert.equal((await readConfig()).providers.length, 0);
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('discard-this-secret'));
  // Older configurations may contain dangling references, including a previously hidden decision slot.
  const legacy = { ...await readConfig(), llmModel: { providerId: 'deleted', model: 'old-chat' },
    decisionModel: { providerId: 'deleted', model: 'old-decision' } };
  await page.route('**/api/v1/cloud/config', route => route.request().method() === 'GET'
    ? route.fulfill({ json: legacy }) : route.continue());
  await page.goto(`${origin}/#/settings/models`);
  await page.reload();
  await page.getByText('有 2 项默认模型配置需要修复。你仍可独立保存连接并获取模型列表。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '定位并修复', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'model-button-llmModel');
  assert.equal(await page.getByTestId('model-button-llmModel').getAttribute('aria-invalid'), 'true');
  await page.getByRole('button', { name: '清除选择，稍后配置', exact: true }).click();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByTestId('confirm-dialog-danger').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByTestId('model-button-decisionModel').waitFor();
  await page.getByTestId('cloud-models-save').click();
  await page.getByRole('alert').filter({ hasText: '请先修复下方默认模型配置' }).waitFor();
  await page.getByRole('button', { name: '不使用决策模型', exact: true }).click();
  await page.unroute('**/api/v1/cloud/config');
  await page.getByTestId('cloud-models-save').click();
  await page.getByText('模型设置已保存到服务器', { exact: true }).waitFor();
  assert.deepEqual((await readConfig()).decisionModel, { providerId: '', model: '' });
  assert.deepEqual(errors, []);
  console.log('PASS: onboarding/settings, paginated discovery, credential safety, completion retry, 404 recovery, concurrent conflicts, deletion, legacy field repair, skip and mobile layout');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/cloud-models-failure.png') });
    console.error(await page.locator('body').innerText());
  }
  throw error;
} finally {
  await browser?.close();
  await web?.close();
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
