import assert from 'node:assert/strict';
import test from 'node:test';
import { executeToolBatch, TOOL_CONCURRENCY } from '../packages/study-core/src/utils/toolBatch.ts';
import { ToolTraceLedger } from '../apps/web/src/utils/toolTrace.ts';
import { botRequest } from '../apps/api/src/agent/model.ts';
import { requestBody } from '../packages/study-core/src/api/modelClient.ts';
import { processTitle, processSteps } from '../apps/web/src/utils/responseProcess.ts';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('bounded overlap, write barriers, deterministic admission', async () => {
  const reads = Array.from({ length: 6 }, (_, i) => `read${i}`);
  const calls = [...reads, 'write', 'read-after', 'unknown'];
  const gate = deferred(), allStarted = deferred(), events = [];
  let active = 0, peak = 0;
  const run = executeToolBatch(calls, {
    canParallel: name => name.startsWith('read'),
    execute: async name => {
      events.push(`start:${name}`);
      peak = Math.max(peak, ++active);
      if (name === 'read3') allStarted.resolve();
      if (reads.slice(0, 4).includes(name)) await gate.promise;
      if (name === 'write' || name === 'unknown') assert.equal(active, 1);
      if (name === 'write') assert.ok(reads.every(read => events.includes(`end:${read}`)));
      if (name === 'read-after') assert.ok(events.includes('end:write'));
      active--; events.push(`end:${name}`);
    },
  });
  await allStarted.promise;
  assert.equal(active, TOOL_CONCURRENCY);
  assert.equal(events.includes('start:read4'), false);
  gate.resolve(); await run;
  assert.equal(peak, 4);
});

test('fatal failure drains admitted siblings before rejection and skips later waves', async () => {
  const gate = deferred(), failed = deferred(), started = [];
  let settled = false, drained = false;
  const run = executeToolBatch([0, 1, 2, 3, 4], {
    canParallel: () => true,
    execute: async i => {
      started.push(i);
      if (i === 0) { failed.resolve(); throw new Error('fatal'); }
      await gate.promise; drained = true;
    },
  });
  const rejection = assert.rejects(run, /fatal/).then(() => { settled = true; });
  await failed.promise; await Promise.resolve();
  assert.equal(settled, false);
  gate.resolve(); await rejection;
  assert.ok(drained); assert.deepEqual(started, [0, 1, 2, 3]);
});

test('abort drains current wave without admitting queued work', async () => {
  const ac = new AbortController(), gate = deferred(), started = [];
  const run = executeToolBatch([0, 1, 2, 3, 4], {
    signal: ac.signal, canParallel: () => true,
    execute: async i => { started.push(i); await gate.promise; },
  });
  ac.abort(); gate.resolve();
  await assert.rejects(run, error => error.name === 'AbortError');
  assert.deepEqual(started, [0, 1, 2, 3]);
});

test('same-name tool traces finish independently with immutable snapshots', () => {
  const trace = new ToolTraceLedger();
  trace.start('a', 'read', '{"path":"a.md"}', 10);
  trace.start('b', 'read', '{"path":"b.md"}', 10);
  const previous = [...trace.calls];
  assert.match(trace.hint, /并行调用 2/);
  assert.match(processTitle({ streaming: true, phase: 'tool', calls: trace.calls }), /并行调用 2/);
  assert.deepEqual(processSteps('', trace.calls).map(step => step.key), ['tool-a', 'tool-b']);
  trace.finish('b', '工具执行失败：missing');
  assert.deepEqual(trace.calls.map(c => c.status), ['running', 'error']);
  assert.equal(previous[1].status, 'running');
  assert.match(trace.hint, /a.md/);
  trace.finish('a', 'contents');
  assert.deepEqual(trace.calls.map(c => [c.id, c.result]), [['a', 'contents'], ['b', '工具执行失败：missing']]);
  assert.equal(trace.running, 0);
  assert.equal(trace.hint, undefined);
});

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
  test(`${protocol}: both serializers enable multi-call responses and preserve result identity`, () => {
    const calls = ['a', 'b'].map(id => ({ id, type: 'function', function: { name: 'read', arguments: '{}' } }));
    const messages = [{ role: 'user', content: 'Read both' }, { role: 'assistant', content: null, tool_calls: calls },
      ...calls.map(c => ({ role: 'tool', tool_call_id: c.id, content: `result-${c.id}` }))];
    const tools = [{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } } }];
    const target = { protocol, model: 'parallel-test', baseUrl: 'https://fake.test/v1', providerId: 'fake', catalogId: '' };
    for (const body of [botRequest(target, target.model, messages, tools).body, requestBody(target, { tools }, messages, false)]) {
      assert.notEqual(body.parallel_tool_calls, false);
      assert.notEqual(body.tool_choice?.disable_parallel_tool_use, true);
      if (protocol === 'anthropic-messages') {
        assert.equal(body.messages.length, 3);
        assert.deepEqual(body.messages[2].content.map(b => [b.tool_use_id, b.content]), [['a', 'result-a'], ['b', 'result-b']]);
      } else if (protocol === 'openai-responses') {
        assert.deepEqual(body.input.filter(i => i.type === 'function_call_output').map(i => i.call_id), ['a', 'b']);
      } else assert.deepEqual(body.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['a', 'b']);
    }
  });
}
