import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { registerCloudRoutes } from '../apps/api/src/cloud/routes.ts';
import { modelUsageReport } from '../apps/api/src/agent/model-observations.ts';
import { accountedFetch } from '../apps/api/src/agent/accounted-fetch.ts';
import { UsageLedger } from '../apps/api/src/agent/budget.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';

const temporary = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(temporary, { recursive: true });
const root = fs.mkdtempSync(path.join(temporary, 'usage-report-'));
const dbPath = path.join(root, 'db.sqlite');
let store = new DatabaseStore(dbPath), app;
const since = '2026-10-28T00:00:00.000Z', until = '2026-10-30T00:00:00.000Z';
try {
  for (const id of ['owner', 'other', 'empty']) store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, id, since);
  const insert = (source, id, at, usage = {}, options = {}) => {
    const values = [id, options.owner ?? 'owner', options.provider ?? 'p', options.model ?? 'm', at, options.status ?? 'completed', usage.input ?? null, usage.output ?? null, usage.cache ?? null, usage.write ?? null, usage.reasoning ?? null];
    if (source === 'bot') store.db.prepare(`INSERT INTO bot_requests(id,owner_id,provider,model,started_at,status,input_tokens,output_tokens,cache_tokens,cache_creation_tokens,reasoning_tokens,purpose,attempt,reserved_tokens,task_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'study:cards',1,999999,?)`).run(...values, options.task ?? null);
    else store.db.prepare('INSERT INTO model_observations(id,owner_id,provider,model,started_at,status,input_tokens,output_tokens,cache_tokens,cache_creation_tokens,reasoning_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...values);
  };
  insert('chat', 'before', '2026-10-27T23:59:59.999Z', { input: 999999, output: 1 });
  insert('chat', 'a', since, { input: 1000, output: 100, cache: 800, write: 100, reasoning: 40 });
  insert('chat', 'b', '2026-10-28T12:00:00.000Z', { input: 500, output: 50 });
  insert('bot', 'c', '2026-10-29T00:00:00.000Z', { input: 2000, output: 200, cache: 1000, write: 0, reasoning: 80 }, { task: 'child-task' });
  insert('bot', 'inflight', '2026-10-29T01:00:00.000Z', {}, { status: 'inflight' });
  insert('chat', 'failed', '2026-10-29T02:00:00.000Z', {}, { status: 'http_429' });
  insert('chat', 'zero', '2026-10-29T03:00:00.000Z', { input: 0, output: 0, cache: 0, write: 0, reasoning: 0 });
  insert('chat', 'different-provider', '2026-10-29T04:00:00.000Z', { input: 100, output: 10, cache: 0, reasoning: 0 }, { provider: 'p2' });
  insert('chat', 'partial', '2026-10-29T05:00:00.000Z', { output: 7, cache: 3 }, { model: 'partial' });
  insert('bot', 'after', until, { input: 999999, output: 1 });
  insert('bot', 'other-owner', since, { input: 888888, output: 1 }, { owner: 'other' });
  const report = modelUsageReport(store, 'owner', since, { until });
  const counts = report.total;
  assert.equal(counts.requests, 8);
  assert.equal(counts.measuredRequests, 5, 'a partial legacy row is not full measured usage');
  assert.equal(counts.inputMeasuredRequests, 5); assert.equal(counts.outputMeasuredRequests, 6);
  assert.equal(counts.inflightRequests, 1);
  assert.equal(counts.inputTokens, 3600); assert.equal(counts.outputTokens, 367);
  assert.equal(counts.totalTokens, 3967, 'no reservation, cache or reasoning double counting');
  assert.equal(counts.cacheReadTokens, 1803); assert.equal(counts.cacheWriteTokens, 100);
  assert.equal(counts.reasoningTokens, 120);
  assert.equal(counts.cacheMeasuredRequests, 5); assert.equal(counts.cacheWriteMeasuredRequests, 3);
  assert.equal(counts.reasoningMeasuredRequests, 4);
  assert.equal(counts.cacheMeasuredInputTokens, 3100);
  assert.equal(counts.cacheHitRate, 1800 / 3100, 'weighted over matching input/cache pairs, not all requests or mean rates');
  assert.equal(report.byModel.length, 3, 'legacy combined groups remain combined across sources');
  assert.equal(report.bySourceModel.length, 4, 'same provider/model stays separate for Chat and Bot');
  assert.deepEqual(report.bySource.map(row => [row.source, row.requests]), [['bot', 2], ['chat', 6]]);
  assert.deepEqual(report.byDay.map(row => [row.date, row.source, row.requests]), [['2026-10-28', 'chat', 2], ['2026-10-29', 'bot', 2], ['2026-10-29', 'chat', 4]]);
  assert.equal(report.byDayModel.find(row => row.source === 'bot').requests, 2, 'child task stays in Bot exactly once');
  for (const key of ['byModel', 'bySource', 'bySourceModel', 'byDay', 'byDayModel']) {
    for (const field of ['requests', 'measuredRequests', 'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      assert.equal(report[key].reduce((sum, row) => sum + row[field], 0), counts[field], `${key}.${field} reconciles`);
    }
  }
  const bot = modelUsageReport(store, 'owner', since, { until, source: 'bot' });
  assert.equal(bot.total.requests, 2); assert.equal(bot.total.totalTokens, 2200);
  assert.ok(bot.byDayModel.every(row => row.source === 'bot'));
  const empty = modelUsageReport(store, 'empty', since, { until });
  assert.equal(empty.total.requests, 0); assert.equal(empty.total.inflightRequests, 0);
  assert.equal(empty.total.cacheHitRate, null); assert.deepEqual(empty.byDay, []);
  const unknown = modelUsageReport(store, 'owner', '2026-10-29T01:00:00.000Z', { until: '2026-10-29T03:00:00.000Z' });
  assert.equal(unknown.total.measuredRequests, 0); assert.equal(unknown.total.cacheHitRate, null);
  assert.equal(unknown.total.totalTokens, 0, 'zero known subtotal does not claim measured zero');
  const zero = modelUsageReport(store, 'owner', '2026-10-29T03:00:00.000Z', { until: '2026-10-29T04:00:00.000Z' });
  assert.equal(zero.total.measuredRequests, 1); assert.equal(zero.total.cacheMeasuredRequests, 1);
  assert.equal(zero.total.cacheHitRate, null, 'zero denominator is unknown, not NaN');
  const RealDate = globalThis.Date;
  try {
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [until])); }
      static now() { return RealDate.parse(until); }
    };
    assert.equal(modelUsageReport(store, 'owner', since).total.requests, 9, 'default rolling window includes requests started in the current millisecond');
  } finally { globalThis.Date = RealDate; }
  store.close(); store = new DatabaseStore(dbPath);
  assert.deepEqual(modelUsageReport(store, 'owner', since, { until }).total, counts, 'SQLite survives reopening without an auxiliary JSON store');

  app = Fastify();
  registerCloudRoutes(app, { store, records: new CloudRecords(store), configuration: new CloudConfiguration(store, path.join(root, 'config')),
    requireAuth(request, reply) { const id = request.headers['x-owner']; if (!['owner', 'other', 'empty'].includes(id)) { reply.code(401).send({ error: 'unauthorized' }); return null; } return { id }; },
    checkOrigin: () => true, filesDir: root, maxFileBytes: 1000 });
  const get = (query, owner = 'owner') => app.inject({ url: `/api/v1/cloud/model-usage${query}`, headers: { 'x-owner': owner } });
  assert.equal((await app.inject('/api/v1/cloud/model-usage')).statusCode, 401);
  const response = await get('?start=2026-10-28&end=2026-10-29');
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json().total, counts); assert.equal(response.json().until, until);
  assert.equal((await get('?start=2026-10-28&end=2026-10-29&source=bot')).json().total.requests, 2);
  assert.equal((await get('?start=2026-10-28&end=2026-10-29&source=chat')).json().total.requests, 6);
  assert.equal((await get('?start=2026-10-28&end=2026-10-29', 'other')).json().total.requests, 1);
  assert.equal((await get('?start=2026-10-28&end=2026-10-28')).json().total.requests, 2, 'inclusive single day');
  assert.equal((await get('?start=2024-02-29&end=2024-02-29')).statusCode, 200, 'leap day');
  assert.equal((await get('?start=2026-01-01&end=2026-03-31')).statusCode, 200, '90-day boundary');
  for (const query of ['', '?days=1', '?days=90', '?source=chat']) assert.equal((await get(query)).statusCode, 200);
  for (const query of ['?days=0', '?days=91', '?days=NaN', '?days=1.5', '?days=', '?days=1&days=2', '?source=unknown', '?source=chat&source=bot',
    '?start=2026-10-28', '?end=2026-10-29', '?start=2026-10-29&end=2026-10-28', '?start=2026-02-30&end=2026-03-01', '?start=2026-1-01&end=2026-01-02',
    '?start=2026-01-01&end=2026-04-01', '?start=2026-01-01&end=2026-01-01&days=1', '?start=garbage&end=garbage', '?start=2026-10-28&start=2026-10-29&end=2026-10-29']) {
    assert.equal((await get(query)).statusCode, 400, query);
  }
  console.log('PASS: SQLite source/date/model aggregates, NULL/zero/partial usage, weighted cache/reasoning, owner isolation, restart, boundaries and API validation');

  const service = new BotApplicationService(store, { enqueue() {} });
  const thread = service.create('owner', 'bot', 'Usage attribution');
  const message = service.send('owner', thread.id, { clientNonce: 'usage-test', content: 'Count once' });
  const run = store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(message.id).id;
  store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run);
  const ledger = new UsageLedger(store);
  const providers = [{ id: 'p', baseUrl: 'https://fake.invalid/v1' }];
  const fetcher = async () => Response.json({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens_details: { reasoning_tokens: 2 } } });
  const request = { body: '{"model":"m"}' };
  const beforeChat = store.db.prepare('SELECT COUNT(*) n FROM model_observations').get().n;
  const beforeBot = store.db.prepare('SELECT COUNT(*) n FROM bot_requests').get().n;
  await accountedFetch(ledger, { owner: 'owner', purpose: 'chat' }, providers, fetcher)('https://fake.invalid/v1/messages', request);
  await accountedFetch(ledger, { owner: 'owner', run, purpose: 'study:cards' }, providers, fetcher)('https://fake.invalid/v1/messages', request);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM model_observations').get().n, beforeChat + 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM bot_requests').get().n, beforeBot + 1);
  assert.equal(store.db.prepare('SELECT input_tokens n FROM bot_requests WHERE run_id=?').get(run).n, 60, 'Anthropic input includes cache read/write once');
  console.log('PASS: actual ordinary and Bot accountedFetch each persist once, with normalized cache-inclusive input');
} finally { await app?.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
