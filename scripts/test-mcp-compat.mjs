import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { McpRepository } from '../apps/api/src/mcp/repository.ts';
import { McpManager } from '../apps/api/src/mcp/manager.ts';
import { parseSkillMarkdown, serializeSkillMarkdown } from '../src/skills/types.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-compat-'));
const store = new DatabaseStore(path.join(dir, 'db.sqlite'));
const owner = crypto.randomUUID();
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, 'test', new Date().toISOString());
const repo = new McpRepository(store, new CloudConfiguration(store, path.join(dir, 'config')));
const manager = new McpManager(repo);
const streams = new Map();
let base = '', challenge = '', expire = false, refreshes = 0;
const fixture = http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: `${base}/protected`, authorization_servers: [base] });
  if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, revocation_endpoint: `${base}/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
  let body = ''; if (req.method === 'POST') for await (const chunk of req) body += chunk;
  if (url.pathname === '/register') return json({ ...JSON.parse(body), client_id: 'fixture-client' });
  if (url.pathname === '/token') {
    const params = new URLSearchParams(body);
    if (params.get('grant_type') === 'refresh_token') { assert.equal(params.get('refresh_token'), 'refresh-1'); refreshes++; }
    else { assert.equal(params.get('code'), 'valid-code'); assert.equal(crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge); }
    return json({ access_token: refreshes ? 'access-2' : 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600 });
  }
  if (url.pathname === '/revoke') return json({});
  if (url.pathname === '/protected' && (!req.headers.authorization || (expire && req.headers.authorization !== 'Bearer access-2'))) {
    res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }); res.end(); return;
  }
  if (url.pathname === '/sse' && req.method === 'GET') {
    const id = crypto.randomUUID(); streams.set(id, res); res.on('close', () => streams.delete(id));
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`event: endpoint\ndata: /messages?id=${id}\n\n`); return;
  }
  if (url.pathname === '/sse-hang' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': no endpoint\n\n'); return;
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  const rpc = JSON.parse(body);
  if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
  let result;
  if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'compat', version: '1' } };
  else if (rpc.method === 'tools/list') result = { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] };
  else if (rpc.method === 'tools/call') result = { content: [{ type: 'text', text: 'compat-ok' }] };
  else if (rpc.method === 'resources/list') result = { resources: [{ uri: 'study://fact', name: 'Fact' }] };
  else if (rpc.method === 'resources/templates/list') result = { resourceTemplates: [{ uriTemplate: 'study://{topic}', name: 'Study topic' }] };
  else if (rpc.method === 'resources/read') result = { contents: [{ uri: 'study://fact', text: 'spaced repetition' }] };
  else if (rpc.method === 'prompts/list') result = { prompts: [{ name: 'explain', arguments: [{ name: 'topic', required: true }] }] };
  else if (rpc.method === 'prompts/get') result = { messages: [{ role: 'user', content: { type: 'text', text: `Explain ${rpc.params.arguments.topic}` } }] };
  const response = { jsonrpc: '2.0', id: rpc.id, result };
  if (url.pathname === '/messages') { streams.get(url.searchParams.get('id'))?.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`); res.writeHead(202); res.end(); }
  else json(response);
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${fixture.address().port}`;
const input = (name, transport = 'streamable-http') => ({ name, transport, url: `${base}/mcp`, auth: 'none', enabled: true, timeoutMs: 5000, disabledTools: [] });
try {
  const imported = repo.import(owner, { mcpServers: { remote: { url: `${base}/mcp` }, legacy: { type: 'sse', url: `${base}/sse` }, local: { command: process.execPath, args: [path.resolve('scripts/fixtures/mcp-stdio.mjs')], env: { MCP_TEST_SECRET: 'secret-value' } } } });
  assert.equal(imported.length, 3); assert.equal(imported[2].env, undefined);
  assert.throws(() => repo.import(owner, { mcpServers: { remote: { url: `${base}/mcp` } } }), /duplicate/);
  assert.throws(() => repo.import(owner, { mcpServers: { valid: { url: `${base}/mcp` }, bad: { url: 'file:///a' } } }), /invalid_url/);
  assert.equal(repo.list(owner).length, 3, 'imports roll back atomically');
  assert.throws(() => repo.import(owner, { mcpServers: { variable: { command: '${env:COMMAND}' } } }), /variables/);
  assert.throws(() => repo.previewImport(owner, { servers: { invalid: { type: 'unknown', url: `${base}/mcp` } } }), /invalid_config/);
  assert.throws(() => repo.previewImport(owner, { servers: { invalid: { command: 'node', disabled: 'false' } } }), /invalid_import/);
  assert.throws(() => repo.import(owner, { mcpServers: { ' remote ': { url: `${base}/mcp` } } }), /duplicate/);
  assert.throws(() => repo.import(owner, { mcpServers: { normalized: { url: `${base}/mcp` }, ' normalized ': { url: `${base}/mcp` } } }), /duplicate/);
  const stdio = imported[2];
  const first = await manager.test(owner, stdio.id);
  const pid = manager.list(owner).find(s => s.id === stdio.id).pid;
  assert.ok(pid); assert.match((await manager.call(owner, first.tools[0].name, {})).text, /stdio:/);
  assert.ok(!manager.log(owner, stdio.id).includes('secret-value'));
  assert.match(manager.log(owner, stdio.id), /redacted/);
  repo.save(owner, { ...repo.public(repo.get(owner, stdio.id)), env: { MCP_TEST_SECRET: 'new-value' } }, stdio.id);
  assert.ok(!manager.log(owner, stdio.id).includes('secret-value'), 'logs retain the redaction values of their original process');
  await manager.invalidate(owner, stdio.id);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const legacy = repo.save(owner, { ...imported[1], timeoutMs: 1000 }, imported[1].id);
  const sse = await manager.test(owner, legacy.id);
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(streams.size, 1, 'the live SSE stream must outlast the request timeout');
  assert.match((await manager.call(owner, sse.tools.find(t => !t.kind).name, {}, [legacy.id])).text, /compat-ok/);
  const gateway = sse.tools.find(t => t.kind === 'gateway');
  assert.match((await manager.call(owner, gateway.name, { action: 'resources' }, [legacy.id])).text, /study:\/\/fact/);
  assert.match((await manager.call(owner, gateway.name, { action: 'resource', uri: 'study://fact' }, [legacy.id])).text, /spaced repetition/);
  assert.match((await manager.call(owner, gateway.name, { action: 'resource_templates' }, [legacy.id])).text, /uriTemplate/);
  assert.match((await manager.call(owner, gateway.name, { action: 'prompts' }, [legacy.id])).text, /explain/);
  assert.match((await manager.call(owner, gateway.name, { action: 'prompt', name: 'explain', arguments: { topic: 'math' } }, [legacy.id])).text, /Explain math/);
  const hanging = repo.save(owner, { ...input('Hanging SSE', 'sse'), url: `${base}/sse-hang`, timeoutMs: 1000 });
  await assert.rejects(manager.test(owner, hanging.id));
  const oauth = repo.save(owner, { ...input('OAuth'), auth: 'oauth', url: `${base}/protected` });
  await assert.rejects(manager.test(owner, oauth.id), /oauth_required/);
  const provider = manager.oauth(owner, oauth.id, true);
  const begin = await provider.begin(`${base}/protected`, `${base}/callback`);
  const authorization = new URL(begin.authorizationUrl);
  challenge = authorization.searchParams.get('code_challenge'); assert.ok(challenge);
  const state = authorization.searchParams.get('state');
  await assert.rejects(manager.oauth(owner, oauth.id).complete(`${base}/protected`, 'wrong', 'valid-code'), /state/);
  await manager.oauth(owner, oauth.id).complete(`${base}/protected`, state, 'valid-code');
  await assert.rejects(manager.oauth(owner, oauth.id).complete(`${base}/protected`, state, 'valid-code'), /state/);
  assert.equal(repo.public(repo.get(owner, oauth.id)).oauthAuthorized, true);
  assert.equal(repo.public(repo.get(owner, oauth.id)).oauth, undefined);
  assert.ok(!store.db.prepare('SELECT credentials FROM mcp_servers WHERE id=?').get(oauth.id).credentials.includes('access-1'));
  const oauthTools = await manager.test(owner, oauth.id);
  expire = true;
  assert.match((await manager.call(owner, oauthTools.tools[0].name, {}, [oauth.id])).text, /compat-ok/);
  assert.equal(refreshes, 1);
  await manager.invalidate(owner, oauth.id);
  assert.equal((await manager.oauth(owner, oauth.id).disconnect()).revoked, true);
  assert.equal(repo.get(owner, oauth.id).oauthAuthorized, false);
  assert.throws(() => provider.saveTokens({ access_token: 'stale', token_type: 'Bearer' }), /config_changed/);
  const denied = await manager.oauth(owner, oauth.id, true).begin(`${base}/protected`, `${base}/callback`);
  await assert.rejects(manager.oauth(owner, oauth.id).complete(`${base}/protected`, new URL(denied.authorizationUrl).searchParams.get('state')), /denied/);
  assert.equal(repo.get(owner, oauth.id).oauth.verifier, undefined);
  const expired = await manager.oauth(owner, oauth.id, true).begin(`${base}/protected`, `${base}/callback`);
  repo.updateOAuth(owner, oauth.id, repo.get(owner, oauth.id).revision, d => ({ ...d, pending: { ...d.pending, expires: Date.now() - 1 } }));
  await assert.rejects(manager.oauth(owner, oauth.id).complete(`${base}/protected`, new URL(expired.authorizationUrl).searchParams.get('state'), 'valid-code'), /state/);
  const skill = parseSkillMarkdown('test.md', '---\nname: test\nrequires-mcp: ["remote"]\n---\nUse MCP');
  assert.deepEqual(parseSkillMarkdown('test.md', serializeSkillMarkdown(skill)), skill);
  // Public authorization routes: real callback, one-use state, credential-free DTOs.
  process.env.NODE_ENV = 'test'; process.env.DATA_DIR = path.join(dir, 'api');
  process.env.BOOTSTRAP_SECRET_FILE = path.join(dir, 'api/config/bootstrap-secret');
  process.env.CLOUD_WORKER_DISABLED = '1'; delete process.env.MODEL_API_KEY;
  const { buildServer } = await import('../apps/api/src/server.ts');
  const app = buildServer({ dbPath: path.join(dir, 'api.sqlite'), staticDir: path.join(dir, 'none') });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    process.env.MCP_PUBLIC_ORIGIN = `http://127.0.0.1:${app.server.address().port}`;
    const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
    await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: 'mcp-compat-password-123' } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'mcp-compat-password-123' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const api = (method, suffix, payload) => app.inject({ method, url: '/api/v1/cloud/mcp' + suffix, headers: { cookie }, payload });
    const preview = await api('POST', '/import/preview', { servers: { imported: { type: 'http', url: `${base}/mcp`, headers: { 'X-API-Key': 'hidden' } } } });
    assert.equal(preview.statusCode, 200); assert.ok(!preview.body.includes('hidden'));
    const created = (await api('POST', '', { ...input('API OAuth'), auth: 'oauth', url: `${base}/protected` })).json();
    const start = await api('POST', `/${created.id}/oauth/start`); assert.equal(start.statusCode, 200, start.body);
    const authorization = new URL(start.json().authorizationUrl); challenge = authorization.searchParams.get('code_challenge');
    const callback = new URL(authorization.searchParams.get('redirect_uri')); callback.searchParams.set('state', authorization.searchParams.get('state')); callback.searchParams.set('code', 'valid-code');
    const completed = await app.inject({ method: 'GET', url: callback.pathname + callback.search });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal((await app.inject({ method: 'GET', url: callback.pathname + callback.search })).statusCode, 400);
    assert.ok(!(await api('GET', '')).body.includes('access-'));
    assert.equal((await api('POST', `/${created.id}/oauth/disconnect`)).statusCode, 200);
  } finally { await app.close(); }
  console.log('MCP compatibility passed: atomic imports, stdio lifecycle/log redaction, SSE, resources/prompts, OAuth PKCE/state/replay/refresh/disconnect, skill dependencies.');
} finally {
  await manager.close(); for (const res of streams.values()) res.end();
  fixture.closeAllConnections(); await new Promise(r => fixture.close(r)); store.close(); fs.rmSync(dir, { recursive: true, force: true });
}
