import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-management-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const reservation = net.createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r)); const port = reservation.address().port; await new Promise(r => reservation.close(r));
const origin = `http://localhost:${port}`; process.env.PUBLIC_ORIGIN = origin;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async url => {
  assert.ok(String(url).startsWith('https://offline.invalid/'), 'no real network');
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'send_message', arguments: '{"kind":"text","text":"UI evidence completed"}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
} });
const until = async fn => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('ui_database_timeout'); };
let browser, store;
try {
  await app.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  assert.equal((await post('/bootstrap/initialize', { adminName: 'BotUI', adminPassword: 'bot-management-password-12345' }, { 'X-Bootstrap-Secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  const login = await post('/auth/password/login', { username: 'BotUI', password: 'bot-management-password-12345' }); assert.equal(login.status(), 200);
  const config = await (await context.request.get(`${origin}/api/v1/cloud/config`)).json();
  assert.equal((await context.request.put(`${origin}/api/v1/cloud/config`, { headers: { origin }, data: { ...config, providers: [{ id: 'offline', name: 'Offline', baseUrl: 'https://offline.invalid/v1', protocol: 'openai-chat', apiKey: 'not-real', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'offline', model: 'scripted' } } })).status(), 200);
  const thread = await (await post('/threads', { mode: 'bot', title: 'Browser management fixture' })).json();
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const panel = page.getByTestId('bot-management');
  const output = process.env.SCREENSHOT_DIR ?? path.join(directory, 'screenshots'); fs.mkdirSync(output, { recursive: true });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    // Settings uses separate mobile/desktop roots. Navigate after resizing so
    // a breakpoint remount cannot discard input while the test is filling it.
    await page.goto(`${origin}/#/settings/data`);
    await panel.getByTestId('bot-usage').waitFor({ timeout: 30000 });
    const budget = panel.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'Execution budgets' }) });
    await budget.getByLabel('Tokens per run', { exact: true }).fill(String(250000 + width));
    await budget.getByRole('button', { name: 'Save', exact: true }).click();
    await until(async () => (await (await context.request.get(`${origin}/api/v1/bot/manage`)).json()).budget.runTokens === 250000 + width);
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
    // Course-fact input uses the same server source validator as the tool;
    // the UI cannot claim a source revision, and edits invalidate the fact.
    const courseOwner = store.db.prepare('SELECT owner_id FROM threads WHERE id=?').get(thread.id).owner_id;
    const courseId = `ui-course-${width}`;
    store.db.prepare("INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,'videos',?,?)").run(courseOwner, JSON.stringify(courseId), JSON.stringify({ id: courseId, name: 'UI course', size: 0, mimeType: 'video/mp4', duration: 1, createdAt: 1, status: 'transcribed' }));
    await editor.getByRole('button', { name: 'New', exact: true }).click();
    await editor.getByRole('combobox', { name: 'Scope', exact: true }).selectOption('course');
    await editor.getByLabel('Bot / course ID (blank for owner)', { exact: true }).fill(courseId);
    await editor.getByRole('combobox', { name: 'Memory type', exact: true }).selectOption('course_fact');
    await editor.getByLabel('Memory content', { exact: true }).fill(`UI fact ${width}`);
    await editor.getByLabel('Source and locator', { exact: true }).fill('record:videos:"not-owned"');
    assert.equal(await editor.getByLabel('Source revision (resolved by server, read-only)', { exact: true }).getAttribute('readonly'), '');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await panel.getByRole('alert').waitFor();
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM bot_memories WHERE content=?').get(`UI fact ${width}`).n, 0);
    await editor.getByLabel('Source and locator', { exact: true }).fill(`record:videos:${JSON.stringify(courseId)}`);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await panel.getByText(`UI fact ${width}`, { exact: true }).waitFor();
    const factRow = store.db.prepare('SELECT * FROM bot_memories WHERE content=?').get(`UI fact ${width}`);
    assert.equal(factRow.source_revision, String(store.db.prepare("SELECT revision FROM cloud_records WHERE owner_id=? AND table_name='videos' AND record_key=?").get(courseOwner, JSON.stringify(courseId)).revision));
    store.db.prepare("UPDATE cloud_records SET value=NULL WHERE owner_id=? AND table_name='videos' AND record_key=?").run(courseOwner, JSON.stringify(courseId));
    await panel.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
    await until(() => store.db.prepare('SELECT status FROM bot_memories WHERE id=?').get(factRow.id).status === 'stale');
    const id = `ui-paused-${width}`, at = new Date().toISOString();
    store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,error_code,created_at) VALUES(?,?,'bot','paused','run_token_budget',?)").run(id, thread.id, at);
    await panel.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
    let runRow = panel.locator('span').filter({ hasText: id }).locator('..');
    await runRow.getByRole('button', { name: 'Explicitly continue', exact: true }).click();
    await until(() => store.db.prepare('SELECT status FROM runs WHERE id=?').get(id).status === 'completed');
    await panel.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
    runRow = panel.locator('span').filter({ hasText: id }).locator('..');
    await runRow.getByRole('button', { name: 'Details', exact: true }).click();
    await panel.getByLabel('Thread skill scope JSON', { exact: true }).fill('[]');
    const detail = panel.getByLabel('Thread skill scope JSON', { exact: true }).locator('..').locator('..');
    await detail.getByRole('button', { name: 'Save', exact: true }).click();
    await until(() => store.db.prepare('SELECT skill_ids FROM threads WHERE id=?').get(thread.id).skill_ids === '[]');
    assert.ok(await detail.innerText().then(text => text.includes('100 + 50')));
    const stop = `ui-stop-${width}`;
    store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at,wake_at) VALUES(?,?,'bot',?,?,?)").run(stop, thread.id, width === 390 ? 'paused' : 'queued', at, '2099-01-01T00:00:00.000Z');
    await panel.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
    await panel.locator('span').filter({ hasText: stop }).locator('..').getByRole('button', { name: 'Stop', exact: true }).click();
    await until(() => store.db.prepare('SELECT status FROM runs WHERE id=?').get(stop).status === 'cancelled');
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no overflow at ${width}`);
    const boxes = await panel.locator('input,textarea,select,button').evaluateAll(nodes => nodes.map(n => { const box = n.getBoundingClientRect(); return { left: box.left, right: box.right }; }));
    assert.ok(boxes.every(box => box.left >= -1 && box.right <= width + 1), `controls fit ${width}`);
    await page.screenshot({ path: path.join(output, `bot-management-${width}.png`), fullPage: true });
  }
  const { workerTokens } = await import('../apps/api/src/cloud/workerAuth.ts');
  const owner = (await login.json()).user.id, childAt = new Date().toISOString();
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at,parent_run_id) VALUES('browser-ledger',?,'browser-ledger','cards','course:test','{}','running',?,?,'ui-paused-1440')").run(owner, childAt, childAt);
  workerTokens.set('browser-ledger-token', { id: owner, taskId: 'browser-ledger' });
  try {
    const response = await post('/cloud/models/offline/chat/completions', { model: 'scripted', messages: [] }, { authorization: 'Bearer browser-ledger-token' });
    assert.equal(response.status(), 200);
    assert.ok(store.db.prepare("SELECT 1 FROM bot_requests WHERE task_id='browser-ledger' AND run_id='ui-paused-1440' AND purpose='study:cards' AND input_tokens=100").get(), 'browser proxy request accounted exactly once');
    store.db.prepare("UPDATE runs SET status='paused' WHERE id='ui-paused-1440'").run();
    assert.equal((await post('/cloud/models/offline/chat/completions', { model: 'scripted', messages: [] }, { authorization: 'Bearer browser-ledger-token' })).status(), 403, 'paused parent denies browser child calls');
  } finally { workerTokens.delete('browser-ledger-token'); }
  assert.deepEqual(errors, []);
  console.log(`Bot management browser passed at 390/1440px: save budgets, memory create/edit/delete/restore, explicit resume, usage/details, skill scope and stop. Screenshots: ${output}`);
} catch (error) {
  for (const page of browser?.contexts()[0]?.pages() ?? []) { console.error((await page.locator('body').innerText()).slice(-10000)); console.error(await page.getByTestId('bot-management').ariaSnapshot()); }
  throw error;
} finally { store?.close(); await browser?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
