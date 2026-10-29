import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { modelUsage, usageCollector, summarizeUsage } from '../packages/study-core/src/api/usage.ts';
import { chatOnce, chatStream, requestBody } from '../packages/study-core/src/api/modelClient.ts';
import { applyPromptCache } from '../packages/study-core/src/api/promptCache.ts';
import { PROMPTS } from '../packages/study-core/src/harness/prompts.ts';
import { botRequest, botReply, responseContinuation } from '../apps/api/src/agent/model.ts';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { observeModelFetch, modelUsageReport } from '../apps/api/src/agent/model-observations.ts';
import { registerCloudRoutes } from '../apps/api/src/cloud/routes.ts';

assert.deepEqual(modelUsage({ usage: { input_tokens: 1000, output_tokens: 30, input_tokens_details: { cached_tokens: 800 }, output_tokens_details: { reasoning_tokens: 20 } } }), { input: 1000, output: 30, cache: 800, reasoning: 20 });
assert.deepEqual(modelUsage({ usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 } }), { input: 1000, output: 30, cache: 800, cacheCreation: 100 });
assert.deepEqual(modelUsage({ usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: null, cache_creation_input_tokens: null } }), { input: 100, output: 30 });
assert.equal(modelUsage({ usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 101 } } }), undefined);
const collected = usageCollector();
collected.observe({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 } } });
collected.observe({ type: 'message_delta', usage: { output_tokens: 20 } });
collected.observe({ type: 'message_delta', usage: { output_tokens: 30 } });
assert.deepEqual(collected.value, { input: 1000, output: 30, cache: 800, cacheCreation: 100 });
const summary = summarizeUsage([{ usage: { input: 100, output: 5, cache: 50 } }, { usage: { input: 900, output: 2, cache: 900 } }, { usage: { input: 5000, output: 8 } }, {}]);
assert.equal(summary.cacheHitRate, .95); assert.equal(summary.cacheMeasuredRequests, 2); assert.equal(summary.lastRequest, undefined);
assert.equal(summary.cacheWriteMeasuredRequests, 0, 'unknown writes must not be displayed as measured zero');
console.log('Usage: three protocols, nullable/unknown fields, cumulative SSE, weighted hit rate and latest-request semantics passed');

const systems = [{ role: 'system', content: 'Shared instructions' }, { role: 'system', content: 'Versioned preferences' }];
const tools = ['zebra', 'alpha'].map(name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'number' } } } } }));
const user = { role: 'user', content: 'Question' };
const target = { providerId: 'p', apiKey: '', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses', model: 'gpt-5.6' };
const options = { messages: [...systems, user], tools, cacheKey: 'session-key' };
const req = requestBody(target, options, options.messages, true);
assert.deepEqual(req.prompt_cache_options, { mode: 'implicit' });
assert.equal(req.prompt_cache_key, 'session-key');
assert.equal(req.input[0].content[0].prompt_cache_breakpoint.mode, 'explicit');
assert.deepEqual(req.tools.map(t => t.name), ['alpha', 'zebra']);
assert.deepEqual(requestBody(target, { ...options, tools: tools.toReversed() }, options.messages, true), req);
const older = requestBody({ ...target, model: 'gpt-4.1' }, options, options.messages, true);
assert.equal(older.prompt_cache_options, undefined); assert.equal(older.prompt_cache_key, 'session-key');
for (const baseUrl of ['https://compatible.test/v1', 'https://api.openai.com.evil.test/v1', 'http://api.openai.com/v1']) {
  const unknown = requestBody({ ...target, baseUrl }, options, options.messages, true);
  assert.equal(unknown.prompt_cache_key, undefined); assert.equal(unknown.prompt_cache_options, undefined);
}
const chat = requestBody({ ...target, protocol: 'openai-chat' }, options, options.messages, true);
assert.deepEqual(chat.stream_options, { include_usage: true });
assert.equal(applyPromptCache({ input: 'hello' }, target).input, 'hello', 'Responses shorthand input is valid');
assert.equal(applyPromptCache({ messages: [] }, { ...target, protocol: undefined }).prompt_cache_options, undefined);
const anth = { ...target, baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-6', protocol: 'anthropic-messages' };
const aReq = requestBody(anth, options, options.messages, true);
assert.equal(aReq.cache_control.type, 'ephemeral'); assert.equal(aReq.system[0].cache_control.type, 'ephemeral');
assert.equal(aReq.prompt_cache_key, undefined);
assert.equal(applyPromptCache({ ...req, input: [] }, { ...target, model: 'unknown' }).prompt_cache_options, req.prompt_cache_options); // unknown routes add nothing
assert.equal(PROMPTS.qaSystem('课程 A', 'skill', false, 0, 0), PROMPTS.qaSystem('课程 B', 'skill', false, 3, 2));
console.log('Wire: audited endpoint/model policies, deterministic schemas, separate stable system blocks and dynamic course context passed');

const nativeBodies = [
  [anth, { content: [{ type: 'thinking', thinking: 'private', signature: 'signed' }, { type: 'text', text: 'Read now' }, { type: 'tool_use', id: 'native-call', name: 'alpha', input: { a: 1 } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } }],
  [target, { output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted', summary: [] }, { type: 'function_call', id: 'fc_1', call_id: 'native-call', name: 'alpha', arguments: '{"a":1}', status: 'completed' }, { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Read now', annotations: [] }], status: 'completed' }], status: 'completed', usage: { input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 900 } } }],
];
for (const [t, body] of nativeBodies) {
  const records = [];
  const reply = await chatOnce(t, { ...options, onRequest: record => records.push(record) }, async () => Response.json(body));
  const stored = JSON.parse(JSON.stringify(reply));
  const messages = [...options.messages, stored, { role: 'tool', tool_call_id: 'native-call', content: 'source evidence' }];
  const wire = requestBody(t, options, messages, false);
  const native = t.protocol === 'anthropic-messages' ? body.content : body.output;
  if (t.protocol === 'anthropic-messages') assert.deepEqual(wire.messages[1].content, native);
  else assert.deepEqual(wire.input.slice(options.messages.length, -1), native);
  assert.equal(records.length, 1); assert.equal(records[0].usage.cache, 900);
  const switched = requestBody({ ...t, baseUrl: 'https://another.test/v1' }, options, messages, false);
  assert.ok(!JSON.stringify(switched).includes('"encrypted"'), 'opaque reasoning must not cross endpoints'); assert.ok(!JSON.stringify(switched).includes('signed'), 'signatures must not cross endpoints');
  const parsed = botReply(t.protocol, body);
  const botMessages = [...options.messages, { role: 'assistant', content: parsed.text, tool_calls: parsed.calls.map(c => ({ id: 'internal-step', provider_id: c.id, type: 'function', function: c.function })), response_items: responseContinuation(t.protocol, body) }, { role: 'tool', tool_call_id: 'internal-step', content: 'source evidence' }];
  const bot = botRequest(t, t.model, botMessages, tools, 4096, 'stable').body;
  if (t.protocol === 'anthropic-messages') { assert.deepEqual(bot.messages[1].content, native); assert.equal(bot.messages.at(-1).content[0].tool_use_id, 'native-call'); }
  else { assert.deepEqual(bot.input.slice(options.messages.length, -1), native); assert.equal(bot.input.at(-1).call_id, 'native-call'); }
}
const events = [
  { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
];
const sse = events => new Response(events.map(e => `data:${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const streamed = await chatStream(anth, options, undefined, undefined, undefined, async () => sse(events));
assert.equal(streamed.usage.input, 1000); assert.equal(streamed.usage.output, 20);
assert.equal(streamed.providerState.items[0].signature, 'signature');
console.log('History: Anthropic signatures, Responses encrypted reasoning and exact block/call order survive persistence; model/endpoint switching strips opaque state');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-cache-'));
const store = new DatabaseStore(path.join(root, 'db.sqlite'));
let app;
try {
  for (const owner of ['owner', 'other']) store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, owner, new Date().toISOString());
  const response = await observeModelFetch(store, 'owner', 'p', 'm', async () => sse(events), 'https://fake.test/messages');
  await response.text();
  await observeModelFetch(store, 'owner', 'p', 'm', async () => Response.json({ usage: { input_tokens: 9000, output_tokens: 20 } }), 'https://fake.test/responses');
  await assert.rejects(observeModelFetch(store, 'owner', 'p', 'm', async () => { throw Error('offline'); }, 'https://fake.test/responses'));
  const report = modelUsageReport(store, 'owner', '2000');
  assert.equal(report.total.requests, 3); assert.equal(report.total.cacheMeasuredRequests, 1);
  assert.equal(report.total.cacheWriteMeasuredRequests, 1, 'explicit zero writes are measured, absent fields are not');
  assert.equal(report.total.cacheHitRate, .9); assert.equal(report.total.cacheMeasuredInputTokens, 1000);
  assert.equal(modelUsageReport(store, 'other', '2000').total.requests, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM bot_requests').get().n, 0, 'ordinary observations do not reserve Bot budgets');
  const config = new CloudConfiguration(store, path.join(root, 'config'));
  config.save('owner', { ...config.get('owner', true), providers: [{ id: 'p', name: 'OpenAI', baseUrl: target.baseUrl, apiKey: 'fake', protocol: 'openai-responses', catalogId: 'openai' }], llmModel: { providerId: 'p', model: target.model } });
  let upstream;
  app = Fastify();
  registerCloudRoutes(app, { store, records: new CloudRecords(store), configuration: config, requireAuth: () => ({ id: 'owner' }), checkOrigin: () => true, filesDir: root, maxFileBytes: 1000, fetch: async (_url, init) => { upstream = JSON.parse(init.body); return Response.json(nativeBodies[1][1]); } });
  const proxied = await app.inject({ method: 'POST', url: '/api/v1/cloud/models/p/responses', headers: { 'x-wangke-cache-key': 'session' }, payload: { model: target.model, input: systems } });
  assert.equal(proxied.statusCode, 200); assert.equal(upstream.prompt_cache_key.length, 64); assert.equal(upstream.prompt_cache_options.mode, 'implicit');
  assert.equal((await app.inject('/api/v1/cloud/model-usage?days=1')).json().total.requests, 4);
  assert.equal((await app.inject('/api/v1/cloud/model-usage?days=0')).statusCode, 400);
  console.log('Storage/proxy: ordinary measurements, failure coverage, owner isolation, no double accounting, trusted upstream policy and report endpoint passed');
} finally { await app?.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
