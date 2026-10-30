import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { McpRepository } from '../apps/api/src/mcp/repository.ts';
import { McpManager } from '../apps/api/src/mcp/manager.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { GatewayCore } from '../apps/api/src/gateway/core.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-migrations-'));
const source = ref => execFileSync('git', ['show', `${ref}:apps/api/src/storage/database.ts`], { encoding: 'utf8' });
const migrations = text => [...text.matchAll(/\[(\d+), `([\s\S]*?)`\]/g)].map(m => [Number(m[1]), m[2]]);
const owner = 'owner', other = 'other', at = new Date().toISOString();
const unhandled = [], rejected = error => unhandled.push(error);
process.on('unhandledRejection', rejected);
const calls = [];
// Only loopback HTTP is real: authentication, MCP initialization/discovery and
// tools/call go through the normal SDK transport. No platform or model network.
const remote = http.createServer(async (req, res) => {
  try {
    const name = req.url.slice(1);
    if (req.headers.authorization !== `Bearer mcp-secret-${name}`) { res.writeHead(401); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const rpc = JSON.parse(text);
    if (!('id' in rpc)) { res.writeHead(202); res.end(); return; }
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'migration-fixture', version: '1' } };
    else if (rpc.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Owned migration evidence', inputSchema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] } }] };
    else if (rpc.method === 'tools/call') {
      assert.equal(rpc.params.name, 'echo');
      calls.push({ name, text: rpc.params.arguments.text });
      result = { content: [{ type: 'text', text: `fixture:${rpc.params.arguments.text}` }] };
    } else throw new Error('unexpected_fixture_rpc');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${remote.address().port}`;
const mcpInput = name => ({ name: 'Migration MCP', url: `${base}/${name}`, transport: 'streamable-http', enabled: true, auth: 'bearer', token: `mcp-secret-${name}`, timeoutMs: 3000, disabledTools: [] });
const wrapper = db => ({ db, transaction: fn => db.transaction(fn)() });
function seedCommon(db, config, name) {
  for (const id of [owner, other]) db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, id, at);
  for (const id of ['thread', 'legacy-im-thread']) db.prepare('INSERT INTO threads(id,mode,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, 'bot', owner, at, at);
  db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('bot', owner, 'Bot', 'study', '', at, at);
  db.prepare('INSERT INTO messages(id,thread_id,client_nonce,seq,role,kind,content,created_at) VALUES(?,?,?,?,?,?,?,?)').run('old-message', 'thread', 'old-nonce', 1, 'assistant', 'approval', 'Retained approval', at);
  const oldImMessage = { id: 'old-im-message', threadId: 'legacy-im-thread', seq: 1, role: 'assistant', kind: 'text', content: 'Legacy projected reply', createdAt: at };
  db.prepare('INSERT INTO messages(id,thread_id,seq,role,kind,content,created_at) VALUES(?,?,?,?,?,?,?)').run(oldImMessage.id, oldImMessage.threadId, 1, oldImMessage.role, oldImMessage.kind, oldImMessage.content, at);
  db.prepare("INSERT INTO message_events(event_id,id,thread_id,seq,type,payload,created_at) VALUES(37,'old-event','legacy-im-thread',1,'message.accepted',?,?)").run(JSON.stringify(oldImMessage), at);
  db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at,context_json,step_count,wake_at) VALUES('old-run','thread','bot','waiting_user',?,?,4,?)").run(at, JSON.stringify([{ role: 'system', content: 'Retained checkpoint' }]), '2099-01-01T00:00:00.000Z');
  db.prepare("INSERT INTO run_steps(id,run_id,tool,arguments,status,created_at) VALUES('old-step','old-run','shell',?,'waiting_approval',?)").run('{"command":"echo legacy","network":false}', at);
  db.prepare("INSERT INTO approvals(id,thread_id,message_id,run_id,step_id,status,created_at) VALUES('old-approval','thread','old-message','old-run','old-step','pending',?)").run(at);
  db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES('old-task',?,'old-task-nonce','cards','course:legacy',?,'queued','node',?,?)").run(owner, '{"videoId":"legacy"}', at, at);
  config.save(owner, { ...config.get(owner, true), providers: [{ id: 'fake', name: 'Isolated model', baseUrl: 'https://migration.invalid/v1', protocol: 'openai-chat', apiKey: `model-secret-${name}`, catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'fake', model: 'fake' } });
}
function seedGateway(db, config, name) {
  db.prepare('INSERT INTO gateway_accounts(id,owner_id,channel,agent_id,enabled,config,cursor,created_at) VALUES(?,?,?,?,1,?,?,?)').run('account', owner, 'fake', 'bot', config.seal(JSON.stringify({ channelToken: `channel-secret-${name}` })), 'cursor-99', at);
  // A revoked legacy binding retains an inspectable pending outbox head without
  // authorizing it to deliver. The post-upgrade chain pairs a new owned peer.
  db.prepare("INSERT INTO gateway_bindings(id,account_id,tenant,peer,chat,topic,thread_id,context,revoked,checkpoint) VALUES('old-binding','account','','legacy-peer','legacy-chat','','legacy-im-thread',?,1,37)").run(config.seal('legacy-context'));
  db.prepare("INSERT INTO gateway_inbox(account_id,external_id,envelope,status,error) VALUES('account','legacy-external',?,'failed','legacy-inspectable')").run(config.seal(JSON.stringify({ messageId: 'legacy', text: 'retained private inbound', direct: true, human: true, tenant: '', peer: 'legacy-peer', chat: 'legacy-chat', topic: '' })));
  db.prepare("INSERT INTO gateway_outbox(id,binding_id,payload,status,attempts,next_at,created_at,error) VALUES('old-outbox','old-binding',?,'pending',2,?,?, 'legacy-retry')").run('{"text":"Retained queued delivery"}', Date.parse('2099-01-01'), Date.now());
}
// Compare the original columns and records, not just table existence. Added
// columns are allowed; encrypted bytes, FKs, statuses and queues must survive.
function snapshot(db) {
  const targets = { users: '1=1', threads: "id IN ('thread','legacy-im-thread','project-thread')", projects: '1=1', project_agents: '1=1', messages: "id IN ('old-message','old-im-message')", message_events: "id='old-event'", runs: "id='old-run'", run_steps: "id='old-step'", approvals: "id='old-approval'", cloud_tasks: "id='old-task'", cloud_config: "owner_id='owner'", mcp_servers: '1=1', gateway_accounts: "id='account'", gateway_bindings: "id='old-binding'", gateway_inbox: "external_id='legacy-external'", gateway_outbox: "id='old-outbox'" };
  return Object.entries(targets).flatMap(([table, where]) => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).filter(c => !(table === 'gateway_accounts' && c === 'health'));
    return [{ table, where, columns, rows: db.prepare(`SELECT ${columns.join(',')} FROM ${table} WHERE ${where} ORDER BY rowid`).all() }];
  });
}
function preserved(db, expected) {
  for (const { table, where, columns, rows } of expected) assert.deepEqual(db.prepare(`SELECT ${columns.join(',')} FROM ${table} WHERE ${where} ORDER BY rowid`).all(), rows, `${table}: original records/columns preserved`);
}
async function until(check) { for (let n = 0; n < 600; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('migration_chain_timeout'); }
const toolResponse = (name, args) => Response.json({ choices: [{ message: { tool_calls: [{ id: `fixture-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 40, completion_tokens: 20 } });

try {
  for (const [name, ref, maximum] of [['empty', null, 0], ['v12', 'c82feb6', 12], ['mcp13', '221d397', 13], ['main14', 'bc360b8', 14], ['main15', 'bc360b8', 15], ['gateway13', 'c82feb6', 13], ['gateway14', 'c82feb6', 14]]) {
    const filename = path.join(root, `${name}.sqlite`), configDir = path.join(root, name, 'config');
    let expected = [], keyBefore, mcpId;
    if (ref) {
      const db = new Database(filename);
      try {
        db.pragma('foreign_keys = ON');
        db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
        for (const [version, sql] of migrations(source(ref))) if (version <= maximum) {
          db.exec(sql); db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(version, at);
        }
        const config = new CloudConfiguration(wrapper(db), configDir);
        seedCommon(db, config, name);
        if (name === 'mcp13' || name.startsWith('main')) {
          // Seed the historical database layout, not today's file-backed repository.
          const { token, ...server } = mcpInput(name);
          mcpId = crypto.randomUUID();
          db.prepare('INSERT INTO mcp_servers VALUES(?,?,?,?,?)').run(mcpId, owner, JSON.stringify(server), config.seal(JSON.stringify({ token, headers: {}, env: {} })), crypto.randomUUID());
        }
        if (name.startsWith('main')) {
          db.prepare("INSERT INTO projects(id,owner_id,name,instructions,created_at,updated_at) VALUES('old-project',?,'Retained project','Keep workspace isolation',?,?)").run(owner, at, at);
          db.prepare("INSERT INTO project_agents VALUES('old-project','bot','manage')").run();
          db.prepare("INSERT INTO threads(id,owner_id,mode,project_id,agent_id,created_at,updated_at) VALUES('project-thread',?,'bot','old-project','bot',?,?)").run(owner, at, at);
          if (maximum >= 15) db.prepare("UPDATE cloud_tasks SET worker_id='old-worker',lease_expires_at='2099-01-01T00:00:00.000Z' WHERE id='old-task'").run();
        }
        if (name.startsWith('gateway')) seedGateway(db, config, name);
        expected = snapshot(db);
        keyBefore = fs.readFileSync(path.join(configDir, 'credentials.key'));
      } finally { db.close(); }
    }
    for (let restart = 0; restart < 2; restart++) {
      const store = new DatabaseStore(filename, path.join(root, name, 'system-files'));
      let manager, runner, gateway;
      try {
        assert.equal(store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 24);
        assert.deepEqual(store.db.pragma('foreign_key_check'), []);
        preserved(store.db, expected);
        const config = new CloudConfiguration(store, configDir);
        if (!ref && restart === 0) seedCommon(store.db, config, name);
        const key = fs.readFileSync(path.join(configDir, 'credentials.key'));
        if (keyBefore) assert.deepEqual(key, keyBefore, 'original encryption key is unchanged'); else keyBefore = key;
        assert.equal(config.get(owner, true).providers[0].apiKey, `model-secret-${name}`, 'real CloudConfiguration decryption after upgrade');
        const encryptedModel = store.db.prepare('SELECT value FROM cloud_config WHERE owner_id=?').get(owner).value;
        assert.ok(!encryptedModel.includes(`model-secret-${name}`));
        const wrongKey = new CloudConfiguration(store, path.join(root, name, `wrong-key-${restart}`));
        assert.throws(() => wrongKey.open(encryptedModel), 'fixture genuinely requires its original AES-GCM key');
        const repository = new McpRepository(store, config);
        if (!mcpId) mcpId = repository.save(owner, mcpInput(name)).id;
        assert.equal(repository.get(owner, mcpId).token, `mcp-secret-${name}`);
        assert.equal(repository.get(other, mcpId), undefined);
        if (!store.db.prepare("SELECT 1 FROM gateway_accounts WHERE id='account'").get()) seedGateway(store.db, config, name);
        assert.equal(JSON.parse(config.open(store.db.prepare("SELECT config FROM gateway_accounts WHERE id='account'").get().config)).channelToken, `channel-secret-${name}`);
        assert.equal(config.open(store.db.prepare("SELECT context FROM gateway_bindings WHERE id='old-binding'").get().context), 'legacy-context');
        assert.equal(JSON.parse(config.open(store.db.prepare("SELECT envelope FROM gateway_inbox WHERE external_id='legacy-external'").get().envelope)).text, 'retained private inbound');
        // First-upgrade installations of missing subsystems become part of the
        // second-start preservation check too. Existing legacy rows stay exact.
        expected = snapshot(store.db);
        manager = new McpManager(repository);
        const catalog = await manager.catalog(owner, [mcpId]);
        assert.deepEqual(catalog.warnings, []); assert.equal(catalog.tools.length, 1);
        const echo = catalog.tools[0];
        const directText = `owned:${name}:${restart}`;
        assert.match((await manager.call(owner, echo.name, { text: directText }, [mcpId])).text, new RegExp(`fixture:${directText}`));
        await assert.rejects(manager.call(other, echo.name, { text: 'forbidden' }), /unavailable/);
        assert.ok(!calls.some(call => call.text === 'forbidden'));
        const delivered = [], chainText = `im:${name}:${restart}`, finalText = `Migration verified ${name}/${restart}`;
        let modelRequests = 0, starts = 0;
        runner = new BotRunner(store, { configuration: config, mcp: manager, fetch: async (url, init) => {
          assert.equal(String(url), 'https://migration.invalid/v1/chat/completions', 'fake model only');
          assert.equal(new Headers(init.headers).get('authorization'), `Bearer model-secret-${name}`);
          modelRequests++;
          const payload = JSON.parse(init.body);
          const current = payload.messages.findLastIndex(message => message.role === 'user' && message.content === chainText);
          const result = payload.messages.slice(current + 1).findLast(message => message.role === 'tool');
          if (!result) {
            assert.ok(payload.tools.some(tool => tool.function.name === echo.name));
            return toolResponse(echo.name, { text: chainText });
          }
          assert.ok(result.content.includes(`fixture:${chainText}`), 'MCP evidence returned through the real Bot tool loop');
          return toolResponse('send_message', { kind: 'text', text: finalText });
        } });
        const bot = new BotApplicationService(store, runner);
        gateway = new GatewayCore(store, config, bot, { fake: () => ({
          manifest: { id: 'fake', version: 1, name: 'Migration fake IM', configFields: [{ key: 'channelToken', label: 'Fixture token', secret: true }], capabilities: { direct: true, groups: false, images: false, files: false, proactive: 'yes', deduplicationWindowMs: 0 } },
          validate() {}, async start(value, context) { starts++; assert.equal(value.channelToken, `channel-secret-${name}`); assert.equal(context.cursor(), 'cursor-99'); }, async stop() {},
          async send(value, _destination, payload, id) { assert.equal(value.channelToken, `channel-secret-${name}`); delivered.push(payload.text); return `fake:${id}`; },
        }) }, path.join(root, name));
        gateway.start(false); runner.start();
        const envelope = text => ({ messageId: `${restart}:${text}`, tenant: '', peer: 'post-upgrade-peer', chat: 'post-upgrade-chat', topic: '', direct: true, human: true, text });
        gateway.receive('account', [envelope(gateway.pair(owner, 'account').command)]); await gateway.tick();
        const binding = store.db.prepare("SELECT * FROM gateway_bindings WHERE account_id='account' AND peer='post-upgrade-peer'").get();
        assert.ok(binding && !binding.revoked);
         gateway.receive('account', [envelope(chainText)]); await gateway.tick();
         await until(() => store.db.prepare("SELECT 1 FROM runs WHERE thread_id=? AND status='waiting_user'").get(binding.thread_id));
         assert.equal(calls.filter(call => call.name === name && call.text === chainText).length, 0, 'external effects wait for exact approval');
         const approval = store.db.prepare("SELECT id FROM approvals WHERE thread_id=? AND status='pending'").get(binding.thread_id);
         assert.ok(approval);
         gateway.receive('account', [envelope(`/approve ${approval.id}`)]); await gateway.tick();
         await until(() => store.db.prepare('SELECT status FROM runs WHERE thread_id=? ORDER BY created_at DESC LIMIT 1').get(binding.thread_id)?.status === 'completed');
        await until(async () => { await gateway.tick(); return delivered.includes(finalText); });
        assert.ok(delivered.includes(finalText), 'fake IM -> Bot -> owned MCP call -> durable reply -> fake IM');
        assert.equal(modelRequests, 2); assert.equal(starts, 1);
        assert.equal(calls.filter(call => call.name === name && call.text === directText).length, 1);
        assert.equal(calls.filter(call => call.name === name && call.text === chainText).length, 1);
        assert.equal(store.db.prepare("SELECT cursor FROM gateway_accounts WHERE id='account'").get().cursor, 'cursor-99');
        preserved(store.db, expected);
        assert.deepEqual(store.db.pragma('foreign_key_check'), []);
      } finally { await runner?.close(); await gateway?.close(); await manager?.close(); store.close(); }
    }
    console.log(`Migration ${name}: two startups; original-key decrypt, run/approval/queue/cursor preservation, owned MCP HTTP and IM -> Bot -> MCP -> IM passed${ref ? '' : ' (fresh install fixtures seeded after migration)'}`);
  }
  const broken = path.join(root, 'broken.sqlite');
  const store = new DatabaseStore(broken); store.db.exec('DROP TABLE mcp_servers'); store.close();
  assert.throws(() => new DatabaseStore(broken), /schema_layout_partial/);
  assert.deepEqual(unhandled, []);
  console.log('Partial schema rejected without migration replay');
} finally {
  remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve));
  process.off('unhandledRejection', rejected);
  fs.rmSync(root, { recursive: true, force: true });
}
