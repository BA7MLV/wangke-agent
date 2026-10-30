import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { McpRepository } from '../apps/api/src/mcp/repository.ts';
import { McpManager } from '../apps/api/src/mcp/manager.ts';
import { SystemMaterials } from '../apps/api/src/storage/system-materials.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-mcp-files-'));
const store = new DatabaseStore(path.join(dir, 'unit.sqlite'));
const config = new CloudConfiguration(store, path.join(dir, 'config'));
const repository = new McpRepository(store, config), files = new SystemMaterials(store);
const manager = new McpManager(repository);
const owner = crypto.randomUUID(), other = crypto.randomUUID(), at = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, id, at);
const resource = '/system/mcp.json';
const physical = path.join(store.systemFiles.root, crypto.createHash('sha256').update(owner).digest('hex'), 'system/mcp.json');
const input = { name: 'Legacy', url: 'https://example.invalid/mcp', transport: 'streamable-http', enabled: false, auth: 'bearer', timeoutMs: 30000, disabledTools: [] };
const id = crypto.randomUUID(), credentials = config.seal(JSON.stringify({ token: 'encrypted-only-secret', headers: {}, env: {} }));
let bot;
try {
  // Upgrade preserves server identity, scope references and encrypted credentials.
  store.db.prepare('INSERT INTO mcp_servers VALUES(?,?,?,?,?)').run(id, owner, JSON.stringify(input), credentials, 'legacy-revision');
  let document = files.read(owner, resource);
  assert.equal(document.kind, 'mcp');
  assert.equal(JSON.parse(document.content).servers[0].id, id);
  assert.equal(fs.readFileSync(physical, 'utf8'), document.content);
  assert.ok(!document.content.includes('encrypted-only-secret'));
  assert.ok(files.list(owner, '/system').files.some(file => file.path === resource));
  assert.deepEqual(JSON.parse(files.read(other, resource).content).servers, []);
  assert.equal(repository.get(owner, id).token, 'encrypted-only-secret');
  assert.equal(store.db.prepare('SELECT credentials FROM mcp_servers WHERE id=?').get(id).credentials, credentials);

  // Visual CRUD and raw file edits use exactly the same authoritative file.
  repository.save(owner, { ...repository.public(repository.get(owner, id)), name: 'Visual edit' }, id);
  document = files.read(owner, resource);
  assert.equal(JSON.parse(document.content).servers[0].name, 'Visual edit');
  const updated = files.save(owner, resource, document.content.replace('Visual edit', 'File edit'), document.content, document.revision);
  const currentServer = repository.get(owner, id);
  assert.throws(() => repository.save(owner, { ...input, name: 'Stale visual edit' }, id, 'stale-revision'), /mcp_config_changed/);
  assert.throws(() => repository.remove(owner, id, 'stale-revision'), /mcp_config_changed/);
  assert.equal(repository.get(owner, id).revision, currentServer.revision);
  assert.equal(repository.list(owner)[0].name, 'File edit');
  assert.equal(repository.get(owner, id).token, 'encrypted-only-secret');
  assert.throws(() => files.save(owner, resource, document.content, document.content, document.revision), /revision_conflict/);
  for (const invalid of ['{', JSON.stringify({ version: 1, servers: [{ ...input, token: 'not-in-file' }] }), JSON.stringify({ version: 1, servers: [{ id, ...input }, { id, ...input }] })]) {
    assert.throws(() => files.save(owner, resource, invalid, updated.content, updated.revision), /mcp_/);
    assert.equal(fs.readFileSync(physical, 'utf8'), updated.content, 'validation failure cannot partially save');
  }
  assert.throws(() => files.save(other, resource, updated.content, files.read(other, resource).content, files.read(other, resource).revision), /mcp_invalid_config/);
  const changed = files.save(owner, resource, updated.content.replace('example.invalid', 'new.example.invalid'), updated.content, updated.revision);
  assert.equal(repository.get(owner, id).token, '', 'credentials never follow an endpoint change');
  const created = repository.save(owner, { ...input, name: 'Second', auth: 'none' });
  assert.equal(JSON.parse(files.read(owner, resource).content).servers.length, 2);
  repository.remove(owner, created.id);
  assert.equal(JSON.parse(files.read(owner, resource).content).servers.length, 1);
  assert.ok(files.read(owner, resource).revision > changed.revision);

  // Direct external changes are authoritative. Invalid files fail closed but stay repairable.
  fs.writeFileSync(physical, '{ broken');
  document = files.read(owner, resource);
  assert.equal(document.status, 'invalid');
  assert.equal(document.content, '{ broken');
  assert.throws(() => repository.list(owner), /mcp_invalid_json/);
  assert.deepEqual(await manager.catalog(owner), { tools: [], warnings: ['mcp_invalid_json'] }, 'invalid MCP configuration must not block basic Bot tools');
  document = files.save(owner, resource, JSON.stringify({ version: 1, servers: [{ name: 'Fresh', url: input.url }] }), document.content, document.revision);
  const fresh = repository.list(owner)[0];
  assert.equal(fresh.name, 'Fresh'); assert.equal(fresh.enabled, false);
  assert.equal(JSON.parse(document.content).servers[0].id, fresh.id);
  fs.unlinkSync(physical);
  assert.deepEqual(repository.list(owner), []);
  assert.equal(fs.existsSync(physical), false, 'deletion must not resurrect DB configuration');
  document = files.read(owner, resource);
  assert.equal(document.status, 'missing');
  document = files.save(owner, resource, JSON.stringify({ version: 1, servers: [{ ...input, name: 'Bot target', auth: 'none' }] }), '', document.revision);
  assert.ok(fs.existsSync(physical));
  const beforeRollback = document;
  assert.throws(() => store.transaction(() => {
    files.save(owner, resource, beforeRollback.content.replace('Bot target', 'Rolled back'), beforeRollback.content, beforeRollback.revision);
    throw new Error('intentional_rollback');
  }), /intentional_rollback/);
  assert.equal(fs.readFileSync(physical, 'utf8'), beforeRollback.content);
  assert.equal(files.read(owner, resource).revision, beforeRollback.revision);
  console.log('MCP files: migration, two-way CRUD, secrets, CAS, validation, defaults, isolation, external edits/deletion and explicit recovery passed');

  // Owner system reads/edits need no approval, while CAS and denials still apply.
  config.save(owner, { ...config.get(owner), providers: [{ id: 'mock', name: 'Mock', baseUrl: 'https://model.invalid', apiKey: 'model-secret', protocol: 'openai-chat', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'mock', model: 'test' }, policy: { ...config.get(owner).policy, read: 'allow', write: 'allow' } });
  const study = new StudyTools(store, config, dir);
  const edit = study.plugins.get('edit');
  assert.equal(edit.systemResource, true);
  assert.equal(edit.requiresApproval?.({ path: resource }) ?? false, false);
  const thread = crypto.randomUUID();
  store.db.prepare("INSERT INTO threads(id,owner_id,mode,title,created_at,updated_at) VALUES(?,?,'bot','MCP editing',?,?)").run(thread, owner, at, at);
  const context = { owner, thread, run: 'not-approved', step: 'not-approved', signal: new AbortController().signal, checkActive() {}, append() {} };
  await edit.execute({ path: resource, revision: document.revision, edits: [{ old_string: 'Bot target', new_string: 'No approval needed' }] }, context);
  assert.match(files.read(owner, resource).content, /No approval needed/);
  const listing = await study.plugins.get('read').execute({ path: '/system' }, context);
  assert.ok(listing.files.some(file => file.path === resource));
  const grep = await study.plugins.get('grep').execute({ path: resource, query: 'No approval needed' }, context);
  assert.match(JSON.stringify(grep), /No approval needed/);

  for (const scenario of ['automatic', 'stale', 'denied']) {
    config.save(owner, { ...config.get(owner), policy: { ...config.get(owner).policy, read: 'ask', write: 'ask' } });
    const run = crypto.randomUUID(), before = files.read(owner, resource);
    const original = JSON.parse(before.content).servers[0].name, replacement = `Bot ${scenario}`;
    let turn = 0;
    store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,'bot','queued',?)").run(run, thread, at);
    bot = new BotRunner(store, { configuration: config, study, fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      const call = (name, args) => Response.json({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }] });
      if (turn++ === 0) {
        assert.ok(request.tools.some(tool => tool.function.name === 'read'));
        return call('read', { path: resource });
      }
      if (turn === 2) {
        assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes('"kind":"mcp"')));
        if (scenario === 'stale') repository.save(owner, { ...repository.public(repository.list(owner)[0]), name: 'Concurrent edit' }, repository.list(owner)[0].id);
        if (scenario === 'denied') config.save(owner, { ...config.get(owner), policy: { ...config.get(owner).policy, write: 'deny' } });
        return call('edit', { path: resource, revision: before.revision, edits: [{ old_string: original, new_string: replacement }] });
      }
      const result = request.messages.filter(message => message.role === 'tool').at(-1).content;
      assert.match(result, scenario === 'automatic' ? /"saved":true/ : scenario === 'stale' ? /revision_conflict/ : /denied/i);
      return call('send_message', { kind: 'text', text: `Verified ${scenario}` });
    } });
    const status = () => store.db.prepare('SELECT status FROM runs WHERE id=?').get(run).status;
    const wait = async target => { for (let i = 0; i < 200 && status() !== target; i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(status(), target); };
    bot.start();
    await wait('completed');
    assert.equal(store.db.prepare('SELECT 1 FROM approvals WHERE run_id=?').get(run), undefined);
    assert.equal(repository.list(owner)[0].name, scenario === 'automatic' ? replacement : scenario === 'stale' ? 'Concurrent edit' : original);
    await bot.close(); bot = undefined;
  }
  console.log('Bot MCP editing: autonomous read/grep/edit despite ask policies, concurrent changes and live policy denials passed');
} finally {
  await bot?.close(); await manager.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
}
