import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { McpRepository } from '../apps/api/src/mcp/repository.ts';
import { McpManager } from '../apps/api/src/mcp/manager.ts';
import { workerTokens } from '../apps/api/src/cloud/workerAuth.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { mcpResultText } from '../packages/contracts/src/mcp.ts';

// Real HTTP transport fixture, including paginated discovery and intentional failures.
const calls = [], initializations = [], requests = [];
const remote = http.createServer(async (req, res) => {
  requests.push({ url: req.url, auth: req.headers.authorization });
  if (req.url === '/auth' && req.headers.authorization !== 'Bearer test-secret') { res.writeHead(401); res.end(); return; }
  if (req.url === '/redirect') { res.writeHead(307, { location: '/mcp' }); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const rpc = JSON.parse(body);
  if (!('id' in rpc)) { res.writeHead(202); res.end(); return; }
  let result;
  if (rpc.method === 'initialize') {
    initializations.push(req.url);
    result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  } else if (rpc.method === 'tools/list') {
    result = req.url === '/many' ? { tools: Array.from({ length: 81 }, (_, index) => ({ name: `tool_${index}`, inputSchema: { type: 'object', properties: {} } })) } : rpc.params?.cursor === 'next'
      ? { tools: [{ name: 'second', description: 'Second page', inputSchema: { type: 'object', properties: {} } }] }
      : { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }], nextCursor: 'next' };
  } else if (rpc.method === 'tools/call') {
    calls.push({ url: req.url, ...rpc.params });
    if (req.url === '/slow') { await new Promise(resolve => setTimeout(resolve, 2000)); }
    result = { content: [{ type: 'text', text: `fixture:${rpc.params.arguments?.text ?? ''}` }], structuredContent: { source: req.url }, ...(req.url === '/error' ? { isError: true } : {}) };
  } else { res.writeHead(400); res.end(); return; }
  if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })); }
});
await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${remote.address().port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-mcp-'));
process.env.NODE_ENV = 'test'; process.env.DATA_DIR = dir;
process.env.BOOTSTRAP_SECRET_FILE = path.join(dir, 'config/bootstrap-secret');
process.env.CLOUD_WORKER_DISABLED = '1'; delete process.env.MODEL_API_KEY;
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(dir, 'api.sqlite'), staticDir: path.join(dir, 'empty') });
const store = new DatabaseStore(path.join(dir, 'unit.sqlite'));
const owner = crypto.randomUUID(), other = crypto.randomUUID();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, new Date().toISOString());
const config = new CloudConfiguration(store, path.join(dir, 'unit-config'));
const repository = new McpRepository(store, config), manager = new McpManager(repository);
const input = (name, endpoint = '/mcp') => ({ name, url: base + endpoint, transport: 'streamable-http', enabled: true, auth: 'none', timeoutMs: 3000, disabledTools: [] });
let bot;
try {
  const first = repository.save(owner, { ...input('First', '/auth'), auth: 'bearer', token: 'test-secret' });
  assert.equal(repository.public(first).token, undefined);
  assert.ok(!store.db.prepare('SELECT credentials FROM mcp_servers WHERE id=?').get(first.id).credentials.includes('test-secret'));
  assert.equal(repository.save(owner, repository.public(first), first.id).token, 'test-secret');
  assert.equal(repository.list(other).length, 0);
  assert.throws(() => repository.save(other, input('cross-owner'), first.id), /not_found/);
  assert.throws(() => repository.save(owner, { ...input('bad'), url: base + '/mcp?token=secret' }), /invalid_url/);
  assert.throws(() => repository.save(owner, { ...input('bad'), auth: 'headers', headers: { host: 'evil' } }), /credentials/);
  const second = repository.save(owner, input('Second'));
  const startInit = initializations.length;
  const [a, b] = await Promise.all([manager.catalog(owner), manager.catalog(owner)]);
  assert.equal(initializations.length - startInit, 2, 'parallel discovery deduplicates connections');
  assert.equal(a.tools.length, 4, 'all pages loaded'); assert.deepEqual(a, b);
  const echo = a.tools.find(t => t.serverId === first.id && t.originalName === 'echo');
  assert.notEqual(echo.name, a.tools.find(t => t.serverId === second.id && t.originalName === 'echo').name);
  assert.match(echo.name, /^[a-zA-Z0-9_-]{1,64}$/);
  const result = await manager.call(owner, echo.name, { text: 'hello' });
  assert.match(result.text, /fixture:hello/); assert.match(result.text, /source/); assert.equal(result.isError, false);
  assert.deepEqual((await manager.catalog(owner, [])).tools, []);
  await assert.rejects(manager.call(owner, echo.name, {}, []), /unavailable/);
  await assert.rejects(manager.call(other, echo.name, {}), /unavailable/);
  repository.save(owner, { ...repository.public(repository.get(owner, first.id)), disabledTools: ['echo'] }, first.id);
  await assert.rejects(manager.call(owner, echo.name, {}), /disabled/);
  const failed = repository.save(owner, { ...input('Bad auth', '/auth'), auth: 'bearer', token: 'wrong-secret' });
  await assert.rejects(manager.test(owner, failed.id), /auth_failed/);
  assert.equal(manager.list(owner).find(s => s.id === failed.id).status, 'auth_failed');
  const redirect = repository.save(owner, input('Redirect', '/redirect'));
  await assert.rejects(manager.test(owner, redirect.id), /connection_failed/);
  const errors = repository.save(owner, input('Errors', '/error'));
  const errorTool = (await manager.test(owner, errors.id)).tools[0];
  assert.equal((await manager.call(owner, errorTool.name, { text: 'error' })).isError, true);
  const slow = repository.save(owner, { ...input('Slow', '/slow'), timeoutMs: 1000 });
  const slowTool = (await manager.test(owner, slow.id)).tools[0];
  const count = calls.length;
  const timeout = await manager.call(owner, slowTool.name, { text: 'timeout' });
  assert.equal(timeout.isError, true); assert.match(timeout.text, /not retried/);
  assert.equal(calls.length, count + 1, 'no automatic replay on timeout');
  const abort = new AbortController();
  const pending = manager.call(owner, slowTool.name, { text: 'abort' }, undefined, abort.signal);
  setTimeout(() => abort.abort(), 40);
  await assert.rejects(pending);
  assert.match(mcpResultText({ content: [{ type: 'image', data: 'base64' }] }), /not supported/);
  assert.match(mcpResultText({ content: [{ type: 'text', text: 'x'.repeat(30000) }] }), /truncated/);
  const many = repository.save(owner, input('Many tools', '/many'));
  const budget = await manager.catalog(owner, [many.id]);
  assert.equal(budget.tools.length, 1); assert.equal(budget.tools[0].kind, 'gateway');
  const discovered = await manager.call(owner, budget.tools[0].name, { action: 'tools', query: 'tool_80' }, [many.id]);
  assert.match(discovered.text, /tool_80/);
  assert.match((await manager.call(owner, budget.tools[0].name, { action: 'call', name: 'tool_80', arguments: { text: 'dynamic' } }, [many.id])).text, /fixture:dynamic/);
  repository.save(owner, { ...repository.public(repository.get(owner, many.id)), disabledTools: ['tool_80'] }, many.id);
  await manager.invalidate(owner, many.id);
  const beforeDisabledCall = calls.length;
  assert.doesNotMatch((await manager.call(owner, budget.tools[0].name, { action: 'tools', query: 'tool_80' }, [many.id])).text, /tool_80/);
  assert.equal((await manager.call(owner, budget.tools[0].name, { action: 'call', name: 'tool_80' }, [many.id])).isError, true);
  assert.equal(calls.length, beforeDisabledCall, 'gateway calls cannot bypass disabled tools');
  await assert.rejects(manager.call(owner, budget.tools[0].name, { action: 'call', name: 'tool_1' }, []), /unavailable/);

  // Authenticated API + real worker identities. Scope is read from server records, not client input.
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: 'test-password-long-enough' } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'test-password-long-enough' } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const request = (method, url, payload, headers = { cookie }) => app.inject({ method, url: `/api/v1/cloud${url}`, payload, headers });
  assert.equal((await request('GET', '/mcp', undefined, {})).statusCode, 401);
  assert.equal((await request('POST', '/mcp', input('CSRF'), { cookie, origin: 'https://evil.example' })).statusCode, 403);
  const saved = (await request('POST', '/mcp', { ...input('API fixture', '/auth'), auth: 'bearer', token: 'test-secret' })).json();
  assert.ok(saved.id); assert.equal(saved.token, undefined); assert.equal(saved.configured, true);
  const test = await request('POST', `/mcp/${saved.id}/test`); assert.equal(test.statusCode, 200, test.body);
  const apiTool = test.json().tools[0];
  assert.equal((await request('POST', '/mcp/catalog', { sessionId: 999 })).statusCode, 400);
  const apiStore = new DatabaseStore(path.join(dir, 'api.sqlite'));
  const apiOwner = apiStore.db.prepare('SELECT id FROM users').get().id;
  const records = new CloudRecords(apiStore);
  const mutate = (key, before, after) => records.apply(apiOwner, [{ id: crypto.randomUUID(), table: 'chatSessions', key, before, after }]);
  for (const [sessionId, kind] of [[101, 'chat'], [102, 'qa'], [103, 'qa']]) {
    const session = { id: sessionId, title: kind, videoId: kind === 'chat' ? '__library_assistant__' : `course-${sessionId}`, createdAt: Date.now() };
    mutate(sessionId, null, session);
    const taskId = crypto.randomUUID(), token = crypto.randomUUID(), timestamp = new Date().toISOString();
    apiStore.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'running',?,?)").run(taskId, apiOwner, token, kind, `session:${sessionId}`, JSON.stringify({ sessionId }), timestamp, timestamp);
    workerTokens.set(token, { id: apiOwner, taskId });
    const headers = { authorization: `Bearer ${token}` };
    const catalog = await request('POST', '/mcp/catalog', { sessionId }, headers);
    assert.equal(catalog.statusCode, 200, catalog.body); assert.equal(catalog.json().tools.length, 2);
    const called = await request('POST', '/mcp/call', { sessionId, name: apiTool.name, arguments: { text: kind } }, headers);
    assert.equal(called.statusCode, 200, called.body); assert.match(called.json().text, new RegExp(`fixture:${kind}`));
    assert.equal((await request('POST', '/mcp/catalog', { sessionId: 999 }, headers)).statusCode, 400);
    assert.equal((await request('POST', '/mcp', input('worker-write'), headers)).statusCode, 403);
    mutate(sessionId, session, { ...session, mcpServerIds: [] });
    assert.equal((await request('POST', '/mcp/call', { sessionId, name: apiTool.name, arguments: {} }, headers)).statusCode, 400);
    workerTokens.delete(token);
  }
  const thread = (await app.inject({ method: 'POST', url: '/api/v1/threads', headers: { cookie }, payload: { mode: 'bot', title: 'MCP bot' } })).json();
  assert.equal((await request('PUT', '/mcp/scope', { threadId: thread.id, serverIds: [] })).statusCode, 200);
  assert.deepEqual((await request('POST', '/mcp/catalog', { threadId: thread.id })).json().tools, []);
  assert.equal((await request('PUT', '/mcp/scope', { threadId: thread.id, serverIds: null })).statusCode, 200);
  assert.equal((await request('POST', '/mcp/catalog', { threadId: thread.id })).json().tools.length, 2);
  apiStore.close();

  // Bot loop uses the same bridge and records real MCP results in persisted run steps.
  for (const server of repository.list(owner)) if (server.id !== second.id) repository.save(owner, { ...repository.public(server), enabled: false }, server.id);
  config.save(owner, { ...config.get(owner), providers: [{ id: 'mock', name: 'mock', baseUrl: 'https://model.example', apiKey: 'model-secret', protocol: 'openai-chat', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'mock', model: 'fixture-model' } });
  const threadId = crypto.randomUUID(), runId = crypto.randomUUID(), timestamp = new Date().toISOString();
  store.db.prepare("INSERT INTO threads(id,owner_id,mode,title,created_at,updated_at) VALUES(?,?,'bot','MCP',?,?)").run(threadId, owner, timestamp, timestamp);
  store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,'bot','queued',?)").run(runId, threadId, timestamp);
  let modelCalls = 0;
  bot = new BotRunner(store, { configuration: config, mcp: manager, fetch: async (_url, init) => {
    const body = JSON.parse(init.body); modelCalls++;
    if (modelCalls === 1) {
      const name = body.tools.find(t => t.function.name.startsWith('mcp_') && t.function.description.includes('/ echo]')).function.name;
      return Response.json({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify({ text: 'bot-loop' }) } }] } }] });
    }
    assert.ok(body.messages.some(m => m.role === 'tool' && m.content.includes('fixture:bot-loop')));
    return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'send_message', arguments: JSON.stringify({ kind: 'text', text: 'MCP verified' }) } }] } }] });
  } });
  const beforeBotCall = calls.length;
  bot.start();
  for (let i = 0; i < 100 && store.db.prepare('SELECT status FROM runs WHERE id=?').get(runId).status !== 'waiting_user'; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(runId).status, 'waiting_user');
  assert.equal(calls.length, beforeBotCall, 'external tools must wait for human approval');
  store.db.prepare("UPDATE approvals SET status='approved' WHERE run_id=?").run(runId);
  store.db.prepare("UPDATE runs SET status='queued' WHERE id=?").run(runId);
  bot.enqueue();
  for (let i = 0; i < 100 && store.db.prepare('SELECT status FROM runs WHERE id=?').get(runId).status !== 'completed'; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(runId).status, 'completed');
  assert.match(store.db.prepare("SELECT result FROM run_steps WHERE run_id=? AND tool LIKE 'mcp_%'").get(runId).result, /fixture:bot-loop/);
  await bot.close();
  // Pending approvals never survive rejection, a server edit, or scope revocation.
  for (const scenario of ['reject', 'server-edit', 'scope-revoked']) {
    const pendingRun = crypto.randomUUID();
    let turns = 0;
    store.db.prepare("UPDATE threads SET mcp_server_ids=NULL WHERE id=?").run(threadId);
    store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,'bot','queued',?)").run(pendingRun, threadId, timestamp);
    bot = new BotRunner(store, { configuration: config, mcp: manager, fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (turns++ === 0) {
        const name = body.tools.find(t => t.function.name.startsWith('mcp_') && t.function.description.includes('/ echo]')).function.name;
        return Response.json({ choices: [{ message: { tool_calls: [{ function: { name, arguments: '{"text":"must-not-execute"}' } }] } }] });
      }
      assert.ok(body.messages.some(m => m.role === 'tool' && /denied|unavailable/.test(m.content)));
      return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'send_message', arguments: '{"kind":"text","text":"Stopped"}' } }] } }] });
    } });
    const before = calls.length;
    bot.start();
    for (let i = 0; i < 100 && store.db.prepare('SELECT status FROM runs WHERE id=?').get(pendingRun).status !== 'waiting_user'; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(pendingRun).status, 'waiting_user');
    if (scenario === 'server-edit') {
      repository.save(owner, { ...repository.public(repository.get(owner, second.id)), name: 'Edited after approval request' }, second.id);
      await manager.invalidate(owner, second.id);
    }
    if (scenario === 'scope-revoked') store.db.prepare("UPDATE threads SET mcp_server_ids='[]' WHERE id=?").run(threadId);
    store.db.prepare('UPDATE approvals SET status=? WHERE run_id=?').run(scenario === 'reject' ? 'rejected' : 'approved', pendingRun);
    store.db.prepare("UPDATE runs SET status='queued' WHERE id=?").run(pendingRun);
    bot.enqueue();
    for (let i = 0; i < 100 && store.db.prepare('SELECT status FROM runs WHERE id=?').get(pendingRun).status !== 'completed'; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(pendingRun).status, 'completed');
    assert.equal(calls.length, before, scenario);
    await bot.close();
  }
  const recoveryRun = crypto.randomUUID(), recoveryCall = crypto.randomUUID();
  const pendingTool = { id: recoveryCall, type: 'function', function: { name: a.tools.find(t => t.serverId === second.id).name, arguments: '{"text":"do-not-replay"}' } };
  const savedContext = [{ role: 'system', content: 'Test recovery' }, { role: 'assistant', content: null, tool_calls: [pendingTool] }];
  store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,context_json,step_count,created_at) VALUES(?,?,'bot','running',?,1,?)").run(recoveryRun, threadId, JSON.stringify(savedContext), timestamp);
  store.db.prepare("INSERT INTO run_steps(id,run_id,tool,arguments,status,created_at) VALUES(?,?,?,?,'running',?)").run(recoveryCall, recoveryRun, pendingTool.function.name, pendingTool.function.arguments, timestamp);
  const beforeRecovery = calls.length;
  bot = new BotRunner(store, { configuration: config, mcp: manager, fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.messages.some(m => m.role === 'tool' && m.content.includes('interrupted')));
    return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'send_message', arguments: '{"kind":"text","text":"Recovered without replay"}' } }] } }] });
  } });
  bot.start();
  for (let i = 0; i < 100 && store.db.prepare('SELECT status FROM runs WHERE id=?').get(recoveryRun).status !== 'completed'; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(recoveryRun).status, 'completed');
  assert.equal(calls.length, beforeRecovery, 'unknown MCP side effects must not be replayed after restart');
  assert.equal(store.db.prepare('SELECT status FROM run_steps WHERE id=?').get(recoveryCall).status, 'interrupted');
  console.log('MCP integration passed: transport, pagination, auth, isolation, scopes, worker routes, cancellation, errors, Bot loop.');
} finally {
  await bot?.close(); await app.close(); await manager.close(); store.close();
  remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
