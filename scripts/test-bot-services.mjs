import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { UsageLedger, DEFAULT_BOT_BUDGET } from '../apps/api/src/agent/budget.ts';
import { ModelClient, modelUsage, retryAfter } from '../apps/api/src/agent/model-client.ts';
import { botCalls, botReply, botRequest, responseContinuation } from '../apps/api/src/agent/model.ts';
import { BotArtifacts } from '../apps/api/src/agent/artifacts.ts';
import { ContextGovernor } from '../apps/api/src/agent/context-governor.ts';
import { BotSkills } from '../apps/api/src/agent/skills.ts';
import { BotMemory } from '../apps/api/src/agent/memory.ts';
import { MemoryWorker } from '../apps/api/src/agent/memory-worker.ts';
import { accountedFetch } from '../apps/api/src/agent/accounted-fetch.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';
import { Readable, PassThrough } from 'node:stream';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-services-'));
let store = new DatabaseStore(path.join(root, 'db.sqlite'));
try {
  const at = new Date().toISOString(), owner = 'service-owner', other = 'other-owner';
  for (const id of [owner, other]) store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, id, at);
  let configuration = new CloudConfiguration(store, path.join(root, 'config'));
  const configure = budget => configuration.save(owner, { ...configuration.get(owner, true), providers: [{ id: 'fake', name: 'Fake', baseUrl: 'https://fake.invalid/v1', protocol: 'openai-chat', apiKey: 'fake', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'fake', model: 'fake' }, botBudget: { ...DEFAULT_BOT_BUDGET, ...budget } });
  configure({ runTokens: 1000, dayTokens: 100000 });
  const service = new BotApplicationService(store, { enqueue() {} });
  const thread = service.create(owner, 'bot', 'Service regression');
  const message = service.send(owner, thread.id, { clientNonce: 'services', content: 'Keep my explicit constraint' });
  const run = store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(message.id).id;
  store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run);
  const attribution = { owner, run, purpose: 'bot', provider: 'fake', model: 'fake' };
  let ledger = new UsageLedger(store, configuration);
  const first = ledger.reserve(attribution, 1, 600);
  assert.throws(() => ledger.reserve(attribution, 2, 600), /run_token_budget/);
  ledger.settle(first, 'network_unknown');
  assert.throws(() => ledger.reserve(attribution, 2, 600), /run_token_budget/, 'unknown usage retains reservation');
  assert.throws(() => ledger.reserve({ ...attribution, owner: other }, 1, 1), /not_owned/);
  assert.throws(() => ledger.reserve(attribution, 1, -1), /invalid_request/);
  store.close(); store = new DatabaseStore(path.join(root, 'db.sqlite'));
  configuration = new CloudConfiguration(store, path.join(root, 'config'));
  ledger = new UsageLedger(store, configuration);
  assert.throws(() => ledger.reserve(attribution, 2, 600), /run_token_budget/, 'restart does not reset unknown reservations');
  configure({ runTokens: 100000, dayTokens: 1000 });
  assert.throws(() => ledger.reserve(attribution, 2, 600), /owner_daily_token_budget/);
  store.db.prepare("UPDATE bot_requests SET started_at='2000-01-01T00:00:00.000Z'").run();
  const secondStore = new DatabaseStore(path.join(root, 'db.sqlite'));
  try {
    const secondLedger = new UsageLedger(secondStore, new CloudConfiguration(secondStore, path.join(root, 'config')));
    const admissions = await Promise.allSettled([Promise.resolve().then(() => ledger.reserve(attribution, 1, 600)), Promise.resolve().then(() => secondLedger.reserve(attribution, 1, 600))]);
    assert.equal(admissions.filter(result => result.status === 'fulfilled').length, 1, 'concurrent database clients cannot over-reserve the new UTC day');
  } finally { secondStore.close(); }
  configure({ runTokens: 100000, runCost: 1 });
  assert.throws(() => ledger.reserve(attribution, 2, 10), /model_price_required/);
  configure({ runTokens: 100000, prices: [{ provider: 'fake', model: 'fake', inputPerMillion: 1, outputPerMillion: 2, source: 'test:2026-10-26' }] });
  const settled = ledger.reserve(attribution, 1, 100);
  ledger.settle(settled, 'completed', { input: 10, output: 20 });
  ledger.settle(settled, 'completed', { input: 100, output: 200 });
  assert.equal(store.db.prepare('SELECT input_tokens FROM bot_requests WHERE id=?').get(settled).input_tokens, 10);
  const priceSnapshot = ledger.reserve(attribution, 1, 100);
  configure({ runTokens: 100000, prices: [{ provider: 'fake', model: 'fake', inputPerMillion: 999, outputPerMillion: 999, source: 'new-price' }] });
  ledger.settle(priceSnapshot, 'completed', { input: 10, output: 20 });
  assert.equal(store.db.prepare('SELECT cost FROM bot_requests WHERE id=?').get(priceSnapshot).cost, 0.00005, 'settlement uses reservation price, not a later administrator edit');
  configure({ runTokens: 100000 });
  assert.equal(retryAfter('2', 0), 2000);
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:00:03 GMT', 1000), 2000);
  assert.deepEqual(modelUsage({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } }), { input: 60, output: 5, cache: 20, cacheCreation: 30 });
  const envelopes = {
    'openai-chat': { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'read', arguments: '{}' } }] } }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
    'openai-responses': { status: 'completed', output: [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'checking' }] }, { type: 'function_call', name: 'read', arguments: '{}' }], usage: { input_tokens: 1, output_tokens: 2 } },
    'anthropic-messages': { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'opaque', signature: 'signature' }, { type: 'tool_use', name: 'read', input: {} }], usage: { input_tokens: 1, output_tokens: 2 } },
  };
  for (const [protocol, envelope] of Object.entries(envelopes)) {
    let attempts = 0;
    const body = await new ModelClient(ledger, async () => ++attempts === 1 ? Response.json({}, { status: 429, headers: { 'retry-after': '0' } }) : Response.json(envelope)).request('https://fake.invalid', {}, attribution, 100);
    assert.equal(attempts, 2); assert.equal(botCalls(protocol, body)[0].function.name, 'read');
    const continuation = responseContinuation(protocol, envelope);
    const request = botRequest({ protocol }, 'fake', [{ role: 'assistant', content: botReply(protocol, envelope).text || null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }], response_items: continuation }, { role: 'tool', tool_call_id: 'call', content: '{}' }], []);
    if (protocol !== 'openai-chat') assert.ok(JSON.stringify(request).includes('opaque'));
    if (protocol === 'openai-responses') { assert.ok(JSON.stringify(request).includes('commentary')); assert.deepEqual(request.body.include, ['reasoning.encrypted_content']); assert.equal(JSON.stringify(request).split('checking').length, 2, 'visible text is not duplicated in provider continuation'); }
  }
  for (const status of [401, 402, 403]) {
    let calls = 0;
    await assert.rejects(new ModelClient(ledger, async () => { calls++; return Response.json({}, { status }); }).request('https://fake.invalid', {}, attribution, 100));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(new ModelClient(ledger, async () => { calls++; return Response.json({}, { status: 503, headers: { 'retry-after': '0' } }); }).request('https://fake.invalid', {}, attribution, 100));
  assert.equal(calls, 3);
  const controller = new AbortController(); let release;
  const late = new ModelClient(ledger, () => new Promise(resolve => { release = resolve; })).request('https://fake.invalid', { signal: controller.signal }, attribution, 100);
  controller.abort(); await assert.rejects(late); release(Response.json(envelopes['openai-chat']));
  await assert.rejects(new ModelClient(ledger, async () => new Response('{bad')).request('https://fake.invalid', {}, attribution, 100), /model_invalid_json/);
  assert.throws(() => botCalls('openai-chat', { choices: [{ finish_reason: 'length', message: { tool_calls: [] } }] }), /incomplete/);
  assert.throws(() => botCalls('anthropic-messages', { stop_reason: 'refusal' }), /incomplete/);
  assert.throws(() => botCalls('openai-responses', { status: 'incomplete' }), /incomplete/);
  const observed = accountedFetch(ledger, attribution, [{ id: 'fake', baseUrl: 'https://fake.invalid/v1' }], async () => new Response('data: {"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\ndata: [DONE]\n', { headers: { 'content-type': 'text/event-stream' } }));
  await (await observed('https://fake.invalid/v1/chat/completions', { body: '{"model":"fake"}' })).text();
  assert.ok(store.db.prepare('SELECT 1 FROM bot_requests WHERE input_tokens=3 AND output_tokens=4').get());
  for (const events of [
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":8}}}\n',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":8}}\n',
  ]) {
    const streamed = accountedFetch(ledger, attribution, [{ id: 'fake', baseUrl: 'https://fake.invalid/v1' }], async () => new Response(events, { headers: { 'content-type': 'text/event-stream' } }));
    await (await streamed('https://fake.invalid/v1/messages', { body: '{"model":"fake"}' })).text();
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM bot_requests WHERE input_tokens=7 AND output_tokens=8').get().n, 2);
  const artifacts = new BotArtifacts(store), artifact = artifacts.put(owner, run, 'evidence', 'Evidence. '.repeat(3000) + 'END');
  assert.equal(artifacts.put(owner, run, 'evidence', 'Evidence. '.repeat(3000) + 'END').artifactId, artifact.artifactId);
  assert.ok(artifacts.read(owner, artifact.artifactId, 29999, 100).text.endsWith('END'));
  assert.throws(() => artifacts.read(other, artifact.artifactId), /not_found/);
  assert.throws(() => artifacts.read(owner, artifact.artifactId, -1), /range/);
  store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run);
  const history = [{ role: 'system', content: 'System authorization' }, { role: 'user', content: 'EXPLICIT-CONSTRAINT' }];
  for (let i = 0; i < 30; i++) history.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: `c${i}`, content: 'Tool evidence '.repeat(120) });
  const view = new ContextGovernor(store).view(owner, run, history, [], 16000);
  assert.ok(JSON.stringify(view).includes('EXPLICIT-CONSTRAINT'));
  assert.ok(view.length < history.length);
  assert.deepEqual(JSON.parse(store.db.prepare('SELECT context_json FROM runs WHERE id=?').get(run).context_json), history);
  for (let i = 0; i < view.length; i++) if (view[i].role === 'tool') assert.ok(view.slice(0, i).some(m => m.tool_calls?.some(c => c.id === view[i].tool_call_id)));
  const skills = new BotSkills(store); assert.ok(skills.catalog(owner, thread.id).length >= 5);
  store.db.prepare('UPDATE threads SET skill_ids=? WHERE id=?').run('[]', thread.id);
  assert.equal(skills.catalog(owner, thread.id).length, 0); assert.throws(() => skills.load(owner, thread.id, -4), /not_available/);
  store.db.prepare('UPDATE threads SET skill_ids=? WHERE id=?').run('[-4]', thread.id);
  assert.equal(skills.catalog(owner, thread.id).length, 1); assert.ok(skills.load(owner, thread.id, -4).body);
  const memory = new BotMemory(store), input = { scope: 'owner', scopeId: '', kind: 'preference', content: 'Concise Chinese', source: 'user:test' };
  const saved = memory.save(owner, input), edited = memory.save(owner, { ...input, content: 'Detailed Chinese' }, { id: saved.id, revision: 1 });
  assert.throws(() => memory.save(owner, input, { id: saved.id, revision: 1 }), /conflict/);
  assert.throws(() => memory.get(other, saved.id), /not_found/);
  memory.remove(owner, saved.id, edited.revision);
  assert.equal(memory.context(owner, thread.id).length, 0);
  assert.throws(() => memory.save(owner, input, { origin: 'consolidated' }), /tombstoned/);
  const restored = memory.restore(owner, saved.id, 1, 3); assert.equal(restored.revision, 4); assert.equal(restored.content, input.content);
  assert.equal(memory.versions(owner, saved.id).length, 4);
  const records = new CloudRecords(store), course = { id: 'course', name: 'Biology' };
  records.apply(owner, [{ id: 'seed-course', table: 'videos', key: 'course', before: null, after: course }]);
  const revision = store.db.prepare("SELECT revision FROM cloud_records WHERE owner_id=? AND table_name='videos'").get(owner).revision;
  const fact = memory.save(owner, { scope: 'course', scopeId: 'course', kind: 'course_fact', content: 'Biology evidence', source: 'record:videos:"course"', sourceRevision: String(revision) });
  records.apply(owner, [{ id: 'edit-course', table: 'videos', key: 'course', before: course, after: { ...course, name: 'New Biology' } }]);
  memory.list(owner); assert.equal(memory.get(owner, fact.id).status, 'stale');
  store.db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(run);
  store.db.prepare('INSERT INTO bot_memory_jobs(owner_id,enabled,token_budget,interval_seconds) VALUES(?,1,10000,60)').run(owner);
  const cursor = () => store.db.prepare('SELECT cursor FROM bot_memory_jobs WHERE owner_id=?').get(owner).cursor;
  const worker = new MemoryWorker(store, configuration, async () => Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'consolidate_memory', arguments: '{"preferences":["Worker preference"]}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  configuration.save(owner, { ...configuration.get(owner, true), policy: { ...configuration.get(owner).policy, read: 'allow', write: 'allow' } });
  configuration.save(owner, { ...configuration.get(owner, true), policy: { ...configuration.get(owner).policy, read: 'ask', write: 'ask' } });
  const approvalCount = store.db.prepare('SELECT COUNT(*) n FROM approvals').get().n;
  await worker.tick(); assert.ok(cursor()); assert.ok(memory.list(owner).some(m => m.content === 'Worker preference'));
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM approvals').get().n, approvalCount, 'opt-in consolidation writes without approval, even with ask policies');
  assert.equal(store.db.prepare("SELECT 1 FROM cloud_permissions WHERE json_extract(arguments,'$.tool')='consolidate_memory'").get(), undefined);
  store.db.prepare('INSERT INTO bot_memory_jobs(owner_id,enabled,token_budget,interval_seconds) VALUES(?,1,10000,60)').run(other);
  await worker.tick();
  assert.ok(store.db.prepare('SELECT next_at FROM bot_memory_jobs WHERE owner_id=?').get(other).next_at > 0, 'consolidation does not starve another owner');
  store.db.prepare('UPDATE bot_memory_jobs SET enabled=0 WHERE owner_id=?').run(other);
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(run).status, 'completed', 'background writes do not replay their completed source run');
  await worker.close();
  const restartedWorker = new MemoryWorker(store, configuration, async () => { throw new Error('committed cursor must survive restart'); });
  store.db.prepare('UPDATE bot_memory_jobs SET next_at=0 WHERE owner_id=?').run(owner);
  await restartedWorker.tick(); assert.ok(cursor()); assert.ok(memory.list(owner).some(m => m.content === 'Worker preference'));
  await restartedWorker.close();
  store.db.prepare('UPDATE bot_memory_jobs SET cursor=NULL,next_at=0 WHERE owner_id=?').run(owner);
  const committedCount = memory.list(owner).length;
  const replayWorker = new MemoryWorker(store, configuration, async () => Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'consolidate_memory', arguments: '{"preferences":["Worker preference"]}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  await replayWorker.tick(); await replayWorker.close();
  assert.equal(memory.list(owner).length, committedCount, 'reprocessing the same source does not duplicate memories');
  const resetJob = () => {
    store.db.prepare('UPDATE bot_memory_jobs SET cursor=NULL,next_at=0,enabled=1 WHERE owner_id=?').run(owner);
  };
  resetJob();
  const atomicWorker = new MemoryWorker(store, configuration, async () => Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'consolidate_memory', arguments: '{"preferences":["First atomic preference","Second atomic preference"]}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  const atomicCount = memory.list(owner).length;
  const write = store.systemFiles.write;
  store.systemFiles.write = function (owner, resource, content, expected) { if (content === 'Second atomic preference') throw new Error('simulated_memory_write'); return write.call(this, owner, resource, content, expected); };
  try { await atomicWorker.tick(); } finally { store.systemFiles.write = write; }
  assert.equal(cursor(), null, 'failed batches roll back the cursor');
  assert.equal(memory.list(owner).length, atomicCount, 'failed batches have no partial memory writes');
  store.db.prepare('UPDATE bot_memory_jobs SET next_at=0 WHERE owner_id=?').run(owner);
  await atomicWorker.tick(); await atomicWorker.close();
  assert.equal(memory.list(owner).length, atomicCount + 2);
  resetJob();
  for (const mode of ['revoke', 'read_revoke', 'source_change', 'disable', 'archive', 'tombstone', 'cancel']) {
    const content = `Must not save ${mode}`, count = memory.list(owner).length;
    const summaryId = store.db.prepare('SELECT id FROM bot_summaries WHERE run_id=? ORDER BY rowid LIMIT 1').get(run).id;
    const original = store.db.prepare('SELECT content FROM bot_summaries WHERE id=?').get(summaryId).content;
    const guarded = new MemoryWorker(store, configuration, async () => {
      await Promise.resolve();
      if (mode === 'revoke' || mode === 'read_revoke') configuration.save(owner, { ...configuration.get(owner, true), policy: { ...configuration.get(owner).policy, [mode === 'revoke' ? 'write' : 'read']: 'deny' } });
      if (mode === 'source_change') store.db.prepare('UPDATE bot_summaries SET content=? WHERE id=?').run(`${original} changed`, summaryId);
      if (mode === 'disable') store.db.prepare('UPDATE bot_memory_jobs SET enabled=0 WHERE owner_id=?').run(owner);
      if (mode === 'archive') store.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(thread.id);
      if (mode === 'tombstone') { const m = memory.save(owner, { scope: 'owner', scopeId: '', kind: 'preference', content, source: `message:${message.id}` }); memory.remove(owner, m.id, m.revision); }
      if (mode === 'cancel') guarded.cancel(owner);
      return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'consolidate_memory', arguments: JSON.stringify({ preferences: [content] }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    });
    await guarded.tick(); await guarded.close();
    assert.equal(memory.list(owner).length, count, `${mode} prevents background system writes`);
    if (mode !== 'tombstone') assert.equal(cursor(), null, `${mode} does not advance the cursor`);
    configuration.save(owner, { ...configuration.get(owner, true), policy: { ...configuration.get(owner).policy, read: 'allow', write: 'allow' } });
    store.db.prepare('UPDATE threads SET archived=0 WHERE id=?').run(thread.id);
    if (mode === 'source_change') store.db.prepare('UPDATE bot_summaries SET content=? WHERE id=?').run(original, summaryId);
    resetJob();
  }
  store.db.prepare('UPDATE bot_memory_jobs SET cursor=NULL,next_at=0 WHERE owner_id=?').run(owner);
  const countBefore = memory.list(owner).length;
  const failingWorker = new MemoryWorker(store, configuration, async () => Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'consolidate_memory', arguments: '{"preferences":["must roll back",""]}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  await failingWorker.tick(); await failingWorker.close();
  assert.equal(cursor(), null, 'invalid proposals do not advance the consolidation cursor');
  assert.equal(memory.list(owner).length, countBefore, 'invalid proposals have zero memory writes');
  const files = path.join(root, 'files'); fs.mkdirSync(files);
  const operation = '12345678-1234-1234-1234-123456789abc';
  const stream = new PassThrough();
  const upload = receiveFile(store, files, owner, stream, 'stable.txt', 'text/plain', 100, undefined, () => {}, operation);
  await assert.rejects(receiveFile(store, files, owner, Readable.from(['duplicate']), 'stable.txt', 'text/plain', 100, undefined, () => {}, operation), /inflight/);
  stream.end('stable evidence'); const file = await upload;
  assert.equal((await receiveFile(store, files, owner, Readable.from(['duplicate']), 'stable.txt', 'text/plain', 100, undefined, () => {}, operation)).id, file.id);
  assert.equal(fs.readFileSync(path.join(files, `${operation}.bin`), 'utf8'), 'stable evidence');
  await assert.rejects(receiveFile(store, files, other, Readable.from(['forged']), 'forged.txt', 'text/plain', 100, undefined, () => {}, operation), /not_owned/);
  await assert.rejects(receiveFile(store, files, owner, Readable.from(['revoked']), 'revoked.txt', 'text/plain', 100, undefined, () => { throw new Error('revoked_at_commit'); }), /revoked/);
  assert.equal(fs.readdirSync(files).length, 1, 'revocation after file rename leaves no new owned file or orphan');
  const recoveredService = new BotApplicationService(store, { enqueue() {} });
  recoveredService.append(thread.id, 'assistant', 'text', 'stable message', 'stable-operation');
  recoveredService.append(thread.id, 'assistant', 'text', 'stable message', 'stable-operation');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE client_nonce='stable-operation'").get().n, 1);
  console.log('Bot services passed: durable/unknown ledger, prices, protocols/retries/cancellation, SSE, artifacts, context pairs, skill scope, memory revisions/tombstones, autonomous opt-in consolidation, restart/revocation/source/cancellation checks and atomic consolidation cursor.');
} finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
