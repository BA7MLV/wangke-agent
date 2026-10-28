import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-conversation-'));
const store = new DatabaseStore(path.join(root, 'db.sqlite'));
process.env.MODEL_API_KEY = 'test-only';
let runner;
const response = (...calls) => new Response(JSON.stringify({ choices: [{ message: { tool_calls: calls.map(([name, args], i) => ({ id: `call-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }));
const until = async fn => { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('conversation_timeout'); };
try {
  const owner = crypto.randomUUID(), other = crypto.randomUUID(), thread = crypto.randomUUID(), run = crypto.randomUUID(), at = new Date().toISOString();
  for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, at);
  store.db.prepare('INSERT INTO threads(id,owner_id,mode,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(thread, owner, 'bot', 'Conversation', at, at);
  store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,?,?,?)').run(run, thread, 'bot', 'queued', at);
  const configuration = new CloudConfiguration(store, path.join(root, 'config'));
  const defaults = configuration.get(owner, true);
  configuration.save(owner, { ...defaults, policy: { ...defaults.policy, read: 'allow' } });
  const files = path.join(root, 'files'); fs.mkdirSync(files);
  const image = await receiveFile(store, files, owner, Readable.from([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=', 'base64')]), 'image.png', 'image/png', 1024);
  const document = await receiveFile(store, files, owner, Readable.from(['notes']), 'notes.txt', 'text/plain', 1024);
  const privateFile = await receiveFile(store, files, other, Readable.from(['private']), 'private.txt', 'text/plain', 1024);
  const messages = () => store.db.prepare("SELECT kind,content FROM messages WHERE thread_id=? AND role='assistant' ORDER BY seq").all(thread);
  let turns = 0;
  runner = new BotRunner(store, { configuration, study: new StudyTools(store, configuration, files), fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    switch (++turns) {
      case 1: return response(['finish_turn', {}]); // No silent empty reply.
      case 2:
        assert.match(body.messages.at(-1).content, /Send a reply/);
        return response(['send_message', { kind: 'text', text: '先给你看看图片。', complete: false }]);
      case 3:
        assert.deepEqual(messages().map(m => m.content), ['先给你看看图片。']);
        assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(run).status, 'running');
        return response(['study_send_file', { fileId: privateFile.id }]);
      case 4:
        assert.equal(messages().length, 1, 'Unowned attachment must not be delivered');
        return response(['study_send_file', { fileId: image.id, caption: '这张图比较直观。' }]);
      case 5:
        assert.equal(JSON.parse(messages()[1].content).caption, '这张图比较直观。');
        return response(
          ['send_message', { kind: 'text', text: '笔记也放在这里了。', complete: false }],
          ['study_send_file', { fileId: document.id, caption: '完整笔记' }],
          ['finish_turn', {}],
        );
      default: throw new Error('Unexpected extra model turn');
    }
  } });
  runner.start();
  for (let i = 0; i < 500; i++) {
    if (store.db.prepare('SELECT status FROM runs WHERE id=?').get(run).status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await runner.close();
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(run).status, 'completed');
  assert.equal(turns, 5);
  assert.deepEqual(messages().map(m => m.kind), ['text', 'attachment', 'text', 'attachment']);
  assert.equal(JSON.parse(messages()[3].content).fileId, document.id);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM run_steps WHERE run_id=? AND status != 'completed'").get(run).n, 0);
  console.log('Bot conversation: incremental text, image/file captions, ownership, ordered batch and no duplicate final reply passed');

  const service = new BotApplicationService(store, { enqueue() {} });
  const createRun = (text) => {
    const conversation = service.create(owner, 'bot', text);
    const message = service.send(owner, conversation.id, { clientNonce: crypto.randomUUID(), content: text });
    return store.db.prepare('SELECT * FROM runs WHERE trigger_message_id=?').get(message.id);
  };
  const status = run => store.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id).status;
  const replies = run => store.db.prepare("SELECT kind,content FROM messages WHERE thread_id=? AND role='assistant' ORDER BY seq").all(run.thread_id);
  const pref = (id, value) => store.db.prepare("INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,'preferences',?,?) ON CONFLICT(owner_id,table_name,record_key) DO UPDATE SET value=excluded.value").run(owner, JSON.stringify(id), JSON.stringify({ id, value }));
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
    configuration.save(owner, { ...configuration.get(owner, true), providers: [{ id: 'direct', name: 'Direct', baseUrl: 'https://offline.invalid', apiKey: 'test', protocol, catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'direct', model: 'test' } });
    for (const mixed of [false, true]) {
      const direct = createRun(`${protocol}: ${mixed ? 'text and tool' : 'emoji'}`);
      let requests = 0;
      const text = mixed ? '已经整理好啦 🙂' : '🙂';
      runner = new BotRunner(store, { configuration, fetch: async (_url, init) => {
        requests++;
        const body = JSON.parse(init.body);
        assert.equal(protocol === 'anthropic-messages' ? body.tool_choice.type : body.tool_choice, 'auto');
        if (protocol === 'openai-chat') return Response.json({ choices: [{ message: { content: text, ...(mixed ? { tool_calls: [{ function: { name: 'finish_turn', arguments: '{}' } }] } : {}) } }] });
        if (protocol === 'openai-responses') return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }, ...(mixed ? [{ type: 'function_call', name: 'finish_turn', arguments: '{}' }] : [])] });
        return Response.json({ stop_reason: mixed ? 'tool_use' : 'end_turn', content: [{ type: 'text', text }, ...(mixed ? [{ type: 'tool_use', name: 'finish_turn', input: {} }] : [])] });
      } });
      runner.start(); await until(() => ['completed', 'failed', 'paused'].includes(status(direct))); await runner.close();
      assert.equal(status(direct), 'completed');
      assert.equal(requests, 1, 'direct reply, including text plus finish_turn, finishes once');
      assert.deepEqual(replies(direct), [{ kind: 'text', content: text }]);
      assert.ok(store.db.prepare('SELECT context_json FROM runs WHERE id=?').get(direct.id).context_json.includes(text), 'direct replies remain in checkpoint evidence');
    }
  }
  configuration.save(owner, { ...configuration.get(owner, true), providers: [{ id: 'direct', name: 'Direct', baseUrl: 'https://offline.invalid', apiKey: 'test', protocol: 'openai-chat', catalogId: '', serves: ['chat'] }] });
  const recoverable = createRun('请接着整理'), superseded = createRun('旧请求'), uncertain = createRun('旧操作'), archived = createRun('归档请求');
  for (const old of [recoverable, superseded, uncertain, archived]) store.db.prepare("UPDATE runs SET status='paused',error_code='context_capacity_exceeded' WHERE id=?").run(old.id);
  service.append(superseded.thread_id, 'user', 'text', '换一个话题');
  store.db.prepare("INSERT INTO run_steps(id,run_id,tool,arguments,status,created_at) VALUES(?,?,'shell','{}','interrupted',?)").run(crypto.randomUUID(), uncertain.id, at);
  store.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(archived.thread_id);
  let recovered = 0;
  runner = new BotRunner(store, { configuration, fetch: async () => { recovered++; return Response.json({ choices: [{ message: { content: '整理好了。' } }] }); } });
  runner.start(); await until(() => status(recoverable) === 'completed'); await runner.close();
  assert.equal(recovered, 1);
  for (const old of [superseded, uncertain, archived]) assert.equal(status(old), 'paused', 'stale, uncertain or archived work stays dormant');

  pref('savedModels', [{ providerId: 'direct', model: 'test', contextWindow: 64000, maxOutputTokens: 64000 }]);
  const compact = createRun('简短回答即可');
  runner = new BotRunner(store, { configuration, fetch: async (_url, init) => {
    assert.equal(JSON.parse(init.body).max_tokens, 1024, 'oversized reply reservation is reduced automatically');
    return Response.json({ choices: [{ message: { content: '好的 🙂' } }] });
  } });
  runner.start(); await until(() => ['completed', 'failed'].includes(status(compact))); await runner.close();
  assert.equal(status(compact), 'completed');
  pref('savedModels', [{ providerId: 'direct', model: 'test', contextWindow: 50 }]);
  const impossible = createRun('无法容纳的请求');
  runner = new BotRunner(store, { configuration, fetch: async () => { throw new Error('must not send oversized request'); } });
  runner.start(); await until(() => status(impossible) === 'failed'); await runner.close();
  assert.equal(replies(impossible).length, 1);
  assert.equal(replies(impossible)[0].kind, 'text');
  assert.doesNotMatch(replies(impossible)[0].content, /预算|继续任务|context_capacity/);
  // Recovery must not turn a terminal context failure into a retry loop.
  const restarted = new BotRunner(store, { configuration, fetch: async () => { throw new Error('unexpected replay'); } });
  restarted.start(); await restarted.quiesce(1000); await restarted.close();
  assert.equal(status(impossible), 'failed'); assert.equal(replies(impossible).length, 1);
  console.log('Bot conversation: three-protocol text/emoji, mixed reply+tool, safe legacy recovery, automatic capacity adjustment and terminal fallback passed');
} finally { await runner?.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
