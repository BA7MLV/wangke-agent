import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const temporary = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(temporary, { recursive: true });
const directory = fs.mkdtempSync(path.join(temporary, 'wangke-usage-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const dbPath = path.join(directory, 'db/app.sqlite');
const api = buildServer({ dbPath });
let vite, browser, store;
try {
  const backend = await api.listen({ host: '127.0.0.1', port: 0 });
  const initialized = await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'usage-preview-password' } });
  assert.equal(initialized.statusCode, 201, initialized.body);
  const login = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'usage-preview-password' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  const owner = login.json().user.id;
  await api.inject({ method: 'POST', url: '/api/v1/cloud/records', headers: { cookie }, payload: { mutations: [{ id: 'language', table: 'preferences', key: 'uiLanguage', before: null, after: { id: 'uiLanguage', value: 'zh-CN' } }] } });
  assert.equal((await api.inject('/api/v1/cloud/model-usage')).statusCode, 401, 'real auth protects usage');
  store = new DatabaseStore(dbPath);
  const today = new Date().toISOString().slice(0, 10), yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  store.db.prepare(`INSERT INTO model_observations(id,owner_id,provider,model,started_at,status,input_tokens,output_tokens,cache_tokens,cache_creation_tokens,reasoning_tokens)
    VALUES('chat',?,'provider','model',?,'completed',1000,100,800,100,40),
    ('unknown',?,'provider','unknown-model',?,'failed',NULL,NULL,NULL,NULL,NULL),
    ('zero',?,'provider','zero-model',?,'completed',0,0,0,0,0)`).run(owner, `${today}T00:00:00.000Z`, owner, `${today}T00:00:00.000Z`, owner, `${today}T00:00:00.000Z`);
  store.db.prepare(`INSERT INTO bot_requests(id,owner_id,provider,model,started_at,status,input_tokens,output_tokens,cache_tokens,cache_creation_tokens,reasoning_tokens,purpose,attempt,reserved_tokens)
    VALUES('bot',?,'provider','model',?,'completed',2000,200,1000,0,80,'study:cards',1,999999),
    ('inflight',?,'provider','model',?,'inflight',NULL,NULL,NULL,NULL,NULL,'bot',1,999999)`).run(owner, `${yesterday}T00:00:00.000Z`, owner, `${today}T00:00:00.000Z`);
  process.env.WANGKE_API_PROXY = backend;
  vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'usage-fixture-login', configureServer(server) {
      server.middlewares.use('/__usage_fixture', (_req, res) => {
        res.setHeader('set-cookie', cookie + '; Path=/; SameSite=Lax');
        res.writeHead(302, { location: '/#/settings/usage' }); res.end();
      });
    },
  }] });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/__usage_fixture`);
  const module = page.getByTestId('settings-module-usage'), total = page.getByTestId('usage-total');
  const waitTotal = value => page.waitForFunction(value => document.querySelector('[data-testid="usage-total"]')?.textContent.includes(value), value);
  await waitTotal('3,300');
  assert.equal(await page.getByTestId('settings-nav-usage').locator('svg').count(), 1, 'usage navigation has a mapped icon');
  assert.match(await total.innerText(), /3 \/ 5/);
  assert.match(await page.getByTestId('usage-source-chat').innerText(), /1,100/);
  assert.match(await page.getByTestId('usage-source-bot').innerText(), /2,200/);
  assert.match(await total.innerText(), /60%/);
  const unknown = module.getByRole('row').filter({ hasText: 'unknown-model' });
  assert.match(await unknown.innerText(), /未知/);
  assert.equal(await unknown.getByRole('cell', { name: '未知', exact: true }).count(), 6);
  const zero = module.getByRole('row').filter({ hasText: 'zero-model' });
  assert.equal(await zero.getByRole('cell', { name: '0', exact: true }).count(), 5);
  const source = page.getByLabel('来源', { exact: true });
  await source.selectOption('bot'); await waitTotal('2,200');
  assert.equal(await page.getByTestId('usage-source-chat').count(), 0);
  assert.equal(await module.getByRole('row').count(), 2, 'header and one Bot model group');
  await source.selectOption('all'); await waitTotal('3,300');
  await page.getByLabel('汇总方式').selectOption('day');
  await module.getByRole('cell', { name: yesterday, exact: true }).waitFor();
  await page.getByLabel('开始日期（UTC）', { exact: true }).fill(today); await waitTotal('1,100');
  await page.getByLabel('开始日期（UTC）', { exact: true }).fill(yesterday); await waitTotal('3,300');
  const screenshots = path.resolve('test-results/usage'); fs.mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, 'desktop-zh.png') });

  const pattern = '**/api/v1/cloud/model-usage?*', refresh = page.getByTestId('usage-refresh');
  await page.route(pattern, route => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
  await refresh.click(); await module.getByRole('alert').waitFor();
  assert.match(await module.getByRole('alert').innerText(), /上次统计/);
  assert.match(await total.innerText(), /3,300/, 'failed refresh preserves same-query snapshot');
  await page.reload(); await module.getByRole('alert').waitFor();
  assert.equal(await total.count(), 0, 'initial failure never advertises false zero');
  await page.unroute(pattern); await refresh.click(); await waitTotal('3,300');

  let release;
  const held = new Promise(resolve => { release = resolve; });
  let intercept;
  const intercepted = new Promise(resolve => { intercept = resolve; });
  await page.route(pattern, async route => {
    if (new URL(route.request().url()).searchParams.get('source') !== 'all') return route.continue();
    const response = await route.fetch(); intercept(); await held;
    await route.fulfill({ response }).catch(() => {}); // Browser may already have aborted this old range.
  });
  await refresh.click(); await intercepted;
  await source.selectOption('chat'); await waitTotal('1,100'); release();
  await page.unrouteAll({ behavior: 'wait' });
  assert.match(await total.innerText(), /1,100/, 'late response cannot replace a newer source');

  const end = page.getByLabel('结束日期（UTC，含当日）', { exact: true });
  const start = page.getByLabel('开始日期（UTC）', { exact: true });
  const emptyDay = new Date(Date.parse(today) - 86400000 * 30).toISOString().slice(0, 10);
  await start.fill(emptyDay); await end.fill(emptyDay); await waitTotal('0 token');
  assert.match(await page.getByTestId('usage-breakdown').innerText(), /暂无请求/);
  await end.fill(today); await start.fill('2000-01-01');
  await module.getByRole('alert').waitFor(); assert.match(await module.getByRole('alert').innerText(), /90/);
  assert.equal(await page.getByTestId('usage-report').count(), 0, 'new invalid range never shows stale totals');
  await start.fill(yesterday); await source.selectOption('all'); await waitTotal('3,300');

  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 }); await waitTotal('3,300');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await module.evaluate(element => element.scrollWidth > element.clientWidth), false, 'wide table scrolls inside its own region');
    await page.screenshot({ path: path.join(screenshots, `mobile-zh-${width}.png`) });
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByTestId('settings-nav-usage').click(); await waitTotal('3,300');
  await page.getByTestId('usage-breakdown').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(screenshots, 'mobile-zh-breakdown.png') });
  await page.evaluate(async () => { const { default: i18n } = await import('/src/i18n/index.ts'); await i18n.changeLanguage('en-US'); });
  await page.getByRole('heading', { name: 'All usage', exact: true }).waitFor();
  assert.equal(await module.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await page.screenshot({ path: path.join(screenshots, 'mobile-en.png') });
  await page.evaluate(async () => { const { useSettings } = await import('/src/store/settings.ts'); useSettings.getState().update({ theme: 'dark' }); });
  await page.screenshot({ path: path.join(screenshots, 'mobile-en-dark.png') });
  await page.setViewportSize({ width: 1440, height: 1000 }); await waitTotal('3,300');
  await page.screenshot({ path: path.join(screenshots, 'desktop-en-dark.png') });
  assert.deepEqual(errors, []);
  const local = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block' });
  await local.route('**/api/v1/cloud/status', route => route.fulfill({ status: 404, json: {} }));
  await local.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const localPage = await local.newPage();
  await localPage.goto(`${origin}/#/settings`);
  await localPage.getByTestId('settings-modal').waitFor();
  assert.equal(await localPage.getByTestId('settings-nav-usage').count(), 0, 'browser-direct mode never mislabels local history as server usage');
  await local.close();
  console.log('PASS: real SQLite → authenticated API → settings deep link, source/date/model grouping, unknown/zero, refresh/retry, stale-response cancellation, empty/invalid windows, Chinese/English and 360/390/1440px layouts');
} finally { await browser?.close(); await vite?.close(); store?.close(); await api.close(); fs.rmSync(directory, { recursive: true, force: true }); }
