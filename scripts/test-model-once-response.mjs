import assert from 'node:assert/strict';
import { chatOnce, chatStream, textOf } from '../apps/web/src/api/modelClient.ts';

const target = { baseUrl: 'https://models.test/v1', apiKey: 'test', model: 'test', protocol: 'openai-chat' };
const options = { messages: [{ role: 'user', content: 'edit' }] };
const run = (body) => chatOnce(target, options, async () => new Response(body));
for (const reason of ['stop', 'length', 'content_filter', 'tool_calls']) {
  const message = await run(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reason === 'length' ? '{"edits":[' : null }, finish_reason: reason }] }));
  assert.equal(message.finish_reason, reason, 'preserve completion metadata for artifact truncation checks');
  if (reason === 'length') assert.equal(textOf(message), '{"edits":[');
}
await assert.rejects(run(''), /返回为空/);
await assert.rejects(run('{"choices":['), /不完整或不是有效 JSON/);
await assert.rejects(run('null'), /未返回有效消息/);
await assert.rejects(run('{"choices":[]}'), /未返回有效消息/);
for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
  for (const call of [chatOnce, (t, opts, fetcher) => chatStream(t, opts, undefined, undefined, undefined, fetcher)]) {
    await assert.rejects(call({ ...target, protocol }, options, async () => Response.json({ error: { message: 'JSON upstream failure' } })), /JSON upstream failure/);
    await assert.rejects(call({ ...target, protocol }, options, async () => Response.json({})), /未返回有效消息/);
  }
}
const failedRequests = [];
await chatOnce(target, { ...options, onRequest: record => failedRequests.push(record) }, async () => Response.json({ choices: [{ message: { role: 'assistant', content: '半截' }, finish_reason: 'error' }] }));
assert.equal(failedRequests[0].status, 'failed', 'an error terminal must not be logged as a completed model request');

function streamBody(chunks) {
  const encoder = new TextEncoder();
  const bytes = chunks.map((chunk) => typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < bytes.length) controller.enqueue(bytes[index++]);
      else controller.close();
    },
  });
}

function streamResponse(chunks, contentType = 'text/event-stream') {
  return new Response(streamBody(chunks), { headers: { 'content-type': contentType } });
}

function event(payload) {
  return `data: ${JSON.stringify(payload)}\r\n\r\n`;
}

const streamed = event({ choices: [{ delta: { content: '你好' } }] }) + event({ choices: [{ delta: {}, finish_reason: 'stop' }] });
const streamedBytes = new TextEncoder().encode(streamed);
const splitAt = streamedBytes.findIndex((byte, index) => byte >= 0x80 && index > 0);
const streamedMessage = await chatStream(
  target,
  options,
  undefined,
  undefined,
  undefined,
  async () => streamResponse([streamedBytes.slice(0, splitAt + 1), streamedBytes.slice(splitAt + 1)]),
);
assert.equal(textOf(streamedMessage), '你好', 'CRLF SSE and UTF-8 split across reads must preserve text');
assert.equal(streamedMessage.finish_reason, 'stop');

await assert.rejects(
  chatStream(target, options, undefined, undefined, undefined, async () => streamResponse(['data: {"choices":\n\n'])),
  /无效的流式 JSON/,
);
await assert.rejects(
  chatStream(target, options, undefined, undefined, undefined, async () => streamResponse([event({ error: { message: 'upstream down' } })])),
  /模型服务返回错误：upstream down/,
);

const responsesTarget = { ...target, protocol: 'openai-responses' };
const incompleteResponse = event({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-1', name: 'read' } })
  + event({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"x"}' })
  + event({ type: 'response.completed', response: { status: 'incomplete' } });
const incomplete = await chatStream(
  responsesTarget,
  options,
  undefined,
  undefined,
  undefined,
  async () => streamResponse([incompleteResponse]),
);
assert.equal(incomplete.finish_reason, 'length', 'Responses incomplete must remain truncation even when output contains a function call');
assert.equal(incomplete.tool_calls?.[0]?.function.name, 'read');

const streamedWith = (body, config = {}) => chatStream(
  config.target ?? target,
  { ...options, ...config.options },
  config.onDelta,
  undefined,
  undefined,
  async () => streamResponse([body]),
);
const multiline = 'data: {"choices":\r\ndata: [{"delta":{"content":"多行 data"},"finish_reason":"stop"}]}\r\n\r\n';
assert.equal(textOf(await streamedWith(multiline)), '多行 data', 'SSE data lines form one JSON payload');
await assert.rejects(streamedWith(event({ choices: [{ delta: { content: '缺少完成标记的半截' } }] })), /未收到完成标记/, 'clean EOF is not a model completion');
assert.equal(textOf(await streamedWith(event({ choices: [{ delta: { content: '末事件没有空行' }, finish_reason: 'stop' }] }).trimEnd())), '末事件没有空行', 'EOF must process the final buffered event');
assert.equal(textOf(await streamedWith(event({ choices: [{ delta: { content: '兼容 DONE' } }] }) + 'data: [DONE]\n\n')), '兼容 DONE');
await assert.rejects(streamedWith('event: error\ndata: {"message":"named event failure"}\n\n'), /named event failure/);
await assert.rejects(streamedWith('data: null\n\n'), /未返回有效的流式消息/);
await assert.rejects(streamedWith(event({ choices: [{ delta: { content: 'x' } }] }), { onDelta() { throw new Error('consumer failed'); } }), /consumer failed/, 'consumer errors must not be swallowed as JSON errors');

for (const [status, details, reason] of [
  ['incomplete', { reason: 'max_output_tokens' }, 'length'],
  ['incomplete', { reason: 'content_filter' }, 'content_filter'],
  ['incomplete', { reason: 'steered' }, 'aborted'],
  ['failed', null, 'error'],
]) {
  const terminal = event({ type: `response.${status}`, response: { status, incomplete_details: details } });
  const msg = await streamedWith(terminal, { target: responsesTarget });
  assert.equal(msg.finish_reason, reason, `Responses terminal status: ${status}/${details?.reason}`);
  const once = await chatOnce(responsesTarget, options, async () => Response.json({ status, incomplete_details: details, output: [{ type: 'function_call', call_id: 'c', name: 'read', arguments: '{}' }] }));
  assert.equal(once.finish_reason, reason, 'native JSON fallback must apply the same terminal status');
}

const abort = new AbortController();
abort.abort();
await assert.rejects(streamedWith(event({ choices: [{ delta: { content: 'must not emit' } }] }), { options: { signal: abort.signal }, onDelta() { assert.fail('aborted request emitted text'); } }), { name: 'AbortError' });
const upstream = new Error('socket reset');
let shown = '';
let reads = 0;
await assert.rejects(chatStream(target, options, delta => { shown += delta; }, undefined, undefined, async () => new Response(new ReadableStream({ pull(controller) {
  if (reads++ === 0) controller.enqueue(new TextEncoder().encode(event({ choices: [{ delta: { content: '已输出' } }] })));
  else controller.error(upstream);
} }), { headers: { 'content-type': 'text/event-stream' } })), error => error === upstream);
assert.equal(shown, '已输出', 'network failure must leave delivered deltas intact');

let cancelled = false;
const terminalMessage = await chatStream(target, options, undefined, undefined, undefined, async () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode(event({ choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n')); },
  cancel() { cancelled = true; },
}), { headers: { 'content-type': 'text/event-stream' } }));
assert.equal(textOf(terminalMessage), '完成', '[DONE] completes without waiting for a keep-alive connection to close');
assert.equal(cancelled, true);

console.log('Model responses: metadata, native terminal states, SSE framing/UTF-8, errors, abort and reader cleanup passed.');
