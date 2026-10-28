import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudTaskRunner } from '../apps/api/src/cloud/tasks.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { settleWithin } from '../apps/api/src/lifecycle.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/release-drain-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const owner = crypto.randomUUID(), at = new Date().toISOString();
store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, owner, at);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(test) {
  for (let i = 0; i < 400; i++) { if (test()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('drain_test_timeout');
}
const taskStatus = id => store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(id).status;
const enqueue = () => {
  const id = crypto.randomUUID();
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, owner, id, 'modelOnce', id, '{}', 'queued', at, at);
  return id;
};
let cloud, bot;
try {
  assert.equal(await settleWithin([], 0), true);
  await assert.rejects(() => settleWithin([], NaN), /invalid_drain_deadline/);
  // Quiescence lets active work commit, but never takes another queued item.
  let gate = deferred(), started = false, aborted = false;
  cloud = new CloudTaskRunner(store, { executors: { node: async ({ signal }) => {
    started = true; signal.addEventListener('abort', () => { aborted = true; });
    await gate.promise; return { content: 'finished' };
  } } });
  const first = enqueue(); cloud.start('http://127.0.0.1:1');
  await until(() => started);
  const second = enqueue();
  assert.equal(await cloud.quiesce(5), false);
  assert.equal(aborted, false);
  gate.resolve(); assert.equal(await cloud.quiesce(1000), true);
  cloud.start('http://127.0.0.1:1');
  assert.equal(taskStatus(first), 'completed'); assert.equal(taskStatus(second), 'queued');
  await cloud.close();
  // Once the grace period expires, close aborts and persists interrupted, not cancelled.
  started = false;
  cloud = new CloudTaskRunner(store, { executors: { node: async ({ signal }) => {
    started = true;
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } } });
  cloud.start('http://127.0.0.1:1'); await until(() => started);
  assert.equal(await cloud.quiesce(5), false); await cloud.close();
  assert.equal(taskStatus(second), 'interrupted');

  const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
  configuration.save(owner, { ...configuration.get(owner), providers: [{ id: 'fake', name: 'Fake', protocol: 'openai-chat', baseUrl: 'https://fake.invalid/v1', apiKey: 'test', serves: ['chat'], catalogId: '' }], llmModel: { providerId: 'fake', model: 'fake' } });
  const service = new BotApplicationService(store, { enqueue() {}, cancel() {} });
  const thread = service.create(owner, 'bot', 'Release drain');
  service.send(owner, thread.id, { clientNonce: 'first', content: 'Finish this turn' });
  gate = deferred(); started = false;
  bot = new BotRunner(store, { configuration, fetch: async () => {
    started = true; await gate.promise;
    return Response.json({ choices: [{ message: { tool_calls: [{ id: 'finish', type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ kind: 'text', text: 'Done' }) } }] } }] });
  } });
  bot.start(); await until(() => started);
  assert.equal(await bot.quiesce(5), false);
  gate.resolve(); assert.equal(await bot.quiesce(2000), true);
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE thread_id=?').get(thread.id).status, 'completed');
  await bot.close();

  // The scheduler was inside awaited sandbox cleanup when deployment began.
  // It must not claim anything after that await, even with an already queued run.
  const next = service.create(owner, 'bot', 'Race');
  service.send(owner, next.id, { clientNonce: 'race', content: 'Do not start' });
  gate = deferred(); started = false; let modelCalls = 0;
  bot = new BotRunner(store, {
    configuration,
    projects: { executions: () => [{ executionId: 'old', projectId: 'project' }], endExecution() {} },
    sandboxCleanup: async () => { started = true; await gate.promise; },
    fetch: async () => { modelCalls++; throw new Error('must_not_claim'); },
  });
  bot.start(); await until(() => started);
  assert.equal(await bot.quiesce(5), false);
  gate.resolve(); assert.equal(await bot.quiesce(1000), true);
  bot.enqueue(); await bot.close();
  assert.equal(modelCalls, 0);
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE thread_id=?').get(next.id).status, 'queued');
  console.log('Release drain: graceful completion, admission stop, deadline/abort state and post-cleanup claim race passed');
} finally {
  await cloud?.close(); await bot?.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true });
}
