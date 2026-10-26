import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudTaskRunner } from '../apps/api/src/cloud/tasks.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';
import { BotMemory } from '../apps/api/src/agent/memory.ts';
import { DEFAULT_BOT_BUDGET } from '../apps/api/src/agent/budget.ts';

const real = process.argv.includes('--real');
if (real && (process.env.BOT_EVAL_REAL !== '1' || !process.env.BOT_EVAL_CONFIG || !(Number(process.env.BOT_EVAL_MAX_COST) > 0))) throw new Error('Real evaluation requires BOT_EVAL_REAL=1, BOT_EVAL_CONFIG and a separate BOT_EVAL_MAX_COST');
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/bot-learning.json', import.meta.url), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-evaluation-'));
const results = [];
const configured = real ? JSON.parse(fs.readFileSync(process.env.BOT_EVAL_CONFIG, 'utf8')) : undefined;
if (real && !configured.botBudget?.prices?.length) throw new Error('Real evaluation requires administrator model prices; unknown prices cannot enforce a cost cap');
const repeats = real ? 3 : 1;
const until = async fn => { const deadline = Date.now() + (real ? 180000 : 20000); while (!fn()) { if (Date.now() > deadline) throw new Error('evaluation_timeout'); await new Promise(r => setTimeout(r, 10)); } };
for (const fixture of fixtures) for (let repeat = 1; repeat <= repeats; repeat++) {
  const directory = path.join(root, `${fixture.id}-${repeat}`); fs.mkdirSync(path.join(directory, 'files'), { recursive: true });
  const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  let runner, children;
  const started = Date.now();
  try {
    const owner = crypto.randomUUID(), at = new Date().toISOString();
    store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, 'Evaluation only', at);
    const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
    const defaults = configuration.get(owner, true);
    configuration.save(owner, { ...(configured ?? defaults), providers: configured?.providers ?? [{ id: 'offline', name: 'Offline fake — not quality evaluation', baseUrl: 'https://offline.invalid/v1', protocol: 'openai-chat', apiKey: 'not-real', catalogId: '', serves: ['chat'] }], llmModel: configured?.llmModel ?? { providerId: 'offline', model: 'scripted' }, policy: { ...defaults.policy, read: 'allow', write: 'allow', remove: 'deny', ...fixture.policy }, botBudget: { ...DEFAULT_BOT_BUDGET, ...configured?.botBudget, ...(real ? { runCost: Number(process.env.BOT_EVAL_MAX_COST) / (fixtures.length * repeats) } : {}), ...(fixture.tinyBudget ? { runTokens: 100 } : {}) } });
    const records = new CloudRecords(store), course = { id: 'course-a', name: 'Biology' };
    const seed = (table, key, after) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: null, after }]);
    seed('videos', 'course-a', course);
    for (let id = 1; id <= 3; id++) seed('segments', id, { id, videoId: 'course-a', idx: id - 1, start: (id - 1) * 30, end: id * 30, text: 'A cell is the basic unit of life. Mitochondria produce energy.', status: 1 });
    seed('materialBlocks', 10, { id: 10, materialId: 'course-a', idx: 0, unit: 1, unitLabel: 'p1', text: `${'Biology evidence. '.repeat(900)}END-EVIDENCE-42`, kind: 'body' });
    if (fixture.seedMemory) new BotMemory(store).save(owner, { scope: 'owner', scopeId: '', kind: 'preference', content: 'Prefers Chinese explanations', source: 'user:evaluation' });
    const recordSnapshot = () => Object.fromEntries(store.db.prepare('SELECT table_name,record_key,value FROM cloud_records WHERE owner_id=? ORDER BY table_name,record_key').all(owner).map(row => [`${row.table_name}:${row.record_key}`, row.value]));
    const beforeRecords = recordSnapshot();
    let turn = 0;
    const value = input => {
      if (Array.isArray(input)) return input.map(value);
      if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, value(v)]));
      if (input === '@course') return course;
      if (input === '@future') return new Date(Date.now() + 3600000).toISOString();
      if (input === '@task') return store.db.prepare('SELECT id FROM cloud_tasks ORDER BY created_at DESC LIMIT 1').get()?.id;
      if (input === '@artifact') return store.db.prepare('SELECT id FROM bot_artifacts ORDER BY created_at DESC LIMIT 1').get()?.id;
      return input;
    };
    const fake = async (_url, init) => {
      if (fixture.waitChild && turn >= 1 && !store.db.prepare("SELECT 1 FROM cloud_tasks WHERE status IN ('completed','failed','cancelled')").get()) return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'wait', arguments: JSON.stringify({ seconds: 1, reason: 'Wait for actual child result' }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
      const [name, args] = fixture.calls[turn++] ?? ['send_message', { kind: 'text', text: 'Evaluation turn completed; consult persisted evidence.' }];
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name, arguments: JSON.stringify(value(args)) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
    };
    const study = new StudyTools(store, configuration, path.join(directory, 'files'), real ? fetch : fake);
    runner = new BotRunner(store, { configuration, study, fetch: real ? fetch : fake });
    const service = new BotApplicationService(store, runner), thread = service.create(owner, 'bot', fixture.id);
    if (fixture.disableSkills) store.db.prepare('UPDATE threads SET skill_ids=? WHERE id=?').run('[]', thread.id);
    const message = service.send(owner, thread.id, { clientNonce: fixture.id, content: fixture.goal });
    children = new CloudTaskRunner(store, { configuration, filesDir: path.join(directory, 'files'), fetch: real ? fetch : async (_url, init) => Response.json({ choices: [{ message: { content: JSON.stringify(JSON.parse(init.body).messages).includes('<course_source>') ? '# Biology\nA cell is the basic unit of life.\n## Review\nWhat is a cell?' : '[{"time":"00:00","q":"What is a cell?","a":"Basic unit of life"}]' } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }) });
    children.start('http://127.0.0.1:1'); runner.start();
    await until(() => ['completed', 'failed', 'paused', 'waiting_user'].includes(store.db.prepare('SELECT status FROM runs WHERE trigger_message_id=?').get(message.id)?.status));
    const run = store.db.prepare('SELECT * FROM runs WHERE trigger_message_id=?').get(message.id);
    const evidence = store.db.prepare('SELECT tool,status,result FROM run_steps WHERE run_id=?').all(run.id);
    const allEvidence = JSON.stringify(evidence), check = fixture.check;
    if (check.kind === 'paused') assert.equal(run.status, 'paused'); else assert.equal(run.status, 'completed');
    if (['evidence', 'skill'].includes(check.kind)) assert.ok(allEvidence.includes(check.text));
    if (check.kind === 'record') { const record = records.get(owner, check.table, check.key); if ('equals' in check) assert.equal(record?.[check.field], check.equals); else assert.ok(String(record?.[check.field]).includes(check.contains)); }
    if (check.kind === 'generated') assert.ok(store.db.prepare('SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND value IS NOT NULL').all(owner, check.table).some(r => r.value.toLowerCase().includes(check.text)));
    if (check.kind === 'child-file') { const child = store.db.prepare("SELECT result FROM cloud_tasks WHERE status='completed'").get(); assert.ok(child); assert.ok(store.db.prepare('SELECT 1 FROM files WHERE owner_id=?').get(owner)); }
    if (check.kind === 'file') { const file = store.db.prepare('SELECT * FROM files WHERE owner_id=? AND original_name=?').get(owner, check.name); assert.ok(file); assert.ok(fs.readFileSync(path.join(directory, 'files', file.storage_name), 'utf8').includes(check.text)); }
    if (check.kind === 'reminder') assert.equal(store.db.prepare("SELECT text FROM bot_reminders WHERE owner_id=? AND status='active'").get(owner)?.text, check.text);
    if (check.kind === 'memory') assert.ok(new BotMemory(store).list(owner).some(m => m.content.includes(check.text)));
    if (check.kind === 'no-mutation') assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM cloud_operations').get().n, 5);
    if (check.kind === 'repair') { assert.ok(real || allEvidence.includes('invalid_arguments')); assert.ok(allEvidence.includes('Biology')); }
    if (check.kind === 'artifact') { assert.ok(store.db.prepare('SELECT content FROM bot_artifacts WHERE owner_id=?').all(owner).some(a => a.content.includes(check.text))); assert.ok(allEvidence.includes(check.text)); }
    const afterRecords = recordSnapshot();
    const changed = [...new Set([...Object.keys(beforeRecords), ...Object.keys(afterRecords)])].filter(key => beforeRecords[key] !== afterRecords[key]);
    const allowedTables = check.kind === 'record' || check.kind === 'generated' ? [check.table] : check.kind === 'child-file' ? ['handouts', 'frames'] : [];
    const misModifications = changed.filter(key => !allowedTables.includes(key.split(':')[0]));
    assert.deepEqual(misModifications, [], 'No unrelated learning record modifications');
    const usage = store.db.prepare('SELECT COUNT(*) AS requests,SUM(input_tokens+output_tokens) AS tokens,SUM(cost) AS cost,SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unknownCostRequests,SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS unknownUsageRequests FROM bot_requests WHERE owner_id=?').get(owner);
    const toolErrors = evidence.filter(e => /invalid_arguments|tool_failed|Denied by/.test(e.result ?? '')).length;
    results.push({ fixture: fixture.id, repeat, mode: real ? 'real' : 'offline-scripted', passed: true, elapsedMs: Date.now() - started, usage, metrics: { changedRecords: changed.length, misModifications: misModifications.length, toolErrors, verifiedCriterion: check.kind }, evidence: evidence.map(e => ({ tool: e.tool, status: e.status })) });
  } catch (error) {
    const usage = store.db.prepare('SELECT COUNT(*) AS requests,SUM(input_tokens+output_tokens) AS tokens,SUM(cost) AS cost,SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unknownCostRequests,SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS unknownUsageRequests FROM bot_requests').get();
    results.push({ fixture: fixture.id, repeat, mode: real ? 'real' : 'offline-scripted', passed: false, elapsedMs: Date.now() - started, usage, error: error instanceof Error ? error.message : 'evaluation_failed' });
  }
  finally { await children?.close(); await runner?.close(); store.close(); }
}
const output = process.env.BOT_EVAL_OUTPUT ?? path.join(root, 'results.json');
fs.writeFileSync(output, JSON.stringify({ mode: real ? 'real' : 'offline-scripted', realQualityRun: real, rubric: 'Verify persisted data/files/references. Handout factual accuracy, coverage and teaching clarity require human review (0–4 each). Scripted completion is not model quality.', results }, null, 2));
console.log(`${real ? 'REAL' : 'OFFLINE SCRIPTED (not model quality)'}: ${results.filter(r => r.passed).length}/${results.length}. Results: ${output}`);
for (const result of results.filter(r => !r.passed)) console.error(result.fixture, result.error);
if (results.some(r => !r.passed)) process.exitCode = 1;
