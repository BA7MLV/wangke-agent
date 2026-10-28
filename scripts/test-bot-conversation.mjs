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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-conversation-'));
const store = new DatabaseStore(path.join(root, 'db.sqlite'));
process.env.MODEL_API_KEY = 'test-only';
let runner;
const response = (...calls) => new Response(JSON.stringify({ choices: [{ message: { tool_calls: calls.map(([name, args], i) => ({ id: `call-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }));
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
} finally { await runner?.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
