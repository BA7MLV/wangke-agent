import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Uses a disposable instance, never the deployed administrator or credentials.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-bootstrap-e2e-'));
const secretFile = path.join(directory, 'config/bootstrap-secret');
const secret = 'test-only+bootstrap/key=with-encoding';
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, BOOTSTRAP_SECRET_FILE: secretFile, FILES_DIR: path.join(directory, 'files') });
delete process.env.PUBLIC_ORIGIN;
fs.mkdirSync(path.dirname(secretFile), { recursive: true });
fs.writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let browser;
try {
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const requests = [];
  page.on('request', request => requests.push(request));
  await page.goto(`${origin}/#/setup?secret=invalid-test-key`);
  await page.getByLabel('一次性初始化密钥', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('一次性初始化密钥', { exact: true }).inputValue(), 'invalid-test-key');
  assert.equal(new URL(page.url()).hash, '#/setup');
  await page.getByLabel('密码', { exact: true }).fill('test-password-only-12345');
  await page.getByRole('button', { name: '创建管理员', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '初始化密钥无效或已过期' }).waitFor();
  assert.equal((await (await context.request.get(`${origin}/api/v1/bootstrap/status`)).json()).initialized, false);

  const link = `${origin}/#/setup?${new URLSearchParams({ secret })}`;
  await page.goto(link);
  await page.waitForFunction(secret => document.querySelector('input[aria-label="一次性初始化密钥"]')?.value === secret, secret);
  assert.equal(await page.getByLabel('一次性初始化密钥', { exact: true }).inputValue(), secret);
  assert.equal(new URL(page.url()).hash, '#/setup', 'credential removed from browser history');
  assert.equal(await page.evaluate(secret => JSON.stringify([localStorage, sessionStorage]).includes(secret), secret), false);
  await page.getByLabel('账号', { exact: true }).fill('BootstrapTest');
  await page.getByLabel('密码', { exact: true }).fill('test-password-only-12345');
  await page.getByRole('button', { name: '创建管理员', exact: true }).click();
  await page.getByRole('heading', { name: '配置个人云端', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(fs.existsSync(secretFile), false, 'one-time secret deleted after successful initialization');
  const initialize = requests.find(request => request.url().endsWith('/bootstrap/initialize') && request.headers()['x-bootstrap-secret'] === secret);
  assert.ok(initialize, 'autofilled secret sent in initialization header');
  assert.ok(requests.every(request => !request.url().includes('secret=') && !request.url().includes(encodeURIComponent(secret))), 'credential never appears in HTTP request URLs');
  const repeated = await context.request.post(`${origin}/api/v1/bootstrap/initialize`, {
    headers: { 'x-bootstrap-secret': secret }, data: { adminPassword: 'test-password-only-12345' },
  });
  assert.equal(repeated.status(), 410, 'used setup link cannot create another administrator');
  console.log('Bootstrap browser autofill, URL cleanup, readable errors and one-time administrator creation passed');
} finally {
  await browser?.close();
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
