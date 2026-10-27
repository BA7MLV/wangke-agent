import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { GatewayCore } from '../apps/api/src/gateway/core.ts';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await sleep(5); } throw new Error('gateway_worker_timeout'); }
function deferred(signal) {
  let resolve;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    signal.addEventListener('abort', () => no(signal.reason), { once: true });
    if (signal.aborted) no(signal.reason);
  });
  return { promise, resolve };
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-workers-'));
const store = new DatabaseStore(path.join(root, 'db.sqlite'));
const unhandled = [], lateHandled = [], logs = [];
const rejected = error => unhandled.push(error), handled = promise => lateHandled.push(promise);
const originalError = console.error, originalPrepare = store.db.prepare.bind(store.db);
process.on('unhandledRejection', rejected); process.on('rejectionHandled', handled);
let gateway;
try {
  const owner = 'worker-owner', at = new Date().toISOString();
  store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, owner, at);
  store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('agent', owner, 'Agent', '', '', at, at);
  const config = new CloudConfiguration(store, path.join(root, 'config'));
  const bot = new BotApplicationService(store, { enqueue() {}, cancel() {} });
  const sends = [], downloads = [], sending = new Map(), downloading = new Map();
  gateway = new GatewayCore(store, config, bot, { fake: () => ({
    manifest: { id: 'fake', version: 1, name: 'Fake', capabilities: { direct: true, groups: false, images: true, files: true, proactive: 'yes', deduplicationWindowMs: 0 } },
    validate() {}, async start() {}, async stop() {},
    async send(_config, _destination, payload, id, signal) {
      sends.push(payload.text);
      if (payload.text.startsWith('slow-send')) { const pending = deferred(signal); sending.set(payload.text, pending); await pending.promise; }
      return `sent:${id}`;
    },
    async download(_config, message, _attachment, signal) {
      downloads.push(message.messageId);
      const pending = deferred(signal); downloading.set(message.messageId, pending); await pending.promise;
      return { bytes: Buffer.from('fixture'), name: 'fixture.txt', mime: 'text/plain' };
    },
  }) }, root);
  const accounts = [];
  for (let i = 0; i < 3; i++) {
    const account = await gateway.save(owner, { channel: 'fake', agentId: 'agent', enabled: true });
    const thread = bot.create(owner, 'bot', `Worker ${i}`);
    const binding = `binding-${i}`;
    store.db.prepare('INSERT INTO gateway_bindings(id,account_id,tenant,peer,chat,topic,thread_id) VALUES(?,?,?,?,?,?,?)').run(binding, account.id, '', 'peer', 'chat', '', thread.id);
    accounts.push({ id: account.id, binding, thread: thread.id });
  }
  const envelope = (id, media = false) => ({ messageId: id, tenant: '', peer: 'peer', chat: 'chat', topic: '', direct: true, human: true, text: id, ...(media ? { attachments: [{ type: 'file', id }] } : {}) });
  const status = external => store.db.prepare('SELECT status FROM gateway_inbox WHERE external_id=?').get(JSON.stringify(['', external]))?.status;
  const queuedRun = id => store.db.prepare('SELECT COUNT(*) n FROM messages WHERE content=? AND role=\'user\'').get(id).n;

  // Reproduce the reviewer's exact ordering: the worker rejects, its failed
  // status write fails, and an unrelated delivery is still awaiting network.
  store.db.prepare('INSERT INTO gateway_inbox(account_id,external_id,envelope) VALUES(?,?,?)').run(accounts[0].id, 'corrupt', 'invalid-encrypted-envelope');
  gateway.receive(accounts[1].id, [envelope('healthy-during-fault')]);
  gateway.enqueue(accounts[2].binding, 'slow-fault', { text: 'slow-send-fault' });
  console.error = (...args) => logs.push(args.join(' '));
  store.db.prepare = sql => {
    if (sql.startsWith("UPDATE gateway_inbox SET status='failed'") || sql.includes("health='inbound_failed'")) throw new Error('simulated_error_persistence_failure');
    return originalPrepare(sql);
  };
  const faultTick = gateway.tick();
  await until(() => sending.has('slow-send-fault')); await sleep(30);
  assert.deepEqual(unhandled, []); assert.deepEqual(lateHandled, []);
  assert.ok(logs.includes('gateway_inbox_worker_failed'), 'fixed-code observer survives DB reporting failure');
  assert.equal(queuedRun('healthy-during-fault'), 1, 'a failed worker does not stop another account');
  store.db.prepare = originalPrepare;
  sending.get('slow-send-fault').resolve(); await faultTick;
  gateway.receive(accounts[0].id, [envelope('healthy-after-fault')]);
  await gateway.tick();
  assert.equal(queuedRun('healthy-after-fault'), 1, 'failed account lock released and subsequent input works');
  assert.equal(store.db.prepare("SELECT status FROM gateway_inbox WHERE external_id='corrupt'").get().status, 'failed');

  // Now fail only the inbox status write: account-local health remains an
  // observable report, and does not overwrite unrelated account health.
  store.db.prepare('INSERT INTO gateway_inbox(account_id,external_id,envelope) VALUES(?,?,?)').run(accounts[0].id, 'corrupt-again', 'invalid');
  store.db.prepare = sql => { if (sql.startsWith("UPDATE gateway_inbox SET status='failed'")) throw new Error('inbox_write_failed'); return originalPrepare(sql); };
  await gateway.tick(); store.db.prepare = originalPrepare;
  assert.equal(store.db.prepare('SELECT health FROM gateway_accounts WHERE id=?').get(accounts[0].id).health, 'inbound_failed');
  assert.notEqual(store.db.prepare('SELECT health FROM gateway_accounts WHERE id=?').get(accounts[1].id).health, 'inbound_failed');
  await gateway.tick();

  // Tick A releases its pass while downloading but keeps its account lock.
  // Tick B owns the pass during slow send. A's completion must not release B.
  gateway.receive(accounts[0].id, [envelope('slow-download-a', true), envelope('same-account-next', true)]);
  const tickA = gateway.tick(); await until(() => downloading.has('slow-download-a'));
  gateway.enqueue(accounts[2].binding, 'gate-race', { text: 'slow-send-gate' });
  const tickB = gateway.tick(); await until(() => sending.has('slow-send-gate'));
  assert.deepEqual(downloads, ['slow-download-a'], 'same account cannot reenter from tick B');
  downloading.get('slow-download-a').resolve(); await until(() => downloading.has('same-account-next'));
  downloading.get('same-account-next').resolve(); await tickA;
  gateway.receive(accounts[1].id, [envelope('must-wait-for-pass', true)]);
  await gateway.tick();
  assert.ok(!downloading.has('must-wait-for-pass'), 'old tick finally cannot clear the current delivery gate');
  sending.get('slow-send-gate').resolve(); await tickB;
  const later = gateway.tick(); await until(() => downloading.has('must-wait-for-pass'));
  downloading.get('must-wait-for-pass').resolve(); await later;
  assert.equal(status('must-wait-for-pass'), 'done');
  assert.equal(new Set(downloads).size, downloads.length, 'no duplicate inbound execution');

  // Close while both a worker and a send await cancellation. Failure to persist
  // stop health must not skip draining workers or leave any unhandled promise.
  gateway.receive(accounts[0].id, [envelope('shutdown-download', true)]);
  // Abandon the spawning pass *before* it awaits workers: close must still
  // drain this independently tracked attachment, not merely active ticks.
  store.db.prepare = sql => { if (sql.startsWith('SELECT * FROM message_events')) throw new Error('projection_read_failed'); return originalPrepare(sql); };
  await gateway.tick(); store.db.prepare = originalPrepare;
  assert.ok(downloading.has('shutdown-download'));
  gateway.enqueue(accounts[2].binding, 'shutdown-send', { text: 'slow-send-shutdown' });
  const closingTick = gateway.tick(); await until(() => downloading.has('shutdown-download') && sending.has('slow-send-shutdown'));
  store.db.prepare = sql => { if (sql.includes("health='stopped'")) throw new Error('stop_persistence_failed'); return originalPrepare(sql); };
  await Promise.race([gateway.close(), sleep(1000).then(() => { throw new Error('gateway_close_hung'); })]);
  await closingTick; store.db.prepare = originalPrepare;
  const afterClose = downloads.length; await gateway.tick(); assert.equal(downloads.length, afterClose);
  assert.equal(status('shutdown-download'), 'failed');
  await sleep(20); assert.deepEqual(unhandled, []); assert.deepEqual(lateHandled, []);
  console.log('Gateway workers: immediate fault isolation during slow send, account recovery, non-reentrant pass ownership and abort/drain shutdown passed');
} finally {
  store.db.prepare = originalPrepare; console.error = originalError;
  await gateway?.close(); store.close();
  process.off('unhandledRejection', rejected); process.off('rejectionHandled', handled);
  fs.rmSync(root, { recursive: true, force: true });
}
