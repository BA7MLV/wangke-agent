import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { UsageLedger, DEFAULT_BOT_BUDGET } from '../apps/api/src/agent/budget.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';

async function until(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Lifecycle timeout'); }
const batch = (...calls) => Response.json({ choices: [{ message: { tool_calls: calls.map(([name, args]) => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } });
const shell = ['shell', { command: 'sleep 1' }], message = ['send_message', { kind: 'text', text: 'LATE-NOT-ALLOWED' }];
async function fixture(test) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-lifecycle-')), store = new DatabaseStore(path.join(root, 'db.sqlite'));
  let runner;
  try {
    const owner = crypto.randomUUID(), at = new Date().toISOString();
    store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, owner, at);
    const config = new CloudConfiguration(store, path.join(root, 'config'));
    const defaults = config.get(owner, true);
    const configure = (policy = {}) => config.save(owner, { ...defaults, providers: [{ id: 'fake', name: 'Fake', baseUrl: 'https://fake.invalid/v1', protocol: 'openai-chat', apiKey: 'fake', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'fake', model: 'fake' }, botBudget: DEFAULT_BOT_BUDGET, policy: { ...defaults.policy, shell: 'allow', ...policy } });
    configure();
    const proxy = { enqueue: () => runner?.enqueue(), cancel: id => runner?.cancel(id) };
    const service = new BotApplicationService(store, proxy), thread = service.create(owner, 'bot', 'Lifecycle');
    const m = service.send(owner, thread.id, { clientNonce: 'start', content: 'Execute' });
    const run = store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(m.id).id;
    const state = () => store.db.prepare('SELECT * FROM runs WHERE id=?').get(run);
    const start = options => { runner = new BotRunner(store, { configuration: config, ...options }); runner.start(); return runner; };
    await test({ root, store, config, configure, service, thread, run, owner, state, start, close: async () => { await runner?.close(); runner = undefined; } });
  } finally { await runner?.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

for (const status of ['paused', 'cancelled']) {
  // External change while awaiting an uncooperative model; monitor must abort
  // transport and no response batch/message is allowed to commit.
  await fixture(async ({ store, run, state, start, close }) => {
    let release, started = false, aborted = false;
    start({ fetch: async (_url, init) => { started = true; init.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(resolve => { release = resolve; }); } });
    await until(() => started);
    store.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, run);
    await until(() => aborted); release(batch(shell, message)); await close();
    assert.equal(state().status, status); assert.equal(state().step_count, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM run_steps WHERE run_id=?').get(run).n, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE content='LATE-NOT-ALLOWED'").get().n, 0);
  });
  // The DB pause happens before a microtask returns, so polling alone cannot
  // pass this test: pre/post-tool guards must suppress the next serial call.
  await fixture(async ({ store, run, state, start, close }) => {
    let executed = 0;
    start({ fetch: async () => batch(shell, shell, message), sandbox: async () => { executed++; store.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, run); await Promise.resolve(); return { stdout: 'late', exitCode: 0 }; } });
    await until(() => state().status === status); await close();
    assert.equal(executed, 1); assert.equal(state().status, status); assert.equal(state().step_count, 1);
    const steps = store.db.prepare('SELECT status FROM run_steps WHERE run_id=?').all(run);
    assert.equal(steps.length, 3); assert.ok(steps.every(s => s.status === 'interrupted'));
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE content='LATE-NOT-ALLOWED'").get().n, 0);
  });
}

await fixture(async ({ store, run, owner, thread, state, service, start, close, configure }) => {
  configure({ shell: 'ask', maxSteps: 1 }); let executed = 0, modelCalls = 0;
  start({ fetch: async () => { modelCalls++; return batch(shell, shell, message); }, sandbox: async () => { executed++; return { stdout: 'approved', exitCode: 0 }; } });
  await until(() => state().status === 'waiting_user');
  assert.equal(state().step_count, 1, 'approval admission is charged before returning');
  let approval = store.db.prepare("SELECT id FROM approvals WHERE run_id=? AND status='pending'").get(run);
  service.resolve(owner, approval.id, true);
  await until(() => state().status === 'paused');
  assert.equal(state().error_code, 'run_step_budget'); assert.equal(state().step_count, 1); assert.equal(executed, 1); assert.equal(modelCalls, 1);
  assert.ok(store.db.prepare('SELECT status FROM run_steps WHERE run_id=?').all(run).every(s => ['completed', 'interrupted'].includes(s.status)), 'batch siblings cannot remain queued');
  configure({ shell: 'ask', maxSteps: 2 }); store.db.prepare("UPDATE runs SET status='queued' WHERE id=? AND status='paused'").run(run);
  // First execution may still be in finally, so wait before explicit enqueue.
  await close();
  start({ fetch: async () => { modelCalls++; return batch(shell); }, sandbox: async () => { executed++; return { stdout: 'approved again', exitCode: 0 }; } });
  await until(() => state().status === 'waiting_user'); assert.equal(state().step_count, 2);
  approval = store.db.prepare("SELECT id FROM approvals WHERE run_id=? AND status='pending'").get(run);
  service.resolve(owner, approval.id, true); await until(() => state().status === 'paused');
  assert.equal(executed, 2); assert.equal(modelCalls, 2); assert.equal(state().step_count, 2);
  assert.equal(service.stop(owner, thread.id).stopped, 1); assert.equal(state().status, 'cancelled');
  // Resume endpoint uses WHERE paused; no terminal run can be reactivated.
  assert.equal(store.db.prepare("UPDATE runs SET status='queued' WHERE id=? AND status='paused'").run(run).changes, 0);
  await close();
});

await fixture(async ({ store, run, state, start, close }) => {
  const calls = ['running', 'queued', 'missing'].map((status, i) => ({ id: `recovery-${i}`, type: 'function', function: { name: 'shell', arguments: '{"command":"must not replay"}' } }));
  const history = [{ role: 'system', content: 'recover' }, { role: 'assistant', content: null, tool_calls: calls }];
  store.db.prepare("UPDATE runs SET status='running',context_json=?,step_count=1 WHERE id=?").run(JSON.stringify(history), run);
  for (const [i, status] of ['running', 'queued'].entries()) store.db.prepare('INSERT INTO run_steps(id,run_id,tool,arguments,status,created_at) VALUES(?,?,?,?,?,?)').run(calls[i].id, run, 'shell', '{}', status, new Date().toISOString());
  let executed = 0;
  start({ sandbox: async () => { executed++; throw new Error('replay'); }, fetch: async (_url, init) => { const messages = JSON.parse(init.body).messages; for (const c of calls) assert.ok(messages.some(m => m.role === 'tool' && m.tool_call_id === c.id)); return batch(['send_message', { kind: 'text', text: 'Recovered' }]); } });
  await until(() => state().status === 'completed'); await close(); assert.equal(executed, 0); assert.equal(state().step_count, 2);
  for (const c of calls) assert.equal(store.db.prepare('SELECT status FROM run_steps WHERE id=?').get(c.id).status, 'interrupted');
});

// A transient lifecycle-monitor read failure must recover the abandoned run,
// not merely abort its request and leave status=running with no active task.
await fixture(async ({ store, run, state, start, close }) => {
  const prepare = store.db.prepare.bind(store.db);
  let inject = false, faulted = false, modelCalls = 0, aborted = false;
  const unhandled = [];
  const onRejected = error => unhandled.push(error);
  process.on('unhandledRejection', onRejected);
  store.db.prepare = sql => {
    if (inject && !faulted && sql === 'SELECT status FROM runs WHERE id=?') {
      faulted = true;
      throw new Error('simulated_monitor_db_unavailable');
    }
    return prepare(sql);
  };
  try {
    start({ fetch: async (_url, init) => {
      modelCalls++;
      if (modelCalls > 1) return batch(['send_message', { kind: 'text', text: 'Recovered after monitor read failure' }]);
      inject = true;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); }, { once: true }));
    } });
    await until(() => state().status === 'completed');
    await close();
    assert.ok(faulted && aborted);
    assert.equal(modelCalls, 2);
    assert.equal(state().step_count, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM bot_requests WHERE run_id=?').get(run).n, 2);
    assert.deepEqual(unhandled, []);
  } finally {
    store.db.prepare = prepare;
    process.off('unhandledRejection', onRejected);
  }
});

await fixture(async ({ store, run, owner }) => {
  const ledger = new UsageLedger(store), a = { owner, run, provider: 'fake', model: 'fake', purpose: 'bot' };
  for (const status of ['queued', 'paused', 'cancelled', 'failed', 'completed', 'waiting_user']) { store.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, run); assert.throws(() => ledger.reserve(a, 1, 10), /not_active/); }
  store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run); ledger.reserve(a, 1, 10);
  store.db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(run); ledger.reserve({ ...a, purpose: 'memory' }, 1, 10);
  const at = new Date().toISOString();
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at,parent_run_id) VALUES('child',?,'nonce','cards','course:course','{}','running',?,?,?)").run(owner, at, at, run);
  for (const status of ['running', 'waiting_user', 'queued', 'completed']) { store.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, run); ledger.reserve({ ...a, purpose: 'study:cards', task: 'child' }, 1, 10); }
  store.db.prepare("UPDATE runs SET status='paused' WHERE id=?").run(run);
  assert.throws(() => ledger.reserve({ ...a, purpose: 'study:cards', task: 'child' }, 1, 10), /not_active/);
});
console.log('Bot lifecycle: paused stop, model/tool pause-cancel races, serial batch isolation, persistent approval steps and crash recovery passed');

// End-to-end BotRunner -> registry -> real study tools -> optimistic records
// -> source validation/freshness. Model script consumes the actual read result.
await fixture(async ({ root, store, config, configure, owner, run, state, start, close }) => {
  configure({ read: 'allow', write: 'allow', remove: 'allow' });
  const records = new CloudRecords(store), course = { id: 'course', name: '课程', size: 0, mimeType: 'video/mp4', duration: 10, createdAt: 1, status: 'transcribed' };
  const segment = { id: 1, videoId: 'course', idx: 0, start: 0, end: 10, text: '原始教材', status: 1 };
  for (const [table, key, value] of [['videos', 'course', course], ['segments', 1, segment]]) records.apply(owner, [{ id: `seed-${table}`, table, key, before: null, after: value }]);
  const study = new StudyTools(store, config, path.join(root, 'files'));
  let turn = 0, actual;
  start({ study, fetch: async (_url, init) => {
    const messages = JSON.parse(init.body).messages;
    const result = messages.findLast(m => m.role === 'tool');
    switch (++turn) {
      case 1: return batch(['study_read', { table: 'segments', courseId: 'course' }]);
      case 2: actual = JSON.parse(result.content).records[0].value; assert.deepEqual(actual, segment); return batch(['study_memory', { action: 'save', scope: 'course', scopeId: 'course', kind: 'course_fact', content: '由原始教材得出的事实', source: 'record:segments:1' }]);
      case 3: assert.equal(JSON.parse(result.content).status, 'active'); return batch(['study_manage', { table: 'segments', key: 1, before: actual, after: { ...actual, text: '已修订教材' } }]);
      case 4: assert.ok(JSON.parse(result.content).accepted); return batch(['study_memory', { action: 'list' }]);
      case 5: assert.equal(JSON.parse(result.content)[0].status, 'stale'); return batch(['study_manage', { table: 'segments', key: 2, before: null, after: { id: 2, cues: { arbitrary: true } } }]);
      case 6: assert.ok(JSON.parse(result.content).error); return batch(['send_message', { kind: 'text', text: 'Source revision and schema verified' }]);
      default: throw new Error('unexpected turn');
    }
  } });
  await until(() => state().status === 'completed'); await close();
  assert.equal(turn, 6); assert.equal(records.get(owner, 'segments', 2), null);
  assert.equal(store.db.prepare('SELECT status FROM bot_memories WHERE owner_id=?').get(owner).status, 'stale');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM bot_requests WHERE run_id=?').get(run).n, 6);
  console.log('Bot end-to-end: actual read -> sourced fact -> study edit -> stale retrieval; malformed create has zero writes');
});
