import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner, taskDto } from '../apps/api/src/cloud/tasks.ts';
import { executeServerWidget } from '../apps/api/runtime/widgets.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-server-widgets-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const records = new CloudRecords(store);
const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const owner = crypto.randomUUID(), other = crypto.randomUUID(), timestamp = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, timestamp);
const providers = ['openai-chat', 'openai-responses', 'anthropic-messages'].map((protocol, i) => ({
  id: `p${i}`, name: protocol, protocol, apiKey: 'test-only', baseUrl: `https://p${i}.example/v1`, serves: ['chat'],
}));
configuration.save(owner, { ...configuration.get(owner), providers, llmModel: { providerId: 'p0', model: 'test-model' } });
const put = (table, key, after, account = owner) => records.apply(account, [{ id: crypto.randomUUID(), table, key, before: records.get(account, table, key), after }]);
const rows = sessionId => store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='chats' AND value IS NOT NULL").all(owner)
  .map(row => JSON.parse(row.value)).filter(row => row.sessionId === sessionId);
const answer = sessionId => rows(sessionId).find(row => row.role === 'assistant');
const get = id => taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
let script = [], requests = [];
const mockFetch = async (url, init) => {
  const body = JSON.parse(init.body); requests.push(body);
  const next = script.shift(); assert.ok(next, 'unexpected model request');
  const message = await next(body, init);
  if (message instanceof Response) return message;
  const calls = message.calls ?? [];
  if (url.endsWith('/responses')) return Response.json({ output: [
    ...(message.text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.text }] }] : []),
    ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) })),
  ] });
  if (url.endsWith('/messages')) return Response.json({ content: [
    ...(message.text ? [{ type: 'text', text: message.text }] : []),
    ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })),
  ], stop_reason: calls.length ? 'tool_use' : 'end_turn' });
  return Response.json({ choices: [{ message: { role: 'assistant', content: message.text ?? null,
    ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) },
  finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
};
let runner = new CloudTaskRunner(store, { records, configuration, filesDir: directory, fetch: mockFetch });
const until = async predicate => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for server task');
};
const enqueue = (sessionId, kind = 'chat', extra = {}) => {
  const id = crypto.randomUUID();
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, owner, id, kind, `session:${sessionId}`, JSON.stringify({ sessionId, text: '交互式讲解', ...extra }), 'queued', timestamp, timestamp);
  return id;
};
const completed = async id => { await until(() => ['completed', 'failed', 'cancelled'].includes(get(id).status)); const task = get(id); assert.equal(task.status, 'completed', JSON.stringify(task)); assert.equal(task.executor, 'node'); return task; };
const session = id => put('chatSessions', id, { id, videoId: '__library_assistant__', title: '新会话', createdAt: Date.now() });
const widgetCall = (id, code = '<button>交互式讲解</button>', extra = {}) => ({ id, name: 'show_widget', args: { format: 'html', code, ...extra } });
const reference = widget => `\`\`\`wbw-widget\n${widget.ref}\n\`\`\``;
try {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  runner.start('http://127.0.0.1:1');
  for (let i = 0; i < providers.length; i++) {
    const sid = 100 + i; session(sid);
    configuration.save(owner, { ...configuration.get(owner, true), llmModel: { providerId: `p${i}`, model: 'test-model' } });
    const source = '<section><button>点击</button></section><script>throw new Error("must not execute on server")</script>';
    script = [body => {
      const tools = body.tools.map(tool => tool.function?.name ?? tool.name);
      assert.deepEqual(tools, ['show_widget'], 'empty libraries still register the visualization tool');
      return { calls: [widgetCall(`work-${i}`, source)] };
    }, body => {
      const row = answer(sid);
      assert.equal(row.widgets.length, 1, 'committed before the next model request, not just in task progress');
      assert.equal(row.widgets[0].html, source);
      assert.equal(row.widget.id, row.widgets[0].id);
      assert.equal(row.widgets[0].source, 'tool');
      assert.equal(row.interrupted, true);
      assert.ok(JSON.stringify(body).includes(reference(row.widget).split('\n')[1]));
      return { text: `观察交互。\n\n${reference(row.widget)}\n\n继续讲解。` };
    }];
    const task = await completed(enqueue(sid));
    assert.equal(script.length, 0);
    assert.equal(rows(sid).length, 2, 'snapshots and completion update the same pair');
    assert.equal(answer(sid).interrupted, undefined);
    assert.deepEqual(task.result.widgets, answer(sid).widgets);
    assert.deepEqual(task.progress.widgets, task.result.widgets);
    assert.ok(!task.result.content.includes(source));
    assert.equal(records.get(other, 'chats', task.result.rowId), null);
  }
  console.log('Empty-library registration, all 3 model protocols, save-before-receipt, identities, progress/result/record payloads passed');

  configuration.save(owner, { ...configuration.get(owner, true), llmModel: { providerId: 'p0', model: 'test-model' } });
  session(200);
  const invalid = [
    widgetCall('bad-document', '<html><body>not a fragment</body></html>'),
    widgetCall('bad-script', '<script src="https://invalid.test/script.js"></script>'),
    widgetCall('bad-css-image', '<style>.x{background:url(https://invalid.test/bg.png)}</style><div class="x">图片</div>'),
    widgetCall('bad-srcset', '<img srcset="https://invalid.test/a.png 1x">'),
    widgetCall('bad-fetch', '<script>fetch("https://invalid.test/data")</script>'),
    widgetCall('bad-library', '<canvas></canvas>', { libs: ['unknown'] }),
    widgetCall('bad-length', '<div>' + 'x'.repeat(60001) + '</div>'),
  ];
  script = [() => ({ calls: invalid }), () => {
    assert.ok(!answer(200).widgets, 'invalid calls do not deliver a payload');
    assert.ok(answer(200).tools.every(tool => tool.status === 'error'));
    return { calls: [widgetCall('repaired', '<canvas></canvas>', { libs: ['chart.js', 'chart.js'] })] };
  }, () => ({ text: reference(answer(200).widget) })];
  const repaired = await completed(enqueue(200));
  assert.equal(repaired.result.widgets.length, 1);
  assert.deepEqual(repaired.result.widget.libs, ['chart.js']);

  session(201);
  script = [() => ({ calls: [widgetCall('first', '<div>第一幅</div>')] }), () => {
    const row = answer(201);
    put('chats', row.id, { ...row, widgetStates: { [row.widget.id]: { modelContent: { step: 2 }, privateContent: {} } } });
    return { text: `第一幅解释。\n\n${reference(row.widget)}`, calls: [widgetCall('second', '<div>第二幅</div>')] };
  }, () => ({ text: `第二幅解释。\n\n${reference(answer(201).widgets[1])}\n\n后续问题。` })];
  const multiple = await completed(enqueue(201));
  assert.equal(multiple.result.widgets.length, 2);
  assert.notEqual(multiple.result.widgets[0].id, multiple.result.widgets[1].id);
  assert.match(multiple.result.content, /第一幅解释[\s\S]*第二幅解释[\s\S]*后续问题/);
  assert.ok(answer(201).widgetStates[multiple.result.widgets[0].id], 'later snapshots preserve synced interaction state');

  session(202);
  script = [() => ({ calls: [widgetCall('duplicate-a'), widgetCall('duplicate-b')] }), () => ({ text: reference(answer(202).widget) })];
  assert.equal((await completed(enqueue(202))).result.widgets.length, 1);

  session(203);
  let finishArguments;
  const streamedArgs = JSON.stringify({ format: 'html', code: '<button>分段参数</button>' });
  script = [() => new Response(new ReadableStream({ start(controller) {
    const send = delta => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
    send({ tool_calls: [{ index: 0, id: 'stream-widget', type: 'function', function: { name: 'show_widget', arguments: streamedArgs.slice(0, -8) } }] });
    finishArguments = () => {
      send({ tool_calls: [{ index: 0, function: { arguments: streamedArgs.slice(-8) } }] });
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    };
  } }), { headers: { 'content-type': 'text/event-stream' } }), () => ({ text: reference(answer(203).widget) })];
  const streamed = enqueue(203);
  await until(() => get(streamed).progress?.widgetPreview);
  assert.match(get(streamed).progress.widgetPreview.html, /分段参数/);
  assert.ok(!answer(203).widgets, 'partial parameters cannot create runnable work');
  finishArguments();
  const streamedResult = await completed(streamed);
  assert.equal(streamedResult.progress.widgetPreview, undefined);
  assert.equal(streamedResult.result.widget.html, '<button>分段参数</button>');

  session(205);
  script = [() => Response.json({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'truncated-widget', type: 'function', function: { name: 'show_widget', arguments: JSON.stringify(widgetCall('unused').args) } }] } }] }), body => {
    assert.ok(!answer(205).widgets, 'length-limited calls cannot execute even when arguments parse');
    assert.match(body.messages.find(message => message.tool_call_id === 'truncated-widget').content, /没有执行.*max_tokens/);
    return { text: '工具参数撞上限，本轮未交付作品。' };
  }];
  assert.equal((await completed(enqueue(205))).result.widgets, undefined);

  session(206);
  script = [() => Response.json({ choices: [{ finish_reason: 'error', message: { role: 'assistant', content: '异常前已输出的内容' } }] })];
  const providerError = enqueue(206);
  await until(() => get(providerError).status === 'failed');
  assert.equal(script.length, 0, 'provider failure must not start a wrap-up request');
  assert.equal(answer(206).content, '异常前已输出的内容');
  assert.equal(answer(206).interrupted, true);
  assert.equal(get(providerError).progress.widgetPreview, undefined);

  session(207);
  let streamReads = 0;
  script = [() => new Response(new ReadableStream({ pull(controller) {
    if (streamReads++ === 0) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '节流窗口中的最后一段' } }] }) + '\n\n'));
    else controller.error(new Error('reader connection reset'));
  } }), { headers: { 'content-type': 'text/event-stream' } })];
  const readerError = enqueue(207);
  await until(() => get(readerError).status === 'failed');
  assert.equal(answer(207).content, '节流窗口中的最后一段', 'failure must force a final durable progress flush');
  assert.equal(answer(207).interrupted, true);
  assert.equal(get(readerError).progress.content, '节流窗口中的最后一段');

  session(208);
  script = [() => Response.json({ choices: [{ finish_reason: 'content_filter', message: { role: 'assistant', content: '',
    tool_calls: [{ id: 'filtered-widget', type: 'function', function: { name: 'show_widget', arguments: JSON.stringify(widgetCall('filtered-widget').args) } }] } }] })];
  const filtered = await completed(enqueue(208));
  assert.equal(script.length, 0, 'content filtering must not trigger a follow-up request');
  assert.equal(filtered.result.widgets, undefined, 'filtered tool calls must not execute');
  assert.equal(answer(208).interrupted, undefined);
  assert.match(answer(208).content, /内容过滤/);

  session(204);
  script = [() => ({ calls: [widgetCall('edited-widget')] }), () => {
    const row = answer(204);
    const revised = { ...row.widget, id: crypto.randomUUID(), revision: 2, html: '<button>新修订</button>' };
    put('chats', row.id, { ...row, widgets: [revised], widget: revised });
    return { text: reference(revised) };
  }];
  const edited = await completed(enqueue(204));
  assert.equal(edited.result.widget.revision, 2, 'results and progress use the latest committed source, not a stale payload');
  assert.deepEqual(edited.result.widgets, answer(204).widgets);
  assert.deepEqual(edited.progress.widgets, answer(204).widgets);

  for (const [id, video] of [['video', { name: '视频', duration: 60 }], ['material', { name: '材料', kind: 'material', materialFormat: 'md' }]]) {
    put('videos', id, { id, ...video });
    const sid = id === 'video' ? 300 : 301; session(sid);
    script = [body => { assert.ok(body.tools.some(tool => tool.function?.name === 'show_widget')); return { calls: [widgetCall('qa-widget')] }; }, () => ({ text: reference(answer(sid).widget) })];
    const task = await completed(enqueue(sid, 'qa', { videoId: id }));
    assert.equal(task.result.widget.html, '<button>交互式讲解</button>');
  }
  console.log('Invalid input/correction, local library whitelist, multiple works/order, deduplication, state preservation and video/material QA passed');

  session(400);
  script = [() => ({ calls: [widgetCall('interrupted-widget')] }), () => { throw new Error('simulated model disconnect'); }];
  const failed = enqueue(400); await until(() => get(failed).status === 'failed');
  const partial = answer(400);
  assert.equal(partial.widgets.length, 1); assert.equal(partial.interrupted, true);
  await runner.close();
  runner = new CloudTaskRunner(store, { records, configuration, filesDir: directory, fetch: mockFetch }); runner.start('http://127.0.0.1:1');
  script = [body => { assert.ok(JSON.stringify(body.messages).includes(partial.widget.ref)); return { text: '继续解释。' }; }];
  await completed(enqueue(400));
  assert.deepEqual(records.get(owner, 'chats', partial.id).widgets, partial.widgets, 'restart retains the already delivered work');

  const beforeContinue = rows(400);
  const suffix = '  接着断点继续解释。\n\n';
  script = [body => {
    assert.equal(body.tools, undefined, 'explicit continuation has no tool execution');
    assert.match(body.messages.at(-1).content, /从断点处直接续上/);
    assert.ok(!JSON.stringify(body.messages).includes('继续解释。'), 'later questions/answers are outside the original breakpoint');
    return { text: partial.content + suffix };
  }];
  const continued = await completed(enqueue(400, 'chat', { action: 'continue', rowId: partial.id }));
  assert.equal(continued.result.rowId, partial.id);
  assert.equal(records.get(owner, 'chats', partial.id).content, partial.content + suffix, 'exact replay is stripped without trimming whitespace');
  assert.equal(records.get(owner, 'chats', partial.id).interrupted, undefined);
  assert.deepEqual(records.get(owner, 'chats', partial.id).widgets, partial.widgets);
  assert.equal(rows(400).length, beforeContinue.length, 'continuation updates the same row, without another user question');

  session(410);
  script = [() => Response.json({ choices: [{ finish_reason: 'error', message: { role: 'assistant', content: '这是原回答足够长的中断前缀，不能丢失。' } }] })];
  const firstFailure = enqueue(410); await until(() => get(firstFailure).status === 'failed');
  const interrupted = answer(410);
  script = [() => Response.json({ choices: [{ finish_reason: 'error', message: { role: 'assistant', content: '又接上了半句' } }] })];
  const secondFailure = enqueue(410, 'chat', { action: 'continue', rowId: interrupted.id });
  await until(() => get(secondFailure).status === 'failed');
  assert.equal(answer(410).id, interrupted.id);
  assert.equal(answer(410).content, interrupted.content + '又接上了半句');
  assert.equal(answer(410).interrupted, true, 'failure during continuation keeps the new prefix resumable');
  script = [() => ({ text: answer(410).content + '最后写完。' })];
  await completed(enqueue(410, 'chat', { action: 'continue', rowId: interrupted.id }));
  assert.equal(answer(410).content, interrupted.content + '又接上了半句最后写完。');
  assert.equal(answer(410).interrupted, undefined);
  const wrongOwner = enqueue(400, 'chat', { action: 'continue', rowId: interrupted.id });
  await until(() => get(wrongOwner).status === 'failed');
  assert.match(get(wrongOwner).error, /原回答不存在/);

  session(401);
  let waiting = false;
  script = [() => ({ calls: [widgetCall('cancel-widget')] }), (_body, init) => new Promise((_, reject) => {
    waiting = true;
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    init.signal.addEventListener('abort', abort, { once: true }); if (init.signal.aborted) abort();
  })];
  const cancelled = enqueue(401); await until(() => waiting);
  store.db.prepare("UPDATE cloud_tasks SET status='cancelled' WHERE id=?").run(cancelled); await runner.cancel(cancelled);
  assert.equal(answer(401).widgets.length, 1); assert.equal(answer(401).interrupted, undefined, 'explicit stop is not an automatic continuation marker');

  session(402);
  script = [() => ({ calls: [widgetCall('deleted-owner')] }), () => { const row = answer(402); put('chats', row.id, null); return { text: 'must not recreate deleted row' }; }];
  const deleted = enqueue(402); await until(() => get(deleted).status === 'failed');
  assert.equal(answer(402), undefined); assert.match(get(deleted).error, /已删除/);

  for (const [format, code] of [
    ['diagram', '{"type":"plot","x":[-2,2],"y":[0,4],"curves":[{"fn":"x^2"}]}'],
    ['svg', '<svg viewBox="0 0 20 20"><rect width="10" height="10"/></svg>'],
    ['mermaid', 'flowchart TD\n A-->B'],
  ]) assert.match(executeServerWidget({ format, code }, () => assert.fail('not an HTML work')), /```/);
  const graph = {
    type: 'graph',
    nodes: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, label: `节点${i}` })),
    edges: Array.from({ length: 20 }, (_, i) => ({ from: `n${i % 12}`, to: `n${(i + 1) % 12}` })),
  };
  const graphCode = JSON.stringify(graph);
  const graphReceipt = executeServerWidget({ format: 'diagram', code: graphCode, title: '完整关系图' }, () => assert.fail('not an HTML work'));
  assert.ok(graphReceipt.includes(graphCode), '12 节点 / 20 条边通过服务端预检，原样保留全部结构');
  assert.match(graphReceipt, /```diagram title="完整关系图"/);
  assert.throws(() => executeServerWidget({ format: 'diagram', code: JSON.stringify({
    ...graph, nodes: Array.from({ length: 101 }, (_, i) => ({ id: `n${i}`, label: `节点${i}` })),
  }) }, () => {}), /渲染安全上限[\s\S]*保留全部节点与关系/);
  assert.throws(() => executeServerWidget({ format: 'diagram', code: '{"type":"plot","x":[-2,2],"y":[0,4],"curves":[{"fn":"fetch(x)"}]}' }, () => {}), /预检没通过/);
  assert.throws(() => executeServerWidget({ format: 'svg', code: '<svg viewBox="0 0 20 20"><script>alert(1)</script></svg>' }, () => {}), /预检没通过/);
  assert.equal(script.length, 0);
  console.log('Model failure/cancellation, restart history, deleted-owner safety and static-format structural checks passed');
} finally {
  await runner.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true });
}
