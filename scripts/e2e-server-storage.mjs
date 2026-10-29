import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const temporary = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(temporary, { recursive: true });
const directory = fs.mkdtempSync(path.join(temporary, 'wangke-storage-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const api = buildServer({ dbPath: path.join(directory, 'db/app.sqlite') });
let vite, browser;
try {
  const backend = await api.listen({ host: '127.0.0.1', port: 0 });
  const initialized = await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'storage-preview-password' } });
  assert.equal(initialized.statusCode, 201, initialized.body);
  const login = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'storage-preview-password' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  await api.inject({ method: 'POST', url: '/api/v1/cloud/records', headers: { cookie }, payload: { mutations: [{ id: 'language', table: 'preferences', key: 'uiLanguage', before: null, after: { id: 'uiLanguage', value: 'zh-CN' } }] } });
  fs.writeFileSync(path.join(directory, 'files/fixture.bin'), Buffer.alloc(2 * 1024 * 1024));
  fs.mkdirSync(path.join(directory, 'files/projects/storage-fixture'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'files/projects/storage-fixture/notes.md'), Buffer.alloc(128 * 1024));
  process.env.WANGKE_API_PROXY = backend;
  vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'storage-fixture-login', configureServer(server) {
      server.middlewares.use('/__storage_fixture', (_req, res) => {
        res.setHeader('set-cookie', cookie + '; Path=/; SameSite=Lax');
        res.writeHead(302, { location: '/#/settings/data' }); res.end();
      });
    },
  }] });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/__storage_fixture`);
  const card = page.getByTestId('cloud-storage-card');
  await page.getByTestId('cloud-storage-total').waitFor({ timeout: 60000 });
  assert.match(await page.getByTestId('cloud-storage-files').innerText(), /2\.0 MB/);
  assert.match(await page.getByTestId('cloud-storage-workspaces').innerText(), /128 KB/);
  assert.equal(await page.getByTestId('card-storage').count(), 0, 'cloud view never shows browser quota');
  assert.equal(await card.getByRole('progressbar').count(), 1);
  fs.writeFileSync(path.join(directory, 'files/fixture.bin'), Buffer.alloc(3 * 1024 * 1024));
  const refresh = page.getByTestId('cloud-storage-refresh');
  await refresh.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="cloud-storage-files"]')?.textContent.includes('3.0 MB'));
  const screenshotDir = path.resolve('test-results/server-storage');
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, 'desktop.png') });

  await page.route('**/api/v1/cloud/storage', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
  await refresh.click();
  await card.getByRole('alert').waitFor();
  assert.match(await card.getByRole('alert').innerText(), /上次统计/);
  assert.match(await page.getByTestId('cloud-storage-files').innerText(), /3\.0 MB/, 'failed refresh preserves the last measurement');
  await page.reload();
  await card.getByRole('alert').waitFor();
  assert.equal(await page.getByTestId('cloud-storage-total').count(), 0, 'initial failure never displays a false zero');
  await page.unroute('**/api/v1/cloud/storage');
  await refresh.click();
  await page.getByTestId('cloud-storage-total').waitFor();

  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByTestId('cloud-storage-total').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await card.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await page.screenshot({ path: path.join(screenshotDir, 'mobile.png') });
  await page.evaluate(async () => { const { default: i18n } = await import('/src/i18n/index.ts'); await i18n.changeLanguage('en-US'); });
  await card.getByText('Server storage', { exact: true }).waitFor();
  assert.equal(await card.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await page.screenshot({ path: path.join(screenshotDir, 'mobile-en.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: live server totals, refresh, error/retry, desktop, 360px Chinese/English layouts');
  await browser.close(); browser = undefined;
  if (process.env.STORAGE_PREVIEW === '1') {
    console.log(`STORAGE_PREVIEW ${origin}/__storage_fixture PID=${process.pid}`);
    await new Promise(resolve => process.once('SIGTERM', resolve));
  }
} finally { await browser?.close(); await vite?.close(); await api.close(); fs.rmSync(directory, { recursive: true, force: true }); }
