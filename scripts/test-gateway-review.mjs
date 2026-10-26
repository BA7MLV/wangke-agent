import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';
import { mediaMime } from '../apps/api/src/cloud/image.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';
import { GatewayCore } from '../apps/api/src/gateway/core.ts';
import { FeishuPlugin } from '../apps/api/src/gateway/adapters/feishu.ts';
import { IlinkPlugin, normalizeIlink } from '../apps/api/src/gateway/adapters/ilink.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-review-')), files = path.join(dir, 'files'); fs.mkdirSync(files);
const store = new DatabaseStore(path.join(dir, 'db.sqlite')), config = new CloudConfiguration(store, path.join(dir, 'config'));
const owner = 'owner', other = 'other', at = new Date().toISOString(), records = new CloudRecords(store);
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, at);
for (const id of ['agent', 'new-agent']) store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, owner, id, 'study', 'Study.', at, at);
let runner;
const service = new BotApplicationService(store, { enqueue: () => runner?.enqueue(), cancel: id => runner?.cancel(id) });
const sent = [], unhandled = []; let startFailures = 0;
const factories = { feishu: () => ({ manifest: { id: 'feishu', version: 1, capabilities: { direct: true, deduplicationWindowMs: 0 } }, validate() {}, start(_c, ctx) { if (startFailures-- > 0) throw new Error('SECRET_START_ERROR'); ctx.health('connected'); return Promise.resolve(); }, async stop() {}, async send(_c, _p, data, id) { sent.push({ id, ...data }); return id; } }) };
let gateway = new GatewayCore(store, config, service, factories, files);
const study = new StudyTools(store, config, files, async () => { throw new Error('network_forbidden'); });
const envelope = (text, messageId = crypto.randomUUID()) => ({ messageId, tenant: '', peer: 'me', chat: 'chat', topic: '', direct: true, human: true, text });
const tool = (name, args) => Response.json({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n = 0; n < 500; n++) { if (fn()) return; await sleep(10); } throw new Error('review_timeout'); }
const status = id => store.db.prepare('SELECT status FROM runs WHERE id=?').get(id)?.status;
const policy = values => config.save(owner, { ...config.get(owner, true), policy: { ...config.get(owner).policy, ...values } });
async function bind() {
  const { id } = await gateway.save(owner, { channel: 'feishu', agentId: 'agent', enabled: true, config: {} });
  gateway.receive(id, [envelope(gateway.pair(owner, id).command)]); await gateway.tick();
  return store.db.prepare('SELECT * FROM gateway_bindings WHERE account_id=?').get(id);
}
async function runIn(thread, fetcher) {
  await runner?.close();
  runner = new BotRunner(store, { configuration: config, study, fetch: fetcher });
  const message = service.send(owner, thread, { clientNonce: crypto.randomUUID(), content: 'regression' });
  const run = store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(message.id).id;
  runner.start(); return run;
}
const rejectUnhandled = error => unhandled.push(error);
process.on('unhandledRejection', rejectUnhandled);
try {
  gateway.start(false);
  const b = await bind(), unused = gateway.pair(owner, b.account_id);
  gateway.receive(b.account_id, [envelope(unused.command, 'pending-unused-pair')]);
  store.db.exec("CREATE TRIGGER abort_revoke BEFORE UPDATE OF revoked ON gateway_bindings WHEN NEW.revoked=1 BEGIN SELECT RAISE(ABORT,'review_crash'); END;");
  assert.throws(() => gateway.revoke(owner, b.account_id, b.id), /review_crash/);
  assert.ok(store.db.prepare('SELECT 1 FROM gateway_pairings WHERE account_id=?').get(b.account_id));
  assert.equal(store.db.prepare('SELECT status FROM gateway_inbox WHERE external_id=?').get(JSON.stringify(['', 'pending-unused-pair'])).status, 'pending');
  store.db.exec('DROP TRIGGER abort_revoke');
  gateway.revoke(owner, b.account_id, b.id);
  assert.equal(store.db.prepare('SELECT 1 FROM gateway_pairings WHERE account_id=?').get(b.account_id), undefined);
  assert.equal(store.db.prepare("SELECT status FROM gateway_inbox WHERE external_id=?").get(JSON.stringify(['', 'pending-unused-pair'])).status, 'cancelled');
  gateway.receive(b.account_id, [envelope(unused.command)]); await gateway.tick();
  assert.equal(store.db.prepare('SELECT revoked FROM gateway_bindings WHERE id=?').get(b.id).revoked, 1);
  await gateway.save(owner, { id: b.account_id, channel: 'feishu', agentId: 'new-agent', enabled: true, config: {} });
  gateway.receive(b.account_id, [envelope(gateway.pair(owner, b.account_id).command)]); await gateway.tick();
  assert.deepEqual(store.db.prepare('SELECT agent_id FROM thread_participants WHERE thread_id=?').all(b.thread_id), [{ agent_id: 'new-agent' }]);
  console.log('Review 1: unconsumed/pending pairing revoked atomically; rebind uses current Bot');

  const defaults = config.get(owner, true);
  config.save(owner, { ...defaults, providers: [{ id: 'mock', name: 'mock', baseUrl: 'https://model.invalid/v1', protocol: 'openai-chat', apiKey: 'test', serves: ['chat'] }], llmModel: { providerId: 'mock', model: 'mock' }, policy: { ...defaults.policy, read: 'allow', write: 'allow', remove: 'ask' } });
  const editable = { id: 'editable', name: 'Original', size: 0, mimeType: 'video/mp4', duration: 10, createdAt: 1, status: 'transcribed' };
  records.apply(owner, [{ id: 'edit-seed', table: 'videos', key: 'editable', before: null, after: editable }]);
  records.apply(other, [{ id: 'other-seed', table: 'videos', key: 'editable', before: null, after: { ...editable, name: 'Other owner' } }]);
  const c = { owner, thread: b.thread_id, run: '', step: '', signal: new AbortController().signal, checkActive() {}, append() {} };
  let turn = 0, oldValue, updatedValue;
  const editThread = service.create(owner, 'bot', 'read update remove', 'agent').id;
  const editRun = await runIn(editThread, async (_url, init) => {
    const body = JSON.parse(init.body), last = body.messages.at(-1); turn++;
    if (turn === 1) return tool('study_read', { table: 'videos', courseId: 'editable' });
    if (turn === 2) { const item = JSON.parse(last.content).records[0]; oldValue = item.value; assert.deepEqual(oldValue, editable); return tool('study_manage', { table: 'videos', key: item.key, before: item.value, after: { ...item.value, name: 'Updated' } }); }
    if (turn === 3) {
      await assert.rejects(() => study.plugins.get('study_manage').execute({ table: 'videos', key: 'editable', before: oldValue, after: { ...oldValue, name: 'Concurrent stale change' } }, { ...c, step: 'stale-existing-update' }), /sync_conflict/);
      return tool('study_read', { table: 'videos', courseId: 'editable' });
    }
    if (turn === 4) { const item = JSON.parse(last.content).records[0]; updatedValue = item.value; assert.deepEqual(updatedValue, { ...editable, name: 'Updated' }); return tool('study_manage', { table: 'videos', key: item.key, before: item.value, after: null }); }
    return tool('send_message', { kind: 'text', text: 'done' });
  });
  await until(() => status(editRun) === 'waiting_user');
  assert.deepEqual(records.get(owner, 'videos', 'editable'), updatedValue);
  const approval = store.db.prepare("SELECT * FROM approvals WHERE run_id=? AND status='pending'").get(editRun);
  service.resolve(owner, approval.id, true); await until(() => status(editRun) === 'completed');
  assert.equal(records.get(owner, 'videos', 'editable'), null);
  assert.equal(records.get(other, 'videos', 'editable').name, 'Other owner');
  await assert.rejects(() => study.plugins.get('study_manage').execute({ table: 'videos', key: 'editable', before: oldValue, after: { ...oldValue, name: 'Stale' } }, { ...c, step: 'stale-update' }), /sync_conflict/);
  await runner.close(); runner = undefined;

  // Old matching records must survive >1000 newer records from unrelated courses.
  const mutations = [];
  for (const id of ['old/course', 'noise', 'large']) records.apply(owner, [{ id: `seed-${id}`, table: 'videos', key: id, before: null, after: { ...editable, id, name: id, kind: 'material', materialFormat: 'md', duration: 0 } }]);
  for (let i = 1; i <= 35; i++) mutations.push({ id: `old-${i}`, table: 'materialBlocks', key: i, before: null, after: { id: i, materialId: 'old/course', idx: i - 1, unit: i, unitLabel: `p${i}`, text: 'Rare Target', kind: 'body' } });
  for (let i = 36; i <= 1140; i++) mutations.push({ id: `noise-${i}`, table: 'materialBlocks', key: i, before: null, after: { id: i, materialId: 'noise', idx: i - 36, unit: i - 35, unitLabel: `p${i}`, text: 'Other course', kind: 'body' } });
  records.apply(owner, mutations);
  const savedOrigin = process.env.PUBLIC_ORIGIN; process.env.PUBLIC_ORIGIN = 'https://study.example.com';
  const readArgs = { table: 'materialBlocks', courseId: 'old/course', query: 'Rare Target' };
  const first = await study.plugins.get('study_read').execute(readArgs, c), second = await study.plugins.get('study_read').execute({ ...readArgs, cursor: first.nextCursor }, c);
  assert.equal(first.records.length, 30); assert.equal(second.records.length, 5); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.records, ...second.records].map(r => r.key)).size, 35);
  assert.equal(first.citation, 'https://study.example.com/#/player/old%2Fcourse');
  delete process.env.PUBLIC_ORIGIN;
  assert.equal((await study.plugins.get('study_read').execute(readArgs, c)).citation, '#/player/old%2Fcourse');
  if (savedOrigin !== undefined) process.env.PUBLIC_ORIGIN = savedOrigin;
  assert.equal((await study.plugins.get('study_read').execute(readArgs, { ...c, owner: other })).records.length, 0);
  records.apply(owner, [{ id: 'large-record', table: 'materialBlocks', key: 1141, before: null, after: { id: 1141, materialId: 'large', idx: 0, unit: 1, unitLabel: 'p1', kind: 'body', text: 'x'.repeat(20000) } }]);
  const bounded = await study.plugins.get('study_read').execute({ table: 'materialBlocks', courseId: 'large' }, c);
  assert.equal(bounded.records[0].omitted, true); assert.equal(bounded.records[0].value, undefined);
  assert.equal(bounded.truncated, true); assert.ok(JSON.stringify(bounded).length < 16000);
  console.log('Review 2/3: real Bot read/update/read/approved delete, raw snapshots, owner/conflict, SQL filtered cursor over 1140 rows and player URLs');

  const file = await receiveFile(store, files, owner, Readable.from(['private study file']), 'study.txt', 'text/plain', 1024);
  for (const read of ['deny', 'ask']) {
    policy({ read, write: 'allow' }); let n = 0;
    const thread = service.create(owner, 'bot', `attachment ${read}`, 'agent').id;
    const run = await runIn(thread, async () => { n++; return n === 1 ? tool('send_message', { kind: 'attachment', text: JSON.stringify({ fileId: file.id }) }) : n === 2 ? tool('study_send_file', { fileId: file.id }) : tool('send_message', { kind: 'text', text: 'done' }); });
    if (read === 'ask') {
      await until(() => status(run) === 'waiting_user');
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_id=? AND kind='attachment'").get(thread).n, 0);
      const a = store.db.prepare("SELECT * FROM approvals WHERE run_id=? AND status='pending'").get(run); service.resolve(owner, a.id, true);
    }
    await until(() => status(run) === 'completed');
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_id=? AND kind='attachment'").get(thread).n, read === 'ask' ? 1 : 0);
    assert.match(store.db.prepare("SELECT result FROM run_steps WHERE run_id=? AND tool='send_message' ORDER BY created_at LIMIT 1").get(run).result, /study_send_file/);
  }
  const legacy = service.create(owner, 'bot', 'legacy attachment', 'agent').id;
  const legacyRun = await runIn(legacy, async () => tool('send_message', { kind: 'attachment', text: 'Historical plain text' }));
  await until(() => status(legacyRun) === 'completed');
  assert.equal(store.db.prepare("SELECT content FROM messages WHERE thread_id=? AND kind='attachment'").get(legacy).content, 'Historical plain text');
  await runner.close(); runner = undefined;
  console.log('Review 4: Bot loop rejects raw fileId send_message under ask/deny; approved study_send_file and legacy text still work');

  // Pause the real filesystem operation, then change authority while the tool is awaiting I/O.
  for (const name of ['study_export', 'study_send_file']) for (const action of ['stop', 'revoke', 'deny']) {
    policy({ read: 'allow', write: 'allow' });
    const target = await bind();
    let release, entered = false;
    const gate = new Promise(resolve => { release = resolve; });
    const originalFile = study.file, originalRename = fs.promises.rename;
    if (name === 'study_send_file') study.file = async (...args) => { const f = await originalFile.apply(study, args); entered = true; await gate; return f; };
    else fs.promises.rename = async (...args) => { if (String(args[0]).startsWith(path.join(files, '.upload-'))) { entered = true; await gate; } return originalRename(...args); };
    const fileCount = store.db.prepare('SELECT COUNT(*) n FROM files').get().n;
    try {
      let n = 0;
      const run = await runIn(target.thread_id, async () => ++n === 1 ? tool(name, name === 'study_export' ? { name: 'cancelled.md', content: 'must not commit' } : { fileId: file.id }) : tool('send_message', { kind: 'text', text: 'authority changed' }));
      await until(() => entered);
      if (action === 'stop') service.stop(owner, target.thread_id);
      else if (action === 'revoke') gateway.revoke(owner, target.account_id, target.id);
      else policy({ [name === 'study_export' ? 'write' : 'read']: 'deny' });
      release(); await until(() => ['cancelled','completed'].includes(status(run))); await runner.close(); runner = undefined;
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_id=? AND kind='attachment'").get(target.thread_id).n, 0, `${name}/${action} cannot publish a file`);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM files').get().n, fileCount, `${name}/${action} cannot commit a blob after authority changes`);
    } finally { release(); study.file = originalFile; fs.promises.rename = originalRename; }
  }
  console.log('Review 5: real async export/send I/O paused through stop, revoke and deny (6 cases), no file or attachment committed');

  const bad = await bind(), good = await bind();
  const broken = service.append(bad.thread_id, 'assistant', 'text', 'bad'), valid = service.append(good.thread_id, 'assistant', 'text', 'healthy conversation');
  const brokenEvent = store.db.prepare('SELECT event_id FROM message_events WHERE thread_id=? AND seq=?').get(bad.thread_id, broken.seq).event_id;
  store.db.prepare('UPDATE message_events SET payload=? WHERE event_id=?').run('SECRET_BROKEN_JSON', brokenEvent);
  await gateway.tick();
  assert.ok(store.db.prepare('SELECT checkpoint FROM gateway_bindings WHERE id=?').get(bad.id).checkpoint < brokenEvent);
  assert.equal(store.db.prepare('SELECT error FROM gateway_projection_failures WHERE binding_id=?').get(bad.id).error, 'projection_failed');
  assert.ok(sent.some(x => x.text === valid.content));
  const queuedBefore = store.db.prepare('SELECT COUNT(*) n FROM gateway_outbox').get().n; await gateway.tick();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_outbox').get().n, queuedBefore);
  store.db.prepare('UPDATE message_events SET payload=? WHERE event_id=?').run(JSON.stringify(broken), brokenEvent);
  store.db.prepare('UPDATE gateway_projection_failures SET next_at=0 WHERE binding_id=?').run(bad.id); await gateway.tick();
  assert.equal(store.db.prepare('SELECT 1 FROM gateway_projection_failures WHERE binding_id=?').get(bad.id), undefined);
  assert.ok(sent.some(x => x.text === 'bad'));
  startFailures = 1;
  const failedAccount = await gateway.save(owner, { channel: 'feishu', agentId: 'agent', enabled: true, config: {} });
  await until(() => store.db.prepare('SELECT health FROM gateway_accounts WHERE id=?').get(failedAccount.id).health === 'connection_failed');
  // Explicit save restarts immediately, without waiting for automatic 30-second backoff.
  await gateway.save(owner, { id: failedAccount.id, channel: 'feishu', agentId: 'agent', enabled: true, config: {} });
  await until(() => store.db.prepare('SELECT health FROM gateway_accounts WHERE id=?').get(failedAccount.id).health === 'connected');
  await gateway.close(); gateway = new GatewayCore(store, config, service, factories, files);
  const reminders = gateway.reminders.bind(gateway); let crashes = 1;
  gateway.reminders = () => { if (crashes-- > 0) throw new Error('SECRET_RUNTIME_ERROR'); reminders(); };
  gateway.start(true); await sleep(650); assert.equal(unhandled.length, 0);
  assert.equal(JSON.stringify(gateway.list(owner)).includes('SECRET_'), false);
  await gateway.close(); gateway = new GatewayCore(store, config, service, factories, files); gateway.start(false);
  console.log('Review 6: corrupt event isolated, checkpoint retained, repaired event recovered once; timer rejection contained; failed start restartable');

  store.db.prepare("UPDATE gateway_outbox SET status='sent' WHERE status='pending'").run();
  for (const state of ['failed', 'uncertain']) {
    gateway.enqueue(good.id, `head-${state}`, { text: `head ${state}` }); gateway.enqueue(good.id, `after-${state}`, { text: `after ${state}` });
    const head = store.db.prepare("SELECT id FROM gateway_outbox WHERE binding_id=? AND status='pending' ORDER BY seq LIMIT 1").get(good.id);
    store.db.prepare('UPDATE gateway_outbox SET status=? WHERE id=?').run(state, head.id);
    await gateway.tick(); assert.equal(sent.some(x => x.text === `after ${state}`), false);
    assert.throws(() => gateway.discard(other, head.id), /delivery_not_discardable/);
    gateway.discard(owner, head.id); await gateway.tick();
    assert.equal(store.db.prepare('SELECT status FROM gateway_outbox WHERE id=?').get(head.id).status, 'cancelled');
    assert.equal(sent.filter(x => x.text === `after ${state}`).length, 1);
    assert.throws(() => gateway.discard(owner, head.id), /delivery_not_discardable/);
  }
  console.log('Review 7: owner-only failed/uncertain head discard unblocks subsequent delivery without resending head');

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const feishu = new FeishuPlugin(async () => { throw new Error('unused'); }, async url => String(url).includes('tenant_access_token') ? Response.json({ tenant_access_token: 'token' }) : new Response(png, { headers: { 'content-type': 'application/octet-stream' } }));
  assert.equal((await feishu.download({}, envelope(''), { key: 'image', name: 'image.png', mime: 'image/png' }, c.signal)).mime, 'image/png');
  const ilink = new IlinkPlugin(async () => { throw new Error('unused'); }, async () => new Response(png));
  const imageEnvelope = normalizeIlink({ message_id: 12, from_user_id: 'me', message_type: 1, item_list: [{ image_item: { media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download' } } }] });
  const media = await ilink.download({}, imageEnvelope, imageEnvelope.attachments[0], c.signal); assert.equal(media.mime, 'image/png');
  assert.throws(() => mediaMime(Buffer.from('not an image'), 'image/jpeg'), /invalid_image_format/);
  const image = await receiveFile(store, files, owner, Readable.from([png]), 'wrong.jpg', 'image/jpeg', 1024);
  for (const protocol of ['openai-chat','openai-responses','anthropic-messages']) {
    config.save(owner, { ...config.get(owner, true), providers: [{ ...config.get(owner, true).providers[0], protocol }], visionModel: { providerId: 'mock', model: 'vision' } });
    const vision = new StudyTools(store, config, files, async (_url, init) => { assert.match(init.body, protocol === 'anthropic-messages' ? /"media_type":"image\/png"/ : /data:image\/png;base64/); return Response.json({}); });
    await vision.plugins.get('study_file').execute({ fileId: image.id }, c);
  }
  assert.equal(normalizeIlink({ message_id: Number.MAX_SAFE_INTEGER }).messageId, String(Number.MAX_SAFE_INTEGER));
  assert.throws(() => normalizeIlink({ message_id: Number.MAX_SAFE_INTEGER + 1 }), /unsafe_platform_message_id/);
  assert.equal(normalizeIlink({ message_id: '9223372036854775807' }).messageId, '9223372036854775807');
  const pollAbort = new AbortController(); let acceptedUnsafe = false;
  const unsafePoll = new IlinkPlugin(async () => { throw new Error('unused'); }, async () => new Response('{"ret":0,"msgs":[{"message_id":9007199254740993,"from_user_id":"me","message_type":1}],"get_updates_buf":"must-not-commit"}', { headers: { 'content-type': 'application/json' } }));
  await unsafePoll.start({ botToken: 'test' }, { signal: pollAbort.signal, cursor: () => 'old-safe-cursor', receive() { acceptedUnsafe = true; }, health(state) { if (state === 'reconnecting') pollAbort.abort(); }, updateConfig() {} });
  assert.equal(acceptedUnsafe, false, 'a lossy numeric message ID must not accept a batch or advance its cursor');
  assert.deepEqual(unhandled, []);
  console.log('Review extra: Feishu octet-stream and iLink JPEG-labelled PNG sniffing, 3 vision MIME payloads, invalid image/unsafe numeric ID rejection');
} finally { process.off('unhandledRejection', rejectUnhandled); await runner?.close(); await gateway.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
