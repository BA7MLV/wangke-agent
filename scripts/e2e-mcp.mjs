import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-mcp-e2e-'));
process.env.NODE_ENV = 'test'; process.env.DATA_DIR = dir;
process.env.BOOTSTRAP_SECRET_FILE = path.join(dir, 'config/bootstrap-secret');
process.env.CHROMIUM_PATH ||= '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
delete process.env.CLOUD_WORKER_DISABLED;
delete process.env.MODEL_API_KEY;
const toolCalls = [];
let cancelledRequestClosed = false;
const pendingResponses = new Map();
const fixture = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  let text = ''; for await (const chunk of req) text += chunk;
  const rpc = JSON.parse(text);
  if (!('id' in rpc)) {
    // Protocol 2025-03-26 cancels with a notification (not an HTTP stream abort).
    if (rpc.method === 'notifications/cancelled') {
      const pending = pendingResponses.get(rpc.params.requestId);
      if (pending) { pending.end(); pendingResponses.delete(rpc.params.requestId); }
    }
    res.writeHead(202); res.end(); return;
  }
  let result;
  if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'e2e', version: '1' }, capabilities: { tools: {} } };
  else if (rpc.method === 'tools/list') result = { tools: [{ name: 'study_echo', description: 'Read a study fact', inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } }] };
  else if (rpc.method === 'tools/call') {
    toolCalls.push(rpc.params);
    if (rpc.params.arguments?.topic === 'cancel-test') {
      res.on('close', () => { cancelledRequestClosed = true; });
      pendingResponses.set(rpc.id, res);
      // A cooperating MCP service stops on the protocol cancellation notification.
      return;
    }
    result = { content: [{ type: 'text', text: 'MCP verified learning fact: spaced repetition.' }] };
  }
  else { res.writeHead(400); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${fixture.address().port}/mcp`;
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(dir, 'app.sqlite'), fetch: async (_url, init) => {
  const body = JSON.parse(init.body);
  const tool = body.tools?.find(t => t.function?.name.startsWith('mcp_'));
  const hasResult = body.messages.some(m => m.role === 'tool' && String(m.content).includes('MCP verified learning fact'));
  const cancelTest = body.messages.some(m => m.role === 'user' && String(m.content).includes('cancel-test'));
  const delta = tool && !hasResult
    ? { tool_calls: [{ index: 0, id: 'call_e2e', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ topic: cancelTest ? 'cancel-test' : 'learning' }) } }] }
    : { content: hasResult ? 'MCP verified: spaced repetition.' : 'No MCP available.' };
  const frame = data => `data: ${JSON.stringify(data)}\n\n`;
  return new Response(frame({ choices: [{ index: 0, delta, finish_reason: null }] }) + frame({ choices: [{ index: 0, delta: {}, finish_reason: tool && !hasResult ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
} });
let browser, store, web;
try {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { startWebFixture } = await import('./lib/web-fixture.mjs');
  web = await startWebFixture(`http://127.0.0.1:${app.server.address().port}`);
  const base = web.origin;
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: 'test-password-long-enough' } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'test-password-long-enough' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  const api = async (method, suffix, body) => {
    const r = await app.inject({ method, url: '/api/v1/cloud' + suffix, headers: { cookie }, payload: body });
    assert.ok(r.statusCode < 300, r.body); return r.json();
  };
  const config = await api('GET', '/config');
  await api('PUT', '/config', { ...config, policy: { ...config.policy, read: 'allow' }, providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://model.example', apiKey: 'fixture', protocol: 'openai-chat', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture' } });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' });
  await context.addCookies([{ name: 'wangke_session', value: cookie.slice('wangke_session='.length), url: base }]);
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/#/settings/skills');
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '添加服务器', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('Learning MCP');
  await page.getByLabel('服务 URL', { exact: true }).fill(endpoint);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByText('study_echo', { exact: true }).waitFor();
  const server = (await api('GET', '/mcp')).servers[0];
  assert.equal(server.status, 'ready'); assert.equal(server.toolCount, 1);
  fs.mkdirSync('e2e-shots/mcp', { recursive: true });
  await page.screenshot({ path: 'e2e-shots/mcp/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '编辑服务器', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('Learning MCP mobile');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByLabel('服务 URL', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '保存', exact: true }).waitFor({ state: 'hidden' });
  await page.screenshot({ path: 'e2e-shots/mcp/mobile.png', fullPage: true });
  assert.equal((await api('GET', '/mcp')).servers[0].name, 'Learning MCP mobile');
  // A second browser/device observes the same server-side configuration.
  const device = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' });
  await device.addCookies(await context.cookies());
  const secondPage = await device.newPage();
  await secondPage.goto(base + '/#/settings/skills');
  await secondPage.getByRole('button', { name: 'MCP', exact: true }).click();
  await secondPage.getByText('Learning MCP mobile', { exact: true }).waitFor();
  await secondPage.getByRole('button', { name: '导入 JSON', exact: true }).click();
  await secondPage.getByRole('textbox', { name: '导入 JSON', exact: true }).fill(JSON.stringify({ mcpServers: { 'Imported SSE': { type: 'sse', url: endpoint, disabled: true }, 'Imported stdio': { command: 'node', args: ['server.mjs'], disabled: true, env: { SECRET: 'not-returned' } } } }));
  await secondPage.getByRole('button', { name: '预览', exact: true }).click();
  await secondPage.getByText('Imported SSE · sse', { exact: true }).waitFor();
  await secondPage.getByRole('button', { name: '确认导入', exact: true }).click();
  await secondPage.getByRole('textbox', { name: '导入 JSON', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await api('GET', '/mcp')).servers.length, 3);
  assert.ok(!JSON.stringify(await api('GET', '/mcp')).includes('not-returned'));
  await secondPage.setViewportSize({ width: 390, height: 844 });
  await secondPage.getByRole('button', { name: 'MCP', exact: true }).click();
  const localCard = secondPage.getByTestId('mcp-settings').locator(':scope > section').filter({ has: secondPage.getByRole('heading', { name: 'Imported stdio', exact: true }) });
  await localCard.getByRole('button', { name: '编辑服务器', exact: true }).click();
  assert.equal(await secondPage.getByLabel('连接类型', { exact: true }).inputValue(), 'stdio');
  assert.equal(await secondPage.getByLabel('环境变量（JSON，留空保留）', { exact: true }).inputValue(), '');
  await secondPage.getByLabel('可执行程序', { exact: true }).fill(process.execPath);
  await secondPage.getByLabel('参数（JSON 数组）', { exact: true }).fill(JSON.stringify([path.resolve('scripts/fixtures/mcp-stdio.mjs')]));
  await secondPage.getByLabel('环境变量（JSON，留空保留）', { exact: true }).fill(JSON.stringify({ MCP_TEST_SECRET: 'browser-stdio-secret' }));
  await secondPage.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
  const formOnTop = await secondPage.getByLabel('环境变量（JSON，留空保留）', { exact: true }).evaluate(el => {
    const rect = el.getBoundingClientRect();
    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { visible: top === el, covering: top?.outerHTML.slice(0, 300) };
  });
  assert.equal(formOnTop.visible, true, JSON.stringify(formOnTop));
  await secondPage.screenshot({ path: 'e2e-shots/mcp/stdio-mobile.png', fullPage: true });
  await secondPage.getByRole('button', { name: '保存', exact: true }).click();
  await secondPage.getByLabel('可执行程序', { exact: true }).waitFor({ state: 'hidden' });
  await localCard.getByRole('button', { name: '测试连接', exact: true }).click();
  await localCard.getByText('echo', { exact: true }).waitFor();
  await localCard.getByRole('button', { name: '进程日志', exact: true }).click();
  await localCard.getByText('fixture [redacted]', { exact: true }).waitFor();
  const localServer = (await api('GET', '/mcp')).servers.find(s => s.name === 'Imported stdio');
  assert.ok(localServer.pid);
  assert.ok(!JSON.stringify(localServer).includes('browser-stdio-secret'));
  await secondPage.setViewportSize({ width: 1280, height: 900 });
  await secondPage.getByRole('button', { name: 'MCP', exact: true }).click();
  await secondPage.getByText('Imported stdio', { exact: true }).waitFor();
  await secondPage.screenshot({ path: 'e2e-shots/mcp/compat-desktop.png', fullPage: true });
  await secondPage.keyboard.press('Escape');
  await secondPage.getByTestId('chat-add').click();
  await secondPage.getByRole('menuitem', { name: '技能与 MCP 范围', exact: true }).click();
  await secondPage.getByRole('button', { name: '全部关闭', exact: true }).click();
  await secondPage.getByText('本次会话已关闭全部 MCP', { exact: true }).waitFor();
  await secondPage.getByTestId('skill-picker-done').click();
  await secondPage.locator('textarea').last().fill('Verify MCP is disabled in this draft conversation.');
  await secondPage.locator('textarea').last().press('Enter');
  await secondPage.getByText('No MCP available.', { exact: true }).waitFor({ timeout: 60000 });
  await secondPage.reload();
  await secondPage.getByTestId('chat-add').click();
  await secondPage.getByRole('menuitem', { name: /技能与 MCP 范围/ }).click();
  await secondPage.getByText('本次会话已关闭全部 MCP', { exact: true }).waitFor();

  // Run the actual Chromium compatibility executor with a closed user page.
  await page.close(); await secondPage.close();
  store = new DatabaseStore(path.join(dir, 'app.sqlite'));
  const owner = store.db.prepare('SELECT id FROM users').get().id;
  const records = new CloudRecords(store);
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: null, after: value }]);
  put('skills', 9041, { id: 9041, name: 'MCP-dependent skill', description: 'Test dependency hints', body: 'Use the available study tools.', enabled: 1, builtin: 0, updatedAt: Date.now(), mcpRequired: ['Learning MCP mobile', 'Missing MCP'] });
  for (const [id, kind, materialKind] of [[201, 'chat', undefined], [202, 'qa', undefined], [203, 'qa', 'para']]) {
    const videoId = kind === 'chat' ? '__library_assistant__' : `fixture-${id}`;
    if (kind === 'qa') put('videos', videoId, { id: videoId, name: 'Fixture course', createdAt: Date.now(), format: materialKind ? 'md' : undefined });
    put('chatSessions', id, { id, title: 'MCP test', videoId, createdAt: Date.now() });
    const task = await api('POST', '/tasks', { nonce: crypto.randomUUID(), kind, resource: `session:${id}`, input: { sessionId: id, videoId, text: 'Use MCP to read a study fact.', materialKind, materialFormat: materialKind ? 'md' : undefined } });
    let state = task;
    for (let attempt = 0; attempt < 180 && !['completed', 'failed', 'cancelled'].includes(state.status); attempt++) {
      await new Promise(r => setTimeout(r, 500)); state = await api('GET', `/tasks/${task.id}`);
    }
    assert.equal(state.status, 'completed', JSON.stringify(state));
    const chats = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='chats' AND value IS NOT NULL").all(owner).map(r => JSON.parse(r.value));
    const answer = chats.find(c => c.sessionId === id && c.role === 'assistant');
    assert.match(answer?.content ?? '', /MCP verified/, JSON.stringify(state));
    assert.ok(answer.tools?.some(t => t.name.includes('Learning MCP mobile') && t.status === 'done'), JSON.stringify(answer));
    assert.match(JSON.stringify(answer.tools), /Missing MCP/, 'missing skill dependencies must be visible in the persisted tool trace');
    console.log(`MCP browser task verified: ${kind} ${materialKind ?? 'video/library'}`);
  }
  assert.equal(toolCalls.length, 3);
  put('chatSessions', 204, { id: 204, title: 'Cancel MCP', videoId: '__library_assistant__', createdAt: Date.now() });
  const cancelled = await api('POST', '/tasks', { nonce: crypto.randomUUID(), kind: 'chat', resource: 'session:204', input: { sessionId: 204, text: 'cancel-test' } });
  for (let i = 0; i < 120 && toolCalls.length < 4; i++) await new Promise(r => setTimeout(r, 250));
  assert.equal(toolCalls.length, 4);
  await api('POST', `/tasks/${cancelled.id}/cancel`);
  for (let i = 0; i < 40 && !cancelledRequestClosed; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(cancelledRequestClosed, true, 'task cancellation must reach the MCP service');
  assert.equal((await api('GET', `/tasks/${cancelled.id}`)).status, 'cancelled');
  assert.deepEqual(errors, []);
  console.log('MCP E2E passed: desktop/mobile settings, JSON import, stdio form/process/logs, cross-device configuration, skill dependency hints, real library/video/reading tasks after browser closure.');
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) console.error('Page:', page.url(), await page.locator('body').innerText().catch(() => 'unavailable'));
  throw error;
} finally {
  await browser?.close(); await web?.close(); await app.close(); store?.close();
  fixture.closeAllConnections(); await new Promise(r => fixture.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
