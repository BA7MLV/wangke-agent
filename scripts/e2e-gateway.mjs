import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { setTimeout as sleep } from 'node:timers/promises';

// Isolated server/database and a protocol fake; never uses an actual IM account.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const reservation = net.createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r)); const port = reservation.address().port; await new Promise(r => reservation.close(r));
const origin = `http://localhost:${port}`; process.env.PUBLIC_ORIGIN = origin;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
let qrStatus = 'confirmed', statusPolls = 0;
const verifySubmissions = [];
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  if (String(url).includes('get_bot_qrcode')) { assert.equal(init.method, 'POST'); return Response.json({ qrcode: 'test-qr-handle', qrcode_img_content: 'https://weixin.qq.com/test-qr-not-real-account' }); }
  if (String(url).includes('get_qrcode_status')) {
    statusPolls++;
    const code = new URL(url).searchParams.get('verify_code');
    if (code) { verifySubmissions.push(code); return Response.json({ status: 'verify_code_blocked' }); }
    return Response.json({ status: qrStatus, ...(qrStatus === 'confirmed' ? { bot_token: 'DO-NOT-EXPOSE-THIS-TOKEN', ilink_bot_id: 'test-bot', baseurl: 'https://ilinkai.weixin.qq.com' } : {}) });
  }
  throw new TypeError('DO-NOT-EXPOSE-THIS-TRANSPORT-ERROR', { cause: { code: 'ENOTFOUND' } });
} });
let browser, store, web;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  // API-only deployment: serve the real web app separately and proxy its API calls.
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    cacheDir: path.join(directory, 'vite-cache'),
    server: { host: 'localhost', port, strictPort: true, proxy: { '/api/v1': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false } } } });
  await web.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.gatewayLoginAborts = [];
    const fetch = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).includes('/gateway/accounts/') && String(input).endsWith('/login')) {
        const action = JSON.parse(init.body).action;
        init.signal?.addEventListener('abort', () => window.gatewayLoginAborts.push(action), { once: true });
      }
      return fetch(input, init);
    };
  });
  const initialized = await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { origin, 'X-Bootstrap-Secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminName: 'GatewayTest', adminPassword: 'gateway-test-password-12345' } }); assert.equal(initialized.status(), 201);
  // Bootstrap initializes without assuming an authenticated browser.
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { headers: { origin }, data: { username: 'GatewayTest', password: 'gateway-test-password-12345' } }); assert.equal(login.status(), 200);
  const owner = (await login.json()).user.id;
  await context.request.get(`${origin}/api/v1/agents`);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Page error:', e.stack); });
  await page.goto(`${origin}/#/settings/gateway`);
  const panel = page.getByTestId('gateway-settings'); await panel.waitFor({ timeout: 30000 });
  await page.getByTestId('gateway-add').click();
  await page.getByTestId('gateway-add-ilink').click();
  const qr = page.getByTestId('gateway-wechat-login').getByRole('img');
  await qr.waitFor(); assert.match(await qr.getAttribute('src'), /^data:image\/png;base64,/);
  // Login progresses automatically, without a manual status-check button.
  await page.getByTestId('gateway-pair').waitFor();
  await page.getByTestId('gateway-connection-details').getByText('dns_error', { exact: true }).waitFor();
  const data = await (await context.request.get(`${origin}/api/v1/gateway`)).json(); assert.equal(data.accounts.length, 1);
  const id = data.accounts[0].id;
  await page.getByTestId('gateway-pair').click();
  assert.match(await page.getByTestId('gateway-pair-command').innerText(), /^\/pair [0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal((await (await context.request.get(`${origin}/api/v1/gateway`)).text()).includes('DO-NOT-EXPOSE-THIS-TOKEN'), false);
  assert.equal((await (await context.request.get(`${origin}/api/v1/gateway`)).text()).includes('DO-NOT-EXPOSE-THIS-TRANSPORT-ERROR'), false);
  const threadResult = await context.request.post(`${origin}/api/v1/threads`, { headers: { origin }, data: { mode: 'bot', title: 'IM · browser-test' } }); const thread = await threadResult.json();
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  store.db.prepare('INSERT INTO gateway_bindings(id,account_id,tenant,peer,chat,topic,thread_id) VALUES(?,?,?,?,?,?,?)').run('ui-binding', id, '', 'ui-owner-peer', 'ui-chat', '', thread.id);
  await panel.getByRole('button', { name: 'Open conversation', exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId('gateway-pair-command').count(), 0, 'binding hides the pairing command automatically');
  await panel.getByRole('button', { name: 'Open conversation', exact: true }).click();
  await page.getByTestId('bot-panel-history').filter({ hasText: thread.title }).waitFor();
  await page.getByTestId('settings-modal').waitFor({ state: 'detached' });
  assert.ok(!page.url().includes('/bot'), 'gateway opens the supplementary panel, not a Bot page');

  // A second gateway link must switch the already-mounted Bot panel.
  const second = await (await context.request.post(`${origin}/api/v1/threads`, { headers: { origin }, data: { mode: 'bot', title: 'IM · second thread' } })).json();
  store.db.prepare('UPDATE gateway_bindings SET thread_id=? WHERE id=?').run(second.id, 'ui-binding');
  await page.getByTestId('nav-rail-settings').click();
  await page.getByTestId('settings-nav-gateway').click();
  await page.getByTestId('gateway-account-ilink').click();
  await panel.getByRole('button', { name: 'Open conversation', exact: true }).click();
  await page.getByTestId('bot-panel-history').filter({ hasText: second.title }).waitFor({ timeout: 10000 });
  await page.getByTestId('settings-modal').waitFor({ state: 'detached' });
  await page.getByTestId('nav-rail-settings').click();
  await page.getByTestId('settings-nav-gateway').click();

  store.db.prepare('INSERT INTO bot_reminders(id,owner_id,thread_id,text,timezone,next_at,interval_seconds,created_at) VALUES(?,?,?,?,?,?,?,?)').run('ui-reminder', owner, thread.id, '复习测试提醒', 'Asia/Shanghai', Date.now() + 3600000, 86400, new Date().toISOString());
  await panel.getByText('复习测试提醒', { exact: false }).waitFor({ timeout: 10000 });
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(store.db.prepare('SELECT status FROM bot_reminders WHERE id=?').get('ui-reminder').status, 'cancelled');
  for (const status of ['failed', 'uncertain', 'sent']) store.db.prepare('INSERT INTO gateway_outbox(id,binding_id,payload,status,error,created_at) VALUES(?,?,?,?,?,?)').run(`ui-${status}`, 'ui-binding', '{"text":"UI queue result"}', status, 'ui-test', Date.now());
  for (const status of ['failed', 'uncertain']) {
    const row = panel.getByText(`WeChat · ${status === 'failed' ? 'Failed' : 'Unknown result'}`, { exact: true }).locator('../..');
    await row.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await row.waitFor({ state: 'detached' });
    assert.equal(store.db.prepare('SELECT status FROM gateway_outbox WHERE id=?').get(`ui-${status}`).status, 'cancelled');
  }
  const discardSent = await context.request.post(`${origin}/api/v1/gateway/deliveries/ui-sent/discard`, { headers: { origin }, data: {} });
  assert.equal(discardSent.status(), 400);
  const output = process.env.SCREENSHOT_DIR || path.join(directory, 'screenshots'); fs.mkdirSync(output, { recursive: true });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    // Reload the appropriate settings root after a mobile/desktop breakpoint.
    await page.evaluate(() => { location.hash = '/settings/gateway'; });
    await page.reload();
    await page.getByTestId('gateway-account-ilink').click();
    await panel.getByRole('button', { name: 'Unlink', exact: true }).waitFor();
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no document overflow at ${width}px`);
    const boxes = await panel.locator('input,select,button,img').evaluateAll(nodes => nodes.map(n => { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right }; }));
    assert.ok(boxes.every(b => b.left >= -1 && b.right <= width + 1), `gateway controls fit ${width}px`);
    await page.screenshot({ path: path.join(output, `gateway-${width}.png`), fullPage: true });
  }
  // Verification codes are sent only on explicit submit, once; blocked/already-bound are terminal states.
  qrStatus = 'need_verifycode';
  await page.getByTestId('gateway-relogin').click();
  const verifyInput = panel.getByRole('textbox', { name: 'Verification code', exact: true });
  await verifyInput.waitFor();
  const pollsBeforeTyping = statusPolls;
  await verifyInput.fill('12'); await sleep(600);
  assert.equal(verifySubmissions.length, 0); assert.equal(statusPolls, pollsBeforeTyping);
  await verifyInput.fill('123456');
  await panel.getByRole('button', { name: 'Submit', exact: true }).click();
  await panel.getByText('Too many incorrect verification codes. Refresh the QR code later.', { exact: true }).waitFor();
  const pollsAfterBlocked = statusPolls;
  await sleep(600);
  assert.deepEqual(verifySubmissions, ['123456']); assert.equal(statusPolls, pollsAfterBlocked);
  qrStatus = 'binded_redirect';
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await panel.getByText('This bot was already connected. Go back to check its status.', { exact: true }).waitFor();
  await page.getByTestId('gateway-wechat-login').getByRole('button', { name: 'Messaging', exact: true }).click();
  qrStatus = 'confirmed';
  await panel.getByRole('button', { name: 'Unlink', exact: true }).click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await page.getByTestId('gateway-pair').waitFor();
  assert.equal(store.db.prepare('SELECT revoked FROM gateway_bindings WHERE id=?').get('ui-binding').revoked, 1);

  // Leaving the login view aborts both QR creation and an outstanding long poll.
  const loginUrl = `${origin}/api/v1/gateway/accounts/${id}/login`;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const action of ['qr', 'poll']) {
      await page.goto(`${origin}/#/settings/gateway`);
      await page.reload();
      await page.getByTestId('gateway-account-ilink').click();
      let heldRoute;
      const isHeldRequest = request => request.url() === loginUrl && request.postDataJSON()?.action === action;
      await page.route(loginUrl, route => {
        if (isHeldRequest(route.request())) heldRoute = route;
        else return route.continue();
      });
      const started = page.waitForRequest(isHeldRequest);
      await page.getByTestId('gateway-relogin').click();
      await started;
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
      await page.waitForFunction(action => window.gatewayLoginAborts.includes(action), action);
      await heldRoute?.abort().catch(() => {});
      await page.unroute(loginUrl);
      await page.getByTestId('settings-modal').waitFor({ state: 'detached' });
    }
  }
  assert.deepEqual(errors, []);
  console.log(`Gateway management browser passed: separate Web/API, safe connection diagnostics, automatic QR login, explicit single-submit verification, blocked/already-bound terminal states, short pairing, automatic binding completion, open/switch Bot panel, masked credentials, reminder cancel, failed/uncertain discard, sent discard rejected, revoke, QR/poll cancellation and controls at 390/1440px. Screenshots: ${output}`);
} catch (e) {
  const pages = browser?.contexts()[0]?.pages() ?? [];
  for (const page of pages) console.error('UI failure:', page.url(), (await page.locator('body').innerText()).slice(-8000));
  throw e;
} finally { store?.close(); await browser?.close(); await web?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
