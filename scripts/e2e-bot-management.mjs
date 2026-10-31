import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-management-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const reservation = net.createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r)); const port = reservation.address().port; await new Promise(r => reservation.close(r));
const origin = `http://localhost:${port}`; process.env.PUBLIC_ORIGIN = origin;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async url => {
  assert.ok(String(url).startsWith('https://offline.invalid/'), 'no real network');
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'UI evidence completed 🙂' } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
} });
const until = async fn => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('ui_database_timeout'); };
let browser, store, web, lastReplyRun;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), server: { host: 'localhost', port, strictPort: true, proxy: { '/api/v1': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false } } } });
  await web.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  assert.equal((await post('/bootstrap/initialize', { adminName: 'BotUI', adminPassword: 'bot-management-password-12345' }, { 'X-Bootstrap-Secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  const login = await post('/auth/password/login', { username: 'BotUI', password: 'bot-management-password-12345' }); assert.equal(login.status(), 200);
  const config = await (await context.request.get(`${origin}/api/v1/cloud/config`)).json();
  assert.equal((await context.request.put(`${origin}/api/v1/cloud/config`, { headers: { origin }, data: { ...config, providers: [{ id: 'offline', name: 'Offline', baseUrl: 'https://offline.invalid/v1', protocol: 'openai-chat', apiKey: 'not-real', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'offline', model: 'scripted' } } })).status(), 200);
  const thread = await (await post('/threads', { mode: 'bot', title: 'Browser management fixture' })).json();
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const { BotApplicationService } = await import('../apps/api/src/agent/service.ts');
  const bot = new BotApplicationService(store, { enqueue() {} });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
  for (const [name, mime, bytes, role] of [['Bot-image.png', 'image/png', png, 'user'], ['Bot-export.zip', 'application/zip', Buffer.from([80,75,3,4,0,1,2,3]), 'assistant']]) {
    const result = await post('/files', bytes, { 'content-type': 'application/octet-stream', 'x-file-name': name, 'x-file-mime': mime });
    assert.equal(result.status(), 201); const file = await result.json();
    bot.append(thread.id, role, 'attachment', JSON.stringify({ fileId: file.id, name, mimeType: mime }));
  }
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const panel = page.getByTestId('bot-management');
  const output = process.env.SCREENSHOT_DIR ?? path.join(directory, 'screenshots'); fs.mkdirSync(output, { recursive: true });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    // Settings uses separate mobile/desktop roots. Navigate after resizing so
    // a breakpoint remount cannot discard input while the test is filling it.
    await page.goto(`${origin}/#/settings/bot`);
    await panel.getByTestId('bot-model-settings').waitFor({ timeout: 30000 });
    assert.equal(await panel.getByLabel('Tokens per run', { exact: true }).count(), 0);
    assert.equal(await panel.locator('#bot-budget-prices').count(), 0);
    assert.match(await panel.getByTestId('bot-model-settings').innerText(), /Just chat/);
    assert.equal(await panel.getByTestId('bot-run-diagnostics').getAttribute('open'), null);
    const editor = panel.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'Create / edit memory' }) });
    const content = `UI memory ${width}`;
    await editor.getByLabel('Memory content', { exact: true }).fill(content);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await panel.getByText(content, { exact: true }).waitFor();
    let row = panel.getByText(content, { exact: true }).locator('..');
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await panel.getByLabel('Memory content', { exact: true }).fill(`${content} edited`);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await panel.getByText(`${content} edited`, { exact: true }).waitFor();
    row = panel.getByText(`${content} edited`, { exact: true }).locator('..');
    await row.getByRole('button', { name: 'Delete memory', exact: true }).click();
    await page.getByRole('button', { name: 'Delete memory', exact: true }).last().click();
    await until(() => store.db.prepare("SELECT 1 FROM bot_memories WHERE status='deleted' AND source='user:management' AND revision=3").get());
    const deleted = panel.getByText('Deleted (source tombstone retained)', { exact: true }).last().locator('..');
    await deleted.getByRole('button', { name: 'Version history', exact: true }).click();
    const old = panel.getByText(`r1 · ${content}`, { exact: true }).locator('..');
    await old.getByRole('button', { name: 'Restore as new revision', exact: true }).click();
    await panel.getByText(content, { exact: true }).waitFor();
    assert.equal(await editor.getByRole('button', { name: 'Scope', exact: false }).count(), 0);
    assert.equal(await editor.getByLabel('Source and locator', { exact: true }).count(), 0);
    const id = `ui-paused-${width}`, at = new Date().toISOString();
    store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,error_code,created_at) VALUES(?,?,'bot','paused','context_capacity_exceeded',?)").run(id, thread.id, at);
    await panel.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
    let runRow = panel.getByTestId(`bot-run-${id}`);
    await panel.getByTestId('bot-run-diagnostics').locator('summary').click();
    assert.match(await runRow.innerText(), /work already done is saved/);
    assert.equal(await panel.getByRole('button', { name: 'Continue task', exact: true }).count(), 0);
    await page.evaluate(async () => { const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('zh-CN'); });
    await runRow.getByText(/已经完成的部分都保留着/).waitFor();
    assert.equal(await panel.getByRole('button', { name: '继续任务', exact: true }).count(), 0);
    assert.ok(!(await runRow.innerText()).includes('context_capacity_exceeded'));
    await runRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `bot-paused-zh-${width}.png`) });
    await panel.getByTestId('bot-model-settings').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `bot-settings-zh-${width}.png`) });
    await page.evaluate(async () => { const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('en-US'); });
    const message = await (await post(`/threads/${thread.id}/messages`, { clientNonce: `ordinary-chat-${width}`, content: 'Hello 🙂' })).json();
    lastReplyRun = store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(message.id).id;
    await until(() => store.db.prepare('SELECT status FROM runs WHERE id=?').get(lastReplyRun).status === 'completed');
    assert.ok(store.db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND kind='text' AND content='UI evidence completed 🙂'").get(thread.id));
    await panel.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
    runRow = panel.getByTestId(`bot-run-${lastReplyRun}`);
    await runRow.getByRole('button', { name: 'Details', exact: true }).click();
    await panel.getByLabel('Thread skill scope JSON', { exact: true }).fill('[]');
    const detail = panel.getByLabel('Thread skill scope JSON', { exact: true }).locator('..').locator('..');
    await detail.getByRole('button', { name: 'Save', exact: true }).click();
    await until(() => store.db.prepare('SELECT skill_ids FROM threads WHERE id=?').get(thread.id).skill_ids === '[]');
    assert.ok(await detail.innerText().then(text => text.includes('100 + 50')));
    const stop = `ui-stop-${width}`;
    store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at,wake_at) VALUES(?,?,'bot',?,?,?)").run(stop, thread.id, width === 390 ? 'paused' : 'queued', at, '2099-01-01T00:00:00.000Z');
    await panel.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
    await panel.getByTestId(`bot-run-${stop}`).getByRole('button', { name: 'Stop', exact: true }).click();
    await until(() => store.db.prepare('SELECT status FROM runs WHERE id=?').get(stop).status === 'cancelled');
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no overflow at ${width}`);
    const boxes = await panel.locator('input,textarea,select,button').evaluateAll(nodes => nodes.map(n => { const box = n.getBoundingClientRect(); return { left: box.left, right: box.right }; }));
    assert.ok(boxes.every(box => box.left >= -1 && box.right <= width + 1), `controls fit ${width}`);
    await page.screenshot({ path: path.join(output, `bot-management-${width}.png`), fullPage: true });
    await panel.getByRole('button', { name: 'View resources', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    const image = page.getByTestId('resource-entry').filter({ hasText: 'Bot-image.png' });
    await image.locator('.resource-open').click();
    await page.waitForFunction(() => document.querySelector('.image-preview img')?.naturalWidth > 0);
    await page.screenshot({ path: path.join(output, `bot-image-${width}.png`) });
    await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByTestId('resource-entry').filter({ hasText: 'Bot-export.zip' }).locator('.resource-open').click();
    assert.equal((await downloaded).suggestedFilename(), 'Bot-export.zip');
    await page.screenshot({ path: path.join(output, `bot-resources-${width}.png`) });
  }
  const { workerTokens } = await import('../apps/api/src/cloud/workerAuth.ts');
  const owner = (await login.json()).user.id, childAt = new Date().toISOString();
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at,parent_run_id) VALUES('browser-ledger',?,'browser-ledger','cards','course:test','{}','running',?,?,?)").run(owner, childAt, childAt, lastReplyRun);
  workerTokens.set('browser-ledger-token', { id: owner, taskId: 'browser-ledger' });
  try {
    const response = await post('/cloud/models/offline/chat/completions', { model: 'scripted', messages: [] }, { authorization: 'Bearer browser-ledger-token' });
    assert.equal(response.status(), 200);
    assert.ok(store.db.prepare("SELECT 1 FROM bot_requests WHERE task_id='browser-ledger' AND run_id=? AND purpose='study:cards' AND input_tokens=100").get(lastReplyRun), 'browser proxy request accounted exactly once');
    store.db.prepare("UPDATE runs SET status='paused' WHERE id=?").run(lastReplyRun);
    assert.equal((await post('/cloud/models/offline/chat/completions', { model: 'scripted', messages: [] }, { authorization: 'Bearer browser-ledger-token' })).status(), 403, 'paused parent denies browser child calls');
  } finally { workerTokens.delete('browser-ledger-token'); }
  assert.deepEqual(errors, []);
  console.log(`Bot management browser passed at 390/1440px: conversational settings, no resume controls, direct text/emoji replies, memory create/edit/delete/restore, details, skill scope and stop. Screenshots: ${output}`);
} catch (error) {
  for (const page of browser?.contexts()[0]?.pages() ?? []) { console.error((await page.locator('body').innerText()).slice(-10000)); console.error(await page.getByTestId('bot-management').ariaSnapshot()); }
  throw error;
} finally { store?.close(); await browser?.close(); await web?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
