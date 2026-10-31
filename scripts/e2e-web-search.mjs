import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { workerTokens } from '../apps/api/src/cloud/workerAuth.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-search-e2e-'));
process.env.NODE_ENV = 'test'; process.env.DATA_DIR = dir;
process.env.BOOTSTRAP_SECRET_FILE = path.join(dir, 'config/bootstrap-secret');
process.env.CHROMIUM_PATH ||= '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
delete process.env.CLOUD_WORKER_DISABLED; delete process.env.MODEL_API_KEY;
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(dir, 'app.sqlite'), fetch: async (url, init) => {
  if (String(url).includes('api.tavily.com')) return Response.json({ results: [
    { title: '学习科学：间隔练习与长期记忆', url: 'https://example.org/learning', content: '间隔练习将学习分散在多个时间点，有助于长期保持。检索练习可以帮助检查理解与记忆。', published_date: '2026-10-01' },
    { title: 'Evidence for retrieval practice', url: 'https://example.com/research', content: 'A review of retrieval practice and learning outcomes.' },
  ] });
  const body = JSON.parse(init.body);
  const tool = body.tools?.find(t => t.function?.name === 'websearch');
  const found = body.messages.some(m => m.role === 'tool' && String(m.content).includes('web_search'));
  const delta = tool && !found ? { tool_calls: [{ index: 0, id: 'search', type: 'function', function: { name: 'websearch', arguments: '{"query":"间隔练习 研究","limit":4}' } }] }
    : { content: found ? '搜索已核验：[学习科学](https://example.org/learning)。' : 'No search tool.' };
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  return new Response(frame({ choices: [{ index: 0, delta, finish_reason: null }] }) + frame({ choices: [{ index: 0, delta: {}, finish_reason: tool && !found ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
} });
let browser, web, store;
try {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { startWebFixture } = await import('./lib/web-fixture.mjs');
  web = await startWebFixture(`http://127.0.0.1:${app.server.address().port}`);
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: 'test-password-long-enough' } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'test-password-long-enough' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  const api = async (method, suffix, payload, status = 200, headers = { cookie }) => {
    const response = await app.inject({ method, url: '/api/v1/cloud' + suffix, headers, payload });
    assert.equal(response.statusCode, status, response.body); return response.json();
  };
  await api('GET', '/web-search/config', undefined, 401, {});
  const config = await api('GET', '/config');
  await api('PUT', '/config', { ...config, providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://model.example', apiKey: 'fixture', protocol: 'openai-chat', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture' } });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' });
  await context.addCookies([{ name: 'wangke_session', value: cookie.slice('wangke_session='.length), url: web.origin }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(web.origin + '/#/settings/websearch');
  await page.getByRole('button', { name: '添加 Tavily', exact: true }).click();
  await page.getByLabel('API Key', { exact: true }).fill('test-provider-secret');
  await page.getByText('启用此供应商', { exact: true }).click();
  await page.getByTestId('web-search-settings').locator('.select__trigger').click();
  await page.getByRole('option', { name: 'Tavily', exact: true }).click();
  await page.getByText('启用联网搜索', { exact: true }).click();
  await page.getByText('启用网页正文读取', { exact: true }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('设置已保存', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  assert.ok(!JSON.stringify(await api('GET', '/web-search/config')).includes('test-provider-secret'));
  await page.getByLabel('测试搜索词', { exact: true }).fill('间隔练习 研究');
  await page.getByRole('button', { name: '测试搜索', exact: true }).click();
  await page.getByTestId('web-sources').waitFor();
  assert.equal(await page.getByTestId('web-sources').getByRole('link').count(), 2);
  fs.mkdirSync('test-results/web-search', { recursive: true });
  await page.getByTestId('web-sources').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/web-search/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  // Responsive settings remount; test with the persisted key.
  await page.getByLabel('测试搜索词', { exact: true }).fill('间隔练习 研究');
  await page.getByRole('button', { name: '测试搜索', exact: true }).click();
  await page.getByTestId('web-sources').waitFor();
  await page.getByTestId('web-sources').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: 'test-results/web-search/mobile.png', fullPage: true });
  await page.reload();
  await page.getByLabel('API Key', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  await page.close();

  store = new DatabaseStore(path.join(dir, 'app.sqlite'));
  const owner = store.db.prepare('SELECT id FROM users').get().id, records = new CloudRecords(store);
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: null, after: value }]);
  for (const [id, kind, materialKind] of [[301, 'chat', undefined], [302, 'qa', undefined], [303, 'qa', 'para']]) {
    const videoId = kind === 'chat' ? '__library_assistant__' : `web-${id}`;
    if (kind === 'qa') put('videos', videoId, { id: videoId, name: 'Fixture course', createdAt: Date.now(), format: materialKind ? 'md' : undefined });
    put('chatSessions', id, { id, title: 'Web search test', videoId, createdAt: Date.now() });
    const task = await api('POST', '/tasks', { nonce: crypto.randomUUID(), kind, resource: `session:${id}`, input: { sessionId: id, videoId, text: 'Search the web for learning evidence.', materialKind, materialFormat: materialKind ? 'md' : undefined } }, 201);
    let state = task;
    for (let attempt = 0; attempt < 120 && !['completed', 'failed', 'cancelled'].includes(state.status); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500)); state = await api('GET', `/tasks/${task.id}`);
    }
    assert.equal(state.status, 'completed', JSON.stringify(state));
    const answers = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='chats' AND value IS NOT NULL").all(owner).map(row => JSON.parse(row.value));
    const answer = answers.find(row => row.sessionId === id && row.role === 'assistant');
    assert.match(answer?.content ?? '', /搜索已核验/);
    assert.equal(answer.tools.find(tool => tool.name === 'websearch').webSearch.sources.length, 2);
    assert.equal(state.executor, 'node');
    console.log(`Web search Node worker passed: ${kind}/${materialKind ?? 'video-library'}`);
  }
  await api('POST', '/web-search/catalog', { sessionId: 99999 }, 403);
  await api('POST', '/web-search/call', { sessionId: 301, name: 'websearch', arguments: { query: 'test', endpoint: 'https://evil.example' } }, 400);
  const stale = await api('GET', '/web-search/config');
  await api('PUT', '/web-search/config', { ...stale, enabled: false });
  await api('PUT', '/web-search/config', stale, 409);
  await api('POST', '/web-search/call', { sessionId: 301, name: 'websearch', arguments: { query: 'test' } }, 403);
  assert.deepEqual((await api('POST', '/web-search/catalog', { sessionId: 301 })).tools.map(t => t.function.name), ['webfetch']);
  // Workers can execute only within their task and cannot access credentials/settings.
  const taskId = crypto.randomUUID(), token = crypto.randomUUID();
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,'chat','session:301',?,'running',?,?)").run(taskId, owner, taskId, JSON.stringify({ sessionId: 301 }), new Date().toISOString(), new Date().toISOString());
  workerTokens.set(token, { id: owner, taskId, expiresAt: Date.now() + 60000 });
  const workerHeaders = { authorization: `Bearer ${token}` };
  await api('GET', '/web-search/config', undefined, 403, workerHeaders);
  await api('POST', '/web-search/catalog', { sessionId: 302 }, 403, workerHeaders);
  await api('POST', '/web-search/catalog', { sessionId: 301 }, 200, workerHeaders);
  workerTokens.delete(token);
  assert.deepEqual(errors, []);
  console.log('Web search E2E: desktop/mobile settings and results, saved credentials, real library/video/reading Node workers, persisted sources, auth/scope/revocation passed');
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) console.error(await page.locator('body').innerText().catch(() => 'unavailable'));
  throw error;
} finally { await browser?.close(); await web?.close(); await app.close(); store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
