import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';
import { BudgetBlocked, DEFAULT_BOT_BUDGET } from '../apps/api/src/agent/budget.ts';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(fn) { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Bot parallel timeout'); }
const batch = calls => Response.json({ choices: [{ message: { tool_calls: calls.map(([name, args], i) => ({ id: `provider-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } });
const done = () => Response.json({ choices: [{ message: { content: 'Done' } }], usage: { prompt_tokens: 20, completion_tokens: 20 } });
const read = index => ['probe_read', { index }];
const plugin = (name, capability, execute, parallelSafe) => ({ name, description: name, properties: { index: { type: 'integer' } }, required: ['index'], capability: () => capability, execute, parallelSafe });

async function fixture(fn, policy = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-parallel-'));
  const store = new DatabaseStore(path.join(root, 'db.sqlite'));
  let runner;
  try {
    const owner = crypto.randomUUID(), at = new Date().toISOString();
    store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, owner, at);
    const config = new CloudConfiguration(store, path.join(root, 'config')), defaults = config.get(owner, true);
    config.save(owner, { ...defaults, providers: [{ id: 'fake', name: 'Fake', baseUrl: 'https://fake.invalid/v1', protocol: 'openai-chat', apiKey: 'fake', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'fake', model: 'fake' }, botBudget: DEFAULT_BOT_BUDGET, policy: { ...defaults.policy, read: 'allow', write: 'allow', ...policy } });
    const service = new BotApplicationService(store, { enqueue: () => runner?.enqueue(), cancel: id => runner?.cancel(id) });
    const thread = service.create(owner, 'bot', 'Parallel test');
    const message = service.send(owner, thread.id, { clientNonce: 'start', content: 'Read independently' });
    const run = store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(message.id).id;
    const study = new StudyTools(store, config, path.join(root, 'files'));
    const state = () => store.db.prepare('SELECT * FROM runs WHERE id=?').get(run);
    const start = fetch => { runner = new BotRunner(store, { configuration: config, study, fetch }); runner.start(); return runner; };
    await fn({ store, owner, service, thread, run, study, state, start, close: async () => { await runner?.close(); runner = undefined; } });
  } finally { await runner?.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test('Bot overlaps four reads, commits reverse completions by ID, isolates read failures and fences writes', () => fixture(async ({ store, run, study, state, start, close }) => {
  const gates = Array.from({ length: 7 }, deferred), started = [], ended = [];
  let active = 0, peak = 0, requests = 0, modelResults;
  study.register(plugin('probe_read', 'read', async ({ index }, c) => {
    started.push(index); peak = Math.max(peak, ++active);
    await gates[index].promise; c.checkActive(); active--; ended.push(index);
    if (index === 1) throw new Error('read_failure');
    return { index };
  }, () => true));
  study.register(plugin('probe_write', 'write', async () => {
    assert.equal(active, 0); assert.equal(ended.length, 6); started.push('write'); return { written: true };
  }));
  const calls = [...Array.from({ length: 6 }, (_, i) => read(i)), ['probe_write', { index: 0 }], read(6)];
  start(async (_url, init) => {
    if (++requests === 1) return batch(calls);
    modelResults = JSON.parse(init.body).messages.filter(m => m.role === 'tool');
    return done();
  });
  await until(() => started.length === 4);
  gates[3].resolve(); await until(() => ended.includes(3));
  await until(() => JSON.parse(state().context_json).some(m => m.role === 'tool'));
  assert.equal(started.length, 4);
  for (let i = 0; i < 3; i++) gates[i].resolve();
  await until(() => started.length === 6);
  assert.equal(started.includes('write'), false);
  gates[4].resolve(); gates[5].resolve();
  await until(() => started.includes(6)); gates[6].resolve();
  await until(() => state().status === 'completed'); await close();
  assert.equal(peak, 4); assert.equal(state().step_count, calls.length); assert.equal(requests, 2);
  assert.deepEqual(modelResults.map(r => r.tool_call_id), calls.map((_, i) => `provider-${i}`));
  assert.equal(JSON.parse(modelResults[1].content).error.code, 'tool_failed');
  assert.ok(store.db.prepare('SELECT status FROM run_steps WHERE run_id=?').all(run).every(s => s.status === 'completed'));
}));

test('Bot concurrent admission never exceeds the step budget', () => fixture(async ({ study, state, start, close }) => {
  const gate = deferred(), started = [];
  study.register(plugin('probe_read', 'read', async ({ index }) => { started.push(index); await gate.promise; return index; }, () => true));
  start(async () => batch(Array.from({ length: 6 }, (_, i) => read(i))));
  await until(() => started.length === 2);
  assert.equal(state().step_count, 2);
  gate.resolve(); await until(() => state().status === 'paused'); await close();
  assert.equal(state().error_code, 'run_step_budget'); assert.deepEqual(started, [0, 1]);
  assert.equal(JSON.parse(state().context_json).filter(m => m.role === 'tool').length, 2);
}, { maxSteps: 2 }));

test('Bot approval is reached only after reads settle, then resumes without replay', () => fixture(async ({ study, store, owner, run, service, state, start, close }) => {
  const gate = deferred(), started = [];
  study.register(plugin('probe_read', 'read', async ({ index }) => { started.push(index); await gate.promise; return index; }, () => true));
  study.register(plugin('probe_write', 'write', async () => { started.push('write'); return 'ok'; }));
  let requests = 0;
  start(async () => ++requests === 1 ? batch([read(0), read(1), ['probe_write', { index: 0 }], read(2)]) : done());
  await until(() => started.length === 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM approvals WHERE run_id=?').get(run).n, 0);
  gate.resolve(); await until(() => state().status === 'waiting_user');
  assert.deepEqual(started, [0, 1]);
  const approval = store.db.prepare("SELECT id FROM approvals WHERE run_id=? AND status='pending'").get(run);
  service.resolve(owner, approval.id, true);
  await until(() => state().status === 'completed'); await close();
  assert.deepEqual(started, [0, 1, 'write']);
  assert.equal(state().step_count, 3);
}, { write: 'ask' }));

test('Bot cancellation prevents late tool results and subsequent writes', () => fixture(async ({ study, store, run, owner, thread, service, state, start, close }) => {
  const gate = deferred(), started = [];
  study.register(plugin('probe_read', 'read', async ({ index }, c) => { started.push(index); await gate.promise; c.checkActive(); return index; }, () => true));
  study.register(plugin('probe_write', 'write', async () => { started.push('write'); return 'unexpected'; }));
  start(async () => batch([...Array.from({ length: 5 }, (_, i) => read(i)), ['probe_write', { index: 0 }]]));
  await until(() => started.length === 4);
  service.stop(owner, thread.id); gate.resolve(); await close();
  assert.equal(state().status, 'cancelled'); assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM bot_operations WHERE step_id IN (SELECT id FROM run_steps WHERE run_id=?)').get(run).n, 0);
  assert.ok(store.db.prepare('SELECT status FROM run_steps WHERE run_id=?').all(run).every(s => s.status === 'interrupted'));
}));

test('Bot drains admitted siblings before pausing on a tool timeout', () => fixture(async ({ study, state, start, close }) => {
  const gate = deferred(), started = [];
  study.register(plugin('probe_read', 'read', async ({ index }) => {
    started.push(index);
    if (index === 0) throw new BudgetBlocked('tool_timeout');
    await gate.promise; return index;
  }, () => true));
  start(async () => batch(Array.from({ length: 5 }, (_, i) => read(i))));
  await until(() => started.length === 4);
  assert.equal(state().status, 'running');
  gate.resolve(); await until(() => state().status === 'paused'); await close();
  assert.equal(state().error_code, 'tool_timeout'); assert.equal(started.length, 4);
  assert.equal(JSON.parse(state().context_json).filter(m => m.role === 'tool').length, 3);
}));

test('Bot crash recovery merges out-of-order partial results without re-executing tools', () => fixture(async ({ store, run, study, state, start, close }) => {
  const calls = [0, 1].map(i => ({ id: `local-${i}`, provider_id: `remote-${i}`, type: 'function', function: { name: 'probe_read', arguments: JSON.stringify({ index: i }) } }));
  const context = [{ role: 'system', content: 'Recover' }, { role: 'assistant', content: null, tool_calls: calls }, { role: 'tool', tool_call_id: calls[1].id, content: 'result-1' }];
  store.db.prepare("UPDATE runs SET status='running',context_json=?,step_count=2 WHERE id=?").run(JSON.stringify(context), run);
  calls.forEach((call, i) => store.db.prepare("INSERT INTO run_steps(id,run_id,tool,arguments,status,result,created_at) VALUES(?,?,?,?,'completed',?,?)").run(call.id, run, call.function.name, call.function.arguments, `result-${i}`, new Date().toISOString()));
  let executed = 0;
  study.register(plugin('probe_read', 'read', async () => { executed++; return 'replayed'; }, () => true));
  start(async (_url, init) => {
    const results = JSON.parse(init.body).messages.filter(m => m.role === 'tool');
    assert.deepEqual(results.map(r => [r.tool_call_id, r.content]), [['remote-0', 'result-0'], ['remote-1', 'result-1']]);
    return done();
  });
  await until(() => state().status === 'completed'); await close(); assert.equal(executed, 0);
}));

test('Bot read permission does not opt unknown plugins or side effects into parallelism', () => fixture(async ({ study, state, start, close }) => {
  assert.equal(study.plugins.get('study_file').parallelSafe({}), true);
  assert.equal(study.plugins.get('study_send_file').parallelSafe, undefined);
  assert.equal(study.plugins.get('study_task').parallelSafe({ action: 'cancel' }), false);
  assert.equal(study.plugins.get('study_task').parallelSafe({ action: 'status' }), true);
  const gate = deferred(), started = [];
  study.register(plugin('probe_read', 'read', async ({ index }) => { started.push(index); if (index === 0) await gate.promise; return index; }));
  let requests = 0;
  start(async () => ++requests === 1 ? batch([read(0), read(1)]) : done());
  await until(() => started.length === 1); assert.deepEqual(started, [0]);
  gate.resolve(); await until(() => state().status === 'completed'); await close();
  assert.deepEqual(started, [0, 1]);
}));
