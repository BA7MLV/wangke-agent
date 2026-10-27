import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';

// Isolated server/database and a protocol fake; never uses an actual IM account.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const reservation = net.createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r)); const port = reservation.address().port; await new Promise(r => reservation.close(r));
const origin = `http://localhost:${port}`; process.env.PUBLIC_ORIGIN = origin;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  if (String(url).includes('get_bot_qrcode')) { assert.equal(init.method, 'POST'); return Response.json({ qrcode: 'test-qr-handle', qrcode_img_content: 'https://weixin.qq.com/test-qr-not-real-account' }); }
  if (String(url).includes('get_qrcode_status')) return Response.json({ status: 'confirmed', bot_token: 'DO-NOT-EXPOSE-THIS-TOKEN', ilink_bot_id: 'test-bot', baseurl: 'https://ilinkai.weixin.qq.com' });
  throw new Error('No real network allowed in UI test');
} });
let browser, store;
try {
  await app.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const initialized = await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { origin, 'X-Bootstrap-Secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminName: 'GatewayTest', adminPassword: 'gateway-test-password-12345' } }); assert.equal(initialized.status(), 201);
  // Bootstrap initializes without assuming an authenticated browser.
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { headers: { origin }, data: { username: 'GatewayTest', password: 'gateway-test-password-12345' } }); assert.equal(login.status(), 200);
  const owner = (await login.json()).user.id;
  await context.request.get(`${origin}/api/v1/agents`);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Page error:', e.stack); });
  await page.goto(`${origin}/#/settings/data`);
  const panel = page.getByTestId('gateway-settings'); await panel.waitFor({ timeout: 30000 });
  await panel.locator('select').nth(0).selectOption('ilink');
  const agentValue = await panel.locator('select').nth(1).locator('option').last().getAttribute('value');
  await panel.locator('select').nth(1).selectOption(agentValue);
  await panel.getByRole('button', { name: 'Save channel', exact: true }).click();
  await panel.getByText('Channel saved', { exact: true }).waitFor();
  const data = await (await context.request.get(`${origin}/api/v1/gateway`)).json(); assert.equal(data.accounts.length, 1);
  const id = data.accounts[0].id;
  await panel.getByRole('button', { name: 'Generate owner pairing command' }).click(); await panel.getByRole('status').filter({ hasText: '/pair' }).waitFor();
  await panel.getByRole('button', { name: 'Get WeChat login QR code' }).click();
  const qr = panel.getByRole('img', { name: 'Get WeChat login QR code' }); await qr.waitFor(); assert.match(await qr.getAttribute('src'), /^data:image\/png;base64,/);
  await panel.getByRole('button', { name: 'Check QR status' }).click(); await panel.getByText('Login status: confirmed').waitFor();
  assert.equal((await (await context.request.get(`${origin}/api/v1/gateway`)).text()).includes('DO-NOT-EXPOSE-THIS-TOKEN'), false);
  const threadResult = await context.request.post(`${origin}/api/v1/threads`, { headers: { origin }, data: { mode: 'bot', title: 'IM · browser-test' } }); const thread = await threadResult.json();
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  store.db.prepare('INSERT INTO gateway_bindings(id,account_id,tenant,peer,chat,topic,thread_id) VALUES(?,?,?,?,?,?,?)').run('ui-binding', id, '', 'ui-owner-peer', 'ui-chat', '', thread.id);
  store.db.prepare('INSERT INTO bot_reminders(id,owner_id,thread_id,text,timezone,next_at,interval_seconds,created_at) VALUES(?,?,?,?,?,?,?,?)').run('ui-reminder', owner, thread.id, '复习测试提醒', 'Asia/Shanghai', Date.now() + 3600000, 86400, new Date().toISOString());
  await panel.getByText('复习测试提醒', { exact: false }).waitFor({ timeout: 10000 });
  await panel.getByRole('button', { name: 'Cancel reminder' }).click();
  assert.equal(store.db.prepare('SELECT status FROM bot_reminders WHERE id=?').get('ui-reminder').status, 'cancelled');
  for (const status of ['failed', 'uncertain', 'sent']) store.db.prepare('INSERT INTO gateway_outbox(id,binding_id,payload,status,error,created_at) VALUES(?,?,?,?,?,?)').run(`ui-${status}`, 'ui-binding', '{"text":"UI queue result"}', status, 'ui-test', Date.now());
  for (const status of ['failed', 'uncertain']) {
    const row = panel.getByText(`ilink · ${status} · 0 · ui-test`, { exact: true }).locator('..');
    await row.getByRole('button', { name: 'Discard delivery', exact: true }).click();
    await page.getByText('Cancel this queued delivery and unblock later messages.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Discard delivery', exact: true }).last().click();
    await page.waitForTimeout(100);
    assert.equal(store.db.prepare('SELECT status FROM gateway_outbox WHERE id=?').get(`ui-${status}`).status, 'cancelled');
  }
  const discardSent = await context.request.post(`${origin}/api/v1/gateway/deliveries/ui-sent/discard`, { headers: { origin }, data: {} });
  assert.equal(discardSent.status(), 400);
  const output = process.env.SCREENSHOT_DIR || path.join(directory, 'screenshots'); fs.mkdirSync(output, { recursive: true });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    // Reload the appropriate settings root after a mobile/desktop breakpoint.
    await page.reload();
    await panel.getByText('ui-owner-peer · Owner bindings', { exact: true }).waitFor();
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no document overflow at ${width}px`);
    const boxes = await panel.locator('input,select,button,img').evaluateAll(nodes => nodes.map(n => { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right }; }));
    assert.ok(boxes.every(b => b.left >= -1 && b.right <= width + 1), `gateway controls fit ${width}px`);
    await page.screenshot({ path: path.join(output, `gateway-${width}.png`), fullPage: true });
  }
  await panel.getByRole('button', { name: 'Revoke binding and stop tasks' }).click();
  await page.getByRole('button', { name: 'Revoke binding and stop tasks', exact: true }).last().click();
  await page.waitForTimeout(200);
  assert.equal(store.db.prepare('SELECT revoked FROM gateway_bindings WHERE id=?').get('ui-binding').revoked, 1);
  assert.deepEqual(errors, []);
  console.log(`Gateway management browser passed: save, pairing, real locally encoded QR, masked credentials, reminder cancel, failed/uncertain discard confirmation/API, sent discard rejected, revoke, 390/1440px controls. Screenshots: ${output}`);
} catch (e) {
  const pages = browser?.contexts()[0]?.pages() ?? [];
  for (const page of pages) console.error('UI failure:', page.url(), (await page.locator('body').innerText()).slice(-8000));
  throw e;
} finally { store?.close(); await browser?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
