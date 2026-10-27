import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-runtime-'));
const store = new DatabaseStore(path.join(dir, 'db.sqlite'));
const user = crypto.randomUUID(); const thread = crypto.randomUUID();
const now = new Date().toISOString();
process.env.MODEL_API_KEY = 'test-only';
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(user, 'Test', now);
store.db.prepare('INSERT INTO threads(id,owner_id,mode,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(thread, user, 'bot', 'Test', now, now);
const configuration = new CloudConfiguration(store, path.join(dir, 'config'));
const defaults = configuration.get(user, true);
configuration.save(user, { ...defaults, policy: { ...defaults.policy, shell: 'allow' } });
const createRun = () => {
  const id = crypto.randomUUID();
  store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,?,?,?)').run(id, thread, 'bot', 'queued', now);
  return id;
};
const state = (id) => store.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
async function until(fn) {
  for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for runtime');
}
const response = (name, args) => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'model-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
let runner;
try {
  // Multiple model turns, tool result in context, persisted wait across runtime restart.
  const id = createRun(); let commands = 0; let calls = 0;
  runner = new BotRunner(store, {
    configuration,
    sandbox: async (req) => { commands++; assert.equal(req.threadId, thread); return { stdout: '42', stderr: '', exitCode: 0 }; },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body); calls++;
      if (calls === 1) return response('shell', { command: 'node -e "console.log(42)"' });
      assert.match(body.messages.at(-1).content, /42/);
      return response('wait', { seconds: 1, reason: 'Follow up' });
    },
  });
  runner.start();
  await until(() => state(id).wake_at);
  assert.equal(commands, 1); assert.equal(state(id).status, 'queued');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM run_steps WHERE run_id=?').get(id).n, 2);
  await runner.close();
  runner = new BotRunner(store, { fetch: async (_url, init) => {
    assert.match(JSON.parse(init.body).messages.at(-1).content, /Scheduled wake/);
    return response('send_message', { kind: 'text', text: 'Finished after restart' });
  } });
  runner.start(); await until(() => state(id).status === 'completed'); await runner.close();
  assert.equal(state(id).step_count, 3);

  // Crash checkpoint must never blindly repeat a shell command with uncertain side effects.
  const recovered = createRun(); const callId = crypto.randomUUID();
  const context = [{ role: 'system', content: 'test' }, { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'shell', arguments: '{"command":"touch marker"}' } }] }];
  store.db.prepare("UPDATE runs SET status='running',context_json=? WHERE id=?").run(JSON.stringify(context), recovered);
  store.db.prepare('INSERT INTO run_steps(id,run_id,tool,arguments,status,created_at) VALUES(?,?,?,?,?,?)').run(callId, recovered, 'shell', '{}', 'running', now);
  runner = new BotRunner(store, { sandbox: async () => { throw new Error('Must not replay'); }, fetch: async (_url, init) => {
    assert.match(JSON.parse(init.body).messages.at(-1).content, /interrupted/i);
    return response('send_message', { kind: 'text', text: 'Recovered' });
  } });
  runner.start(); await until(() => state(recovered).status === 'completed'); await runner.close();
  assert.equal(store.db.prepare('SELECT status FROM run_steps WHERE id=?').get(callId).status, 'interrupted');

  // Cancellation propagates to the running sandbox and does not complete the run.
  const cancelled = createRun(); let started = false; let aborted = false;
  runner = new BotRunner(store, {
    configuration,
    fetch: async () => response('shell', { command: 'sleep 60' }),
    sandbox: async (_req, signal) => new Promise((_resolve, reject) => {
      started = true; signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }),
  });
  runner.start(); await until(() => started);
  store.db.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(cancelled);
  runner.cancel(cancelled); await until(() => aborted); await runner.close();
  assert.equal(state(cancelled).status, 'cancelled');
  assert.equal(store.db.prepare('SELECT status FROM run_steps WHERE run_id=?').get(cancelled).status, 'interrupted');
  // Model failures retain diagnostics without creating conversation messages or events.
  for (const [fetcher, code] of [
    [async () => new Response('', { status: 503 }), 'model_request_failed'],
    [async () => { throw new Error('network unavailable'); }, 'model_request_failed'],
    [async () => new Response(JSON.stringify({ choices: [] })), 'invalid_structured_response'],
  ]) {
    const failed = createRun();
    const messagesBefore = store.db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id=?').get(thread).n;
    const eventsBefore = store.db.prepare('SELECT COUNT(*) n FROM message_events WHERE thread_id=?').get(thread).n;
    runner = new BotRunner(store, { fetch: fetcher });
    runner.start(); await until(() => state(failed).status === 'failed'); await runner.close();
    assert.equal(state(failed).error_code, code);
    assert.ok(state(failed).completed_at);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id=?').get(thread).n, messagesBefore);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM message_events WHERE thread_id=?').get(thread).n, eventsBefore);
  }
  console.log('Bot runtime: multi-step, persistent wake, crash recovery, cancellation and silent model failures passed');
} finally { await runner?.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
