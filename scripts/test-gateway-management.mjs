import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { GatewayCore } from '../apps/api/src/gateway/core.ts';
import { registerGatewayRoutes } from '../apps/api/src/gateway/routes.ts';
import { IlinkPlugin } from '../apps/api/src/gateway/adapters/ilink.ts';
import { FeishuPlugin } from '../apps/api/src/gateway/adapters/feishu.ts';

const at = () => new Date().toISOString();
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const message = (id, text = 'hello', patch = {}) => ({ messageId: id, tenant: 'tenant', peer: 'same-peer', chat: 'same-chat', topic: '', direct: true, human: true, text, context: 'private-context', ...patch });
const input = (botId, extra = {}) => ({ channel: 'ilink', agentId: 'owner-agent', enabled: true, config: { botId, botToken: `secret-${botId}` }, ...extra });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-management-'));
  const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const secrets = new CloudConfiguration(store, path.join(directory, 'config'));
  for (const owner of ['owner', 'other']) {
    store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, at());
    store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(`${owner}-agent`, owner, owner, 'study', 'Study', at(), at());
    secrets.save(owner, { ...secrets.get(owner, true), providers: [], llmModel: { providerId: '', model: '' } });
  }
  const contexts = new Map(), hooks = new Map(), sent = [];
  const bot = new BotApplicationService(store, { enqueue() {}, cancel() {} });
  const factory = channel => account => ({
    manifest: channel === 'ilink' ? new IlinkPlugin(async () => {}).manifest : new FeishuPlugin(async () => {}).manifest,
    validate() {},
    async start(_config, context) { contexts.set(account.id, context); context.health('connected'); },
    async stop() { await hooks.get(account?.id)?.stop?.(); },
    async send(_config, peer, payload, id, signal) { sent.push({ account: account.id, peer, payload, id }); return await hooks.get(account.id)?.send?.(signal) ?? `sent-${id}`; },
    async download(_config, _message, _attachment, signal) { return hooks.get(account.id).download(signal); },
    async login(_config, _action, signal) { return hooks.get(account.id).login(signal); },
  });
  const gateway = new GatewayCore(store, secrets, bot, { ilink: factory('ilink'), feishu: factory('feishu') }, path.join(directory, 'files'));
  t.after(async () => { await gateway.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const bind = async id => {
    gateway.receive(id, [message('pair', gateway.pair('owner', id).command)]); await gateway.tick();
    return store.db.prepare('SELECT * FROM gateway_bindings WHERE account_id=?').get(id);
  };
  return { store, secrets, bot, gateway, contexts, hooks, sent, bind };
}

test('readiness distinguishes transport, owner binding, model, Bot and actionable failures', async t => {
  const { gateway, store, secrets, bot, bind } = fixture(t);
  const { id } = await gateway.save('owner', input('first'));
  const readiness = () => gateway.list('owner')[0].readiness;
  assert.equal(readiness().state, 'binding_required');
  gateway.receive(id, [message('unlinked')]); await gateway.tick();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 0);
  assert.equal(store.db.prepare('SELECT error FROM gateway_inbox').get().error, 'binding_required');
  assert.ok(readiness().lastInboundAt);
  const binding = await bind(id);
  assert.equal(readiness().state, 'model_required');
  secrets.save('owner', { ...secrets.get('owner', true), providers: [{ id: 'model', name: 'Local model', baseUrl: 'http://localhost:1234/v1', apiKey: '', protocol: 'openai-chat', serves: ['chat'] }], llmModel: { providerId: 'model', model: 'test' } });
  assert.equal(readiness().state, 'ready', 'local providers may have no API key; this is configuration readiness, not a network test');
  store.db.prepare('UPDATE agent_profiles SET enabled=0 WHERE id=?').run('owner-agent');
  assert.equal(readiness().state, 'bot_required');
  await gateway.save('owner', { ...input('first'), id, enabled: false });
  assert.equal(readiness().state, 'disabled', 'an account whose Bot is disabled can still be turned off');
  store.db.prepare('UPDATE agent_profiles SET enabled=1 WHERE id=?').run('owner-agent');
  await gateway.save('owner', { ...input('first'), id });
  bot.send('owner', binding.thread_id, { clientNonce: 'failed-run', content: 'question' });
  store.db.prepare("UPDATE runs SET status='failed',error_code='model_not_configured'").run();
  assert.equal(readiness().state, 'attention');
  assert.equal(readiness().latestRun.errorCode, 'model_not_configured');
  store.db.prepare("UPDATE runs SET status='completed',error_code=NULL").run();
  gateway.enqueue(binding.id, 'failed-reply', { text: 'reply' });
  store.db.prepare("UPDATE gateway_outbox SET status='uncertain' WHERE status='pending'").run();
  assert.equal(readiness().deliveryFailures, 1); assert.equal(readiness().state, 'attention');
  const delivery = store.db.prepare("SELECT id FROM gateway_outbox WHERE status='uncertain'").get();
  gateway.discard('owner', delivery.id);
  assert.equal(readiness().state, 'ready');
});

test('two bots on one server isolate cursors, dedupe, owner binding and conversations', async t => {
  const { gateway, store, contexts, bind, sent } = fixture(t);
  const first = (await gateway.save('owner', input('one'))).id;
  const second = (await gateway.save('owner', input('two'))).id;
  const b1 = await bind(first), b2 = await bind(second);
  assert.notEqual(b1.thread_id, b2.thread_id);
  contexts.get(first).receive([message('same-id', 'question for first')], 'cursor-first');
  contexts.get(second).receive([message('same-id', 'question for second')], 'cursor-second');
  await gateway.tick();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 2);
  assert.equal(gateway.account('owner', first).cursor, 'cursor-first');
  assert.equal(gateway.account('owner', second).cursor, 'cursor-second');
  assert.match(JSON.stringify(store.db.prepare("SELECT content FROM messages WHERE thread_id=? AND role='user'").all(b1.thread_id)), /question for first/);
  assert.match(JSON.stringify(store.db.prepare("SELECT content FROM messages WHERE thread_id=? AND role='user'").all(b2.thread_id)), /question for second/);
  const firstContext = contexts.get(first);
  await gateway.remove('owner', first);
  assert.equal(firstContext.signal.aborted, true);
  assert.equal(contexts.get(second).signal.aborted, false);
  assert.throws(() => firstContext.receive([message('stale')]), /abort/i);
  gateway.receive(second, [message('status-after-remove', '/status')]); await gateway.tick();
  assert.equal(sent.at(-1).account, second);
  assert.equal(gateway.list('owner').length, 1);
  assert.ok(store.db.prepare('SELECT 1 FROM threads WHERE id=?').get(b1.thread_id));
});

test('duplicate platform identities are rejected across owners, simultaneous saves and QR login', async t => {
  const { gateway, hooks } = fixture(t);
  const attempts = await Promise.allSettled([gateway.save('owner', input('same')), gateway.save('owner', input('same'))]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(attempts.find(r => r.status === 'rejected').reason.message, /duplicate_channel_account/);
  await assert.rejects(gateway.save('other', input('same', { agentId: 'other-agent' })), /duplicate_channel_account/);
  await assert.rejects(gateway.save('owner', input('different', { config: { botId: 'different', botToken: 'secret-same' } })), /duplicate_channel_account/);
  const blank = (await gateway.save('owner', input('', { config: {} }))).id;
  hooks.set(blank, { login: async () => ({ status: 'confirmed', botId: 'same', botToken: 'rotated-secret' }) });
  await assert.rejects(gateway.login('owner', blank, { action: 'poll', qrcode: 'test' }), /duplicate_channel_account/);
  assert.deepEqual(gateway.config(gateway.account('owner', blank)), {});
  const feishu = { channel: 'feishu', agentId: 'owner-agent', enabled: true, config: { appId: 'cli_one', appSecret: 'secret' } };
  await gateway.save('owner', feishu);
  await gateway.save('owner', { ...feishu, config: { appId: 'cli_two', appSecret: 'secret' } });
  await assert.rejects(gateway.save('owner', feishu), /duplicate_channel_account/);
});

test('remove fences active send, attachment and late login; cascades queues while preserving web history', async t => {
  const { gateway, store, bot, bind, hooks, contexts } = fixture(t);
  const { id } = await gateway.save('owner', input('remove'));
  const binding = await bind(id), context = contexts.get(id);
  bot.send('owner', binding.thread_id, { clientNonce: 'active', content: 'preserved question' });
  store.db.prepare('INSERT INTO bot_reminders(id,owner_id,thread_id,text,timezone,next_at,created_at) VALUES(?,?,?,?,?,?,?)').run('reminder', 'owner', binding.thread_id, 'review', 'UTC', Date.now() + 60000, at());
  gateway.pair('owner', id);
  gateway.enqueue(binding.id, 'send-in-flight', { text: 'reply' });
  const sending = deferred(), downloading = deferred(), login = deferred();
  const signals = {};
  hooks.set(id, {
    send: signal => { signals.send = signal; return sending.promise; },
    download: signal => { signals.download = signal; return downloading.promise; },
    login: signal => { signals.login = signal; return login.promise; },
  });
  gateway.receive(id, [message('media', 'read this', { attachments: [{ key: 'file', name: 'study.txt', mime: 'text/plain' }] })]);
  const tick = gateway.tick();
  const pendingLogin = gateway.login('owner', id, { action: 'poll', qrcode: 'late' });
  const loginRejected = assert.rejects(pendingLogin, /abort/i);
  assert.ok(signals.send && signals.download && signals.login);
  // Seed a projection failure as well: all gateway child rows must disappear.
  store.db.prepare('INSERT INTO gateway_projection_failures(binding_id,event_id,error,next_at) VALUES(?,?,?,?)').run(binding.id, 999999, 'projection_failed', Date.now() + 60000);
  await gateway.remove('owner', id);
  assert.ok(Object.values(signals).every(signal => signal.aborted));
  assert.equal(context.signal.aborted, true);
  for (const table of ['gateway_accounts', 'gateway_pairings', 'gateway_bindings', 'gateway_inbox', 'gateway_outbox', 'gateway_projection_failures']) assert.equal(store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  assert.equal(store.db.prepare('SELECT status FROM bot_reminders').get().status, 'cancelled');
  assert.equal(store.db.prepare('SELECT status FROM runs').get().status, 'cancelled');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE content='preserved question'").get().n, 1);
  sending.resolve('late-send'); downloading.resolve({ bytes: Buffer.from('late-file'), name: 'study.txt', mime: 'text/plain' });
  login.resolve({ status: 'confirmed', botId: 'remove', botToken: 'late-secret' });
  await tick; await loginRejected; await gateway.tick();
  context.health('connected'); context.updateConfig({ botToken: 'stale' });
  assert.deepEqual(gateway.list('owner'), []);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM files').get().n, 0);
  const replacement = await gateway.save('owner', input('remove'));
  assert.notEqual(replacement.id, id); assert.equal(gateway.list('owner')[0].readiness.bound, false);
});

test('legacy duplicates do not launch competing consumers; removal allows the survivor to reconnect', async t => {
  const { gateway, store, contexts } = fixture(t);
  const { id } = await gateway.save('owner', input('legacy'));
  await gateway.close();
  store.db.prepare('INSERT INTO gateway_accounts SELECT ?,owner_id,channel,agent_id,enabled,preset,config,cursor,health,created_at FROM gateway_accounts WHERE id=?').run('legacy-copy', id);
  contexts.clear(); gateway.start(false);
  assert.equal(contexts.size, 0);
  assert.ok(gateway.list('owner').every(a => a.connection.error.code === 'duplicate_channel_account'));
  await gateway.remove('owner', 'legacy-copy');
  await gateway.save('owner', { ...input('legacy'), id });
  assert.equal(contexts.size, 1); assert.equal(gateway.account('owner', id).health, 'connected');
});

test('DELETE endpoint enforces authentication, origin and ownership', async t => {
  const { gateway } = fixture(t);
  const { id } = await gateway.save('owner', input('http-delete'));
  const app = Fastify();
  registerGatewayRoutes(app, gateway, (r, p) => r.headers['x-owner'] ? { id: r.headers['x-owner'] } : (p.code(401).send(), null),
    (r, p) => r.headers.origin === 'https://test.invalid' || (p.code(403).send(), false));
  t.after(() => app.close());
  const request = headers => app.inject({ method: 'DELETE', url: `/api/v1/gateway/accounts/${id}`, headers });
  assert.equal((await request({ origin: 'https://test.invalid' })).statusCode, 401);
  assert.equal((await request({ origin: 'https://evil.invalid', 'x-owner': 'owner' })).statusCode, 403);
  assert.equal((await request({ origin: 'https://test.invalid', 'x-owner': 'other' })).json().error, 'account_not_found');
  assert.equal(gateway.list('owner').length, 1);
  assert.deepEqual((await request({ origin: 'https://test.invalid', 'x-owner': 'owner' })).json(), { removed: true });
  assert.equal(gateway.list('owner').length, 0);
});
