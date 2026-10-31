import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { hasWechatLatex, WECHAT_FORMAT_REPAIR } from '../apps/api/src/agent/wechat-replies.ts';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { GatewayCore } from '../apps/api/src/gateway/core.ts';
import { IlinkPlugin } from '../apps/api/src/gateway/adapters/ilink.ts';

test('detect prose math without rewriting Markdown, code examples, prices or URLs', () => {
  for (const text of [String.raw`结果是 $\frac{1}{2}$`, '$x$', '$x^2$', '$$x=1$$', String.raw`\(x+1\)`, String.raw`\[x=1\]`, String.raw`结果为 \frac{a+b}{c+d}`, String.raw`\alpha + \sqrt{x}`, 'x^{12}', 'a_{n+1}', '```math\nx=1\n```']) assert.equal(hasWechatLatex(text), true, text);
  for (const text of ['结果是 **1/2**，即 0.5。', '(a + b)/(c + d)，x²，√(x+1)', '$5 and $10', '价格 $5、$10。', String.raw`价格 \$5，\$10。`, 'https://example.com/$x$/file', '`$x$` 是公式语法', '```latex\n\\frac{1}{2}\n```', '~~~python\ns = r"\\frac{1}{2}"\n~~~', '````md\n```latex\n$A$\n```\n````', '```python\nx = "$x$"']) assert.equal(hasWechatLatex(text), false, text);
});

function response(protocol, text, calls = []) {
  const tools = calls.map(([name, args]) => ({ id: crypto.randomUUID(), name, args }));
  if (protocol === 'openai-responses') return Response.json({ status: 'completed', output: [
    ...(text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : []),
    ...tools.map(t => ({ type: 'function_call', call_id: t.id, name: t.name, arguments: JSON.stringify(t.args) })),
  ] });
  if (protocol === 'anthropic-messages') return Response.json({ stop_reason: tools.length ? 'tool_use' : 'end_turn', content: [
    ...(text ? [{ type: 'text', text }] : []), ...tools.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.args })),
  ] });
  return Response.json({ choices: [{ message: { content: text || null, ...(tools.length ? { tool_calls: tools.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}) } }] });
}

async function fixture(t, protocol = 'openai-chat', linked = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-format-'));
  const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
  const at = new Date().toISOString(), owner = 'owner';
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, at);
  store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('agent', owner, 'Study', 'study', 'Answer questions.', at, at);
  configuration.save(owner, { ...configuration.get(owner, true), providers: [{ id: 'test', name: 'Test', baseUrl: 'https://offline.invalid', apiKey: 'test', protocol, serves: ['chat'] }], llmModel: { providerId: 'test', model: 'test' } });
  const bot = new BotApplicationService(store, { enqueue() {}, cancel() {} });
  const sent = [];
  const gateway = new GatewayCore(store, configuration, bot, { ilink: () => ({
    manifest: new IlinkPlugin(async () => {}).manifest,
    validate() {}, async start(_c, ctx) { ctx.health('connected'); }, async stop() {},
    async send(_c, _peer, payload, id) { sent.push(payload); return id; },
  }) }, path.join(directory, 'files'));
  let runner, thread;
  t.after(async () => { await runner?.close(); await gateway.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  if (linked) {
    const { id } = await gateway.save(owner, { channel: 'ilink', agentId: 'agent', enabled: true, config: { botId: 'test', botToken: 'test' } });
    gateway.receive(id, [{ messageId: 'pair', tenant: '', peer: 'user', chat: 'user', topic: '', direct: true, human: true, text: gateway.pair(owner, id).command, context: 'test' }]);
    await gateway.tick();
    thread = store.db.prepare('SELECT thread_id FROM gateway_bindings WHERE account_id=?').get(id).thread_id;
  } else thread = bot.create(owner, 'bot', 'Web').id;
  const trigger = bot.send(owner, thread, { clientNonce: crypto.randomUUID(), content: '1/2 是多少？只给答案。' });
  const run = store.db.prepare('SELECT * FROM runs WHERE trigger_message_id=?').get(trigger.id);
  const replies = () => store.db.prepare("SELECT content FROM messages WHERE thread_id=? AND role='assistant' AND seq>? ORDER BY seq").all(thread, trigger.seq).map(m => m.content);
  const execute = async fetch => {
    runner = new BotRunner(store, { configuration, fetch }); runner.start();
    for (let i = 0; i < 500; i++) {
      if (['completed', 'failed', 'paused'].includes(store.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id).status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await runner.close();
    await gateway.tick();
    return store.db.prepare('SELECT status,error_code,context_json FROM runs WHERE id=?').get(run.id);
  };
  return { store, run, thread, sent, replies, execute };
}

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
  for (const mode of ['direct', 'finish', 'tool']) test(`${protocol}: ${mode} math is repaired before Web events and iLink delivery`, async t => {
    const f = await fixture(t, protocol);
    let requests = 0;
    const result = await f.execute(async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.ok(JSON.stringify(body).includes('WeChat reply format:'));
      if (++requests === 1) {
        const latex = String.raw`结果是 $\frac{1}{2}$。`;
        return response(protocol, mode === 'tool' ? '' : latex, mode === 'tool' ? [['send_message', { kind: 'text', text: latex, complete: true }]] : mode === 'finish' ? [['finish_turn', {}]] : []);
      }
      assert.deepEqual(f.replies(), [], 'rejected content must never enter message_events/outbox');
      assert.ok(JSON.stringify(body).includes('WeChat format repair:'));
      return response(protocol, '是 **0.5**。');
    });
    assert.equal(requests, 2);
    assert.equal(result.status, 'completed');
    assert.deepEqual(f.replies(), ['是 **0.5**。']);
    assert.equal(f.sent.at(-1).text, '是 **0.5**。');
    assert.ok(f.sent.every(p => !hasWechatLatex(p.text)));
  });
}

test('persisted old context receives current channel policy; bounded repairs survive restart', async t => {
  const f = await fixture(t);
  f.store.db.prepare('UPDATE runs SET context_json=? WHERE id=?').run(JSON.stringify([
    { role: 'system', content: 'Answer in LaTeX.' },
    { role: 'user', content: '1/2 是多少？' },
    { role: 'assistant', content: '$x$' },
    { role: 'user', runtime_notice: true, content: `${WECHAT_FORMAT_REPAIR}\nFormat check run: ${f.run.id}` },
    { role: 'assistant', content: '$x$' },
    { role: 'user', runtime_notice: true, content: `${WECHAT_FORMAT_REPAIR}\nFormat check run: ${f.run.id}` },
  ]), f.run.id);
  let requests = 0;
  const result = await f.execute(async (_url, init) => {
    requests++;
    assert.ok(JSON.stringify(JSON.parse(init.body)).includes('WeChat reply format:'));
    return response('openai-chat', '$x$');
  });
  assert.equal(requests, 1, 'restored repair budget is not reset');
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'wechat_reply_format_failed');
  assert.deepEqual(f.replies(), ['这次回复的公式没能转换成微信可读的格式，请重试。']);
});

test('captions and message tools cannot bypass validation; rejected batch has no partial effects', async t => {
  const f = await fixture(t);
  let requests = 0;
  const result = await f.execute(async () => {
    if (++requests === 1) return response('openai-chat', '', [
      ['send_message', { kind: 'text', text: '即将发送。', complete: false }],
      ['study_send_file', { fileId: 'not-a-file', caption: String.raw`\(x^2\)` }],
    ]);
    assert.deepEqual(f.replies(), []);
    return response('openai-chat', '结果是 x²。');
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.replies(), ['结果是 x²。']);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM run_steps WHERE run_id=? AND status='interrupted'").get(f.run.id).n, 2);
});

test('standalone Web math remains unchanged', async t => {
  const f = await fixture(t, 'openai-chat', false);
  const latex = String.raw`$\frac{1}{2}$`;
  const result = await f.execute(async (_url, init) => {
    assert.ok(!JSON.stringify(JSON.parse(init.body)).includes('WeChat reply format:'));
    return response('openai-chat', latex);
  });
  assert.equal(result.status, 'completed'); assert.deepEqual(f.replies(), [latex]);
});

test('explicit LaTeX source in a code block is delivered unchanged', async t => {
  const f = await fixture(t);
  const source = '```latex\n\\frac{1}{2}\n```';
  const result = await f.execute(async () => response('openai-chat', source));
  assert.equal(result.status, 'completed'); assert.deepEqual(f.replies(), [source]);
  assert.equal(f.sent.at(-1).text, source);
});
