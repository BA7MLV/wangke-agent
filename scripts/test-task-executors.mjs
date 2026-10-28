import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { zipSync, strToU8 } from 'fflate';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner, taskDto } from '../apps/api/src/cloud/tasks.ts';
import { executorFor } from '../apps/api/src/cloud/execution.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';
import { runMediaProcess } from '../apps/api/src/cloud/media.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-task-executors-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const owner = crypto.randomUUID(), other = crypto.randomUUID(), timestamp = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, timestamp);
const filesDir = path.join(directory, 'files'); fs.mkdirSync(filesDir);
const records = new CloudRecords(store);
const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const providers = ['openai-chat', 'openai-responses', 'anthropic-messages'].map((protocol, i) => ({
  id: `p${i}`, name: protocol, protocol, apiKey: 'private-model-key', baseUrl: `https://p${i}.example/v1`, catalogId: '', serves: ['chat'],
}));
configuration.save(owner, { ...configuration.get(owner), providers, llmModel: { providerId: 'p0', model: 'native-model' } });
let reply = 'Node result', block = false, requests = [], aborted = 0, httpStatus = 200;
const mockFetch = async (url, init) => {
  requests.push({ url, init });
  assert.equal(init.redirect, 'error');
  if (httpStatus !== 200) return new Response('private-model-key must not be persisted', { status: httpStatus, headers: { 'retry-after': '60' } });
  if (block) return new Promise((_, reject) => {
    const abort = () => { aborted++; reject(new DOMException('Aborted', 'AbortError')); };
    init.signal.addEventListener('abort', abort, { once: true });
    if (init.signal.aborted) abort();
  });
  const body = url.endsWith('/responses') ? { output: [{ type: 'message', content: [{ type: 'output_text', text: reply }] }] }
    : url.endsWith('/messages') ? { content: [{ type: 'text', text: reply }] }
      : { choices: [{ message: { role: 'assistant', content: reply } }] };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
};
let runner = new CloudTaskRunner(store, { records, configuration, filesDir, fetch: mockFetch });
const put = (table, key, value, account = owner) => records.apply(account, [{ id: crypto.randomUUID(), table, key, before: records.get(account, table, key), after: value }]);
const get = id => taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
function enqueue(kind, input = {}, resource = crypto.randomUUID(), account = owner) {
  const id = crypto.randomUUID();
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, account, id, kind, resource, JSON.stringify(input), 'queued', timestamp, timestamp);
  return id;
}
async function until(predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for task');
}
async function completed(id, executor = 'node') {
  await until(() => ['completed', 'failed', 'cancelled', 'interrupted'].includes(get(id).status));
  const task = get(id);
  assert.equal(task.status, 'completed', JSON.stringify(task));
  assert.equal(task.executor, executor);
  return task;
}
async function upload(data, name, mime = 'application/octet-stream', account = owner) {
  return receiveFile(store, filesDir, account, Readable.from([data]), name, mime, data.length, data.length);
}

try {
  assert.equal(typeof globalThis.window, 'undefined');
  for (const kind of ['transcribe', 'handout']) {
    assert.equal(executorFor({ kind, input: {} }, null), 'browser');
  }
  for (const kind of ['chat', 'qa', 'artifactEdit']) {
    assert.equal(executorFor({ kind, input: {} }, null), 'node');
  }
  assert.equal(executorFor({ kind: 'cover', input: {} }, { kind: 'material' }), 'browser');
  assert.equal(executorFor({ kind: 'material', input: { format: 'pdf' } }, null), 'browser');
  runner.start('http://127.0.0.1:1'); // Browser tasks remain queued; no server browser is available.

  for (let i = 0; i < providers.length; i++) {
    const id = enqueue('modelOnce', { providerId: `p${i}`, model: 'native-model', options: { messages: [{ role: 'user', content: 'hello' }] }, baseUrl: 'https://untrusted.example', apiKey: 'untrusted' });
    assert.equal((await completed(id)).result.content, 'Node result');
    assert.ok(requests.at(-1).url.startsWith(`https://p${i}.example/v1/`));
    assert.ok(JSON.stringify(requests.at(-1).init.headers).includes('private-model-key'));
    assert.ok(!JSON.stringify(get(id).result).includes('private-model-key'));
  }
  const forbidden = enqueue('modelOnce', { providerId: 'unknown', model: 'x', options: { messages: [] } });
  await until(() => get(forbidden).status === 'failed');
  assert.equal(get(forbidden).executor, 'node', 'native failures never fall back to Chromium');
  assert.equal(get(forbidden).error, 'model_not_configured');
  httpStatus = 401;
  const denied = enqueue('modelOnce', { providerId: 'p0', model: 'x', options: { messages: [] } });
  await until(() => get(denied).status === 'failed');
  assert.equal(get(denied).error, 'model_http_401');
  httpStatus = 200;
  put('preferences', 'savedModels', { id: 'savedModels', value: [{ providerId: 'p0', model: 'native-model', maxOutputTokens: 128 }] });
  await completed(enqueue('modelOnce', { providerId: 'p0', model: 'native-model', options: { max_tokens: 2000, messages: [] } }));
  assert.equal(JSON.parse(requests.at(-1).init.body).max_tokens, 128, 'native requests preserve saved capability overrides');
  put('preferences', 'savedModels', { id: 'savedModels', value: [] });

  const videoId = 'course';
  put('videos', videoId, { id: videoId, name: 'Test course', duration: 60 });
  for (let i = 0; i < 3; i++) put('segments', i + 1, { id: i + 1, videoId, idx: i, start: i * 10, end: (i + 1) * 10, text: `字幕内容 ${i}`, status: 1 });
  put('chatSessions', 10, { id: 10, videoId: '__library_assistant__', title: '新会话', createdAt: Date.now() });
  reply = '这是由 Node 服务器返回的回答。';
  const chatTask = await completed(enqueue('chat', { sessionId: 10, text: '你好' }, 'session:10'));
  assert.equal(chatTask.executor, 'node');
  assert.equal(chatTask.result.content, reply);
  assert.ok(chatTask.result.userRowId, 'completion acknowledges both committed message identities');
  for (const id of [chatTask.result.userRowId, chatTask.result.rowId]) {
    assert.equal(records.get(owner, 'chats', id).taskId, chatTask.id, 'progress and committed rows share a turn identity');
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM cloud_records WHERE owner_id=? AND table_name='chats' AND value IS NOT NULL").get(owner).count, 2);
  reply = '字幕里提到了测试内容。';
  const qaTask = await completed(enqueue('qa', { videoId, sessionId: 10, text: '课程提到了什么？' }, 'session:10:qa'));
  assert.equal(qaTask.executor, 'node');
  assert.equal(qaTask.result.content, reply);
  assert.ok(qaTask.result.rowId);
  const conversation = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='chats' AND value IS NOT NULL").all(owner)
    .map(row => JSON.parse(row.value)).sort((a, b) => a.createdAt - b.createdAt);
  assert.deepEqual(conversation.map(row => row.role), ['user', 'assistant', 'user', 'assistant']);
  assert.ok(conversation.every((row, index) => !index || row.createdAt > conversation[index - 1].createdAt), 'server commits a strictly ordered timeline for both chat and qa');
  put('cards', 100, { id: 100, videoId, q: 'old', a: 'old' });
  put('cards', 100, { id: 100, videoId, q: 'other account', a: 'untouched' }, other);
  reply = '[{"time":"00:10","q":"什么是测试课程？","a":"用于测试的课程。"}]';
  const cards = await completed(enqueue('cards', { videoId }, `course:${videoId}`));
  assert.equal(cards.result, 1);
  const cardRows = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='cards' AND value IS NOT NULL").all(owner).map(r => JSON.parse(r.value));
  assert.equal(cardRows.length, 1); assert.equal(cardRows[0].status, 0);
  assert.equal(records.get(owner, 'cards', 100), null);
  assert.equal(records.get(other, 'cards', 100).q, 'other account');
  assert.equal(cards.progress.done, cards.progress.total);

  reply = '[{"time":"00:10","author":"小林","role":"ask","text":"这段内容应该怎么理解？","replies":[{"author":"助教","role":"answer","text":"可以结合前面的例子来理解。"}]}]';
  assert.deepEqual((await completed(enqueue('comments', { videoId }, `course:${videoId}`))).result, { threads: 1, posts: 2 });
  const posts = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='comments' AND value IS NOT NULL").all(owner).map(r => JSON.parse(r.value));
  assert.equal(posts.find(post => post.parentId).parentId, posts.find(post => !post.parentId).id);

  reply = '[{"time":"00:10","text":"如何解释这个概念？"},{"time":"00:15","text":"重复时段应被过滤"}]';
  assert.equal((await completed(enqueue('danmaku', { videoId }, `course:${videoId}`))).result, 1);
  reply = '{"type":"para","text":"改写之后的内容。"}';
  assert.deepEqual((await completed(enqueue('handoutEdit', { original: { type: 'para', text: '原文。' }, instruction: '改写', ctx: { title: '测试' } }))).result,
    { type: 'para', text: '改写之后的内容。' });

  for (const format of ['md', 'docx']) {
    const id = `material-${format}`;
    const bytes = format === 'md' ? Buffer.from('# 标题\n\n这是用于检索的材料正文。')
      : zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>这是用于检索的 Word 材料正文。</w:t></w:r></w:p></w:body></w:document>') });
    const file = await upload(bytes, `test.${format}`);
    put('videos', id, { id, name: id, kind: 'material', materialFormat: format, scanned: 1 });
    put('courseFiles', id, { id, fileId: file.id, mimeType: 'application/octet-stream', directory: 'materials', size: bytes.length });
    const task = await completed(enqueue('material', { videoId: id, format }, `course:${id}`));
    assert.ok(task.result.parsed > 0); assert.equal(task.result.scanned, false);
    assert.equal(records.get(owner, 'videos', id).scanned, undefined);
    if (format === 'md') {
      const edited = await upload(Buffer.from('# 编辑后的标题\n\n编辑后的正文，不应解析原始文件。'), 'edited.md');
      put('files', id, { id, blob: { $file: edited.id } });
      await completed(enqueue('material', { videoId: id, format }, `course:${id}`));
      const indexed = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='materialBlocks' AND value IS NOT NULL").all(owner)
        .map(r => JSON.parse(r.value)).filter(r => r.materialId === id);
      assert.ok(indexed.some(r => r.text.includes('编辑后的正文')));
    }
  }

  const foreign = await upload(Buffer.from('不可跨账号读取'), 'private.md', 'text/markdown', other);
  put('videos', 'foreign', { id: 'foreign', kind: 'material', name: 'invalid file owner' });
  put('courseFiles', 'foreign', { id: 'foreign', fileId: foreign.id });
  const foreignTask = enqueue('material', { videoId: 'foreign', format: 'md' });
  await until(() => get(foreignTask).status === 'failed');
  assert.equal(get(foreignTask).error, '文件不存在');

  const oversized = await upload(Buffer.from('placeholder'), 'oversized.md');
  const oversizedFile = store.db.prepare('SELECT storage_name FROM files WHERE id=?').get(oversized.id);
  fs.truncateSync(path.join(filesDir, oversizedFile.storage_name), 128 * 1024 * 1024 + 1);
  put('videos', 'oversized', { id: 'oversized', kind: 'material', name: 'oversized' });
  put('courseFiles', 'oversized', { id: 'oversized', fileId: oversized.id });
  const oversizedTask = enqueue('material', { videoId: 'oversized', format: 'md' });
  await until(() => get(oversizedTask).status === 'failed');
  assert.ok(get(oversizedTask).error.includes('128 MiB'));
  const bomb = Buffer.from(zipSync({ 'word/document.xml': strToU8('<w:document/>') }));
  const central = bomb.indexOf(Buffer.from('504b0102', 'hex'));
  assert.ok(central >= 0);
  bomb.writeUInt32LE(33 * 1024 * 1024, central + 24);
  const bombFile = await upload(bomb, 'oversized-xml.docx');
  put('videos', 'bomb', { id: 'bomb', kind: 'material', name: 'oversized XML' });
  put('courseFiles', 'bomb', { id: 'bomb', fileId: bombFile.id });
  const bombTask = enqueue('material', { videoId: 'bomb', format: 'docx' });
  await until(() => get(bombTask).status === 'failed');
  assert.ok(get(bombTask).error.includes('Word 正文过大'));

  const savedCards = JSON.stringify(store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='cards'").all(owner));
  httpStatus = 429;
  const requestsBeforeBackoff = requests.length;
  const backoff = enqueue('cards', { videoId }, `course:${videoId}`);
  await until(() => requests.length > requestsBeforeBackoff);
  const cancelledAt = Date.now();
  store.db.prepare("UPDATE cloud_tasks SET status='cancelled' WHERE id=?").run(backoff);
  await runner.cancel(backoff);
  assert.ok(Date.now() - cancelledAt < 1000, 'cancel interrupts Retry-After backoff rather than waiting 60 seconds');
  assert.equal(JSON.stringify(store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='cards'").all(owner)), savedCards, 'cancellation leaves the previous output unchanged');
  httpStatus = 200;

  block = true;
  const requestsBeforeCancel = requests.length;
  const cancelled = enqueue('modelOnce', { providerId: 'p0', model: 'x', options: { messages: [] } });
  await until(() => requests.length > requestsBeforeCancel);
  store.db.prepare("UPDATE cloud_tasks SET status='cancelled' WHERE id=?").run(cancelled);
  await runner.cancel(cancelled);
  assert.equal(get(cancelled).status, 'cancelled');
  assert.ok(aborted > 0, 'cancel aborts the in-flight model HTTP request');

  const interrupted = enqueue('modelOnce', { providerId: 'p0', model: 'x', options: { messages: [] } });
  await until(() => get(interrupted).status === 'running');
  await runner.close();
  assert.equal(get(interrupted).status, 'interrupted');
  block = false; reply = 'after restart';
  const queued = enqueue('modelOnce', { providerId: 'p0', model: 'x', options: { messages: [] } });
  const { CloudTaskRunner: ProductionRunner } = await import('../apps/api/dist/apps/api/src/cloud/tasks.js');
  runner = new ProductionRunner(store, { records, configuration, filesDir, fetch: mockFetch });
  runner.start('http://127.0.0.1:1');
  await completed(queued);
  assert.equal(get(interrupted).status, 'interrupted', 'interrupted tasks require explicit retry');

  // Real FFmpeg, not a mock: generate video, decode it in a subprocess, persist PNG cover.
  const sample = await runMediaProcess(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10', '-t', '1', '-c:v', 'mpeg4', '-f', 'matroska', 'pipe:1'], new AbortController().signal);
  const file = await upload(sample, 'video.mkv');
  // Deliberately stale duration: seeking past EOF must retry the initial frame.
  put('videos', videoId, { ...records.get(owner, 'videos', videoId), duration: 60 });
  put('courseFiles', videoId, { id: videoId, fileId: file.id, mimeType: 'video/x-matroska', directory: 'videos', size: sample.length });
  const coverTask = await completed(enqueue('cover', { videoId }, `course:${videoId}`), 'media');
  assert.equal(coverTask.result, true);
  const cover = records.get(owner, 'covers', videoId);
  assert.equal(cover.w, 320); assert.equal(cover.h, 180);
  assert.equal(cover.ts, 0);
  const png = store.db.prepare('SELECT storage_name FROM files WHERE id=?').get(cover.blob.$file);
  assert.equal(fs.readFileSync(path.join(filesDir, png.storage_name)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  put('frames', 200, { id: 200, videoId, ts: 0.5, kind: 'slide', blob: cover.blob });
  assert.equal((await completed(enqueue('cover', { videoId, options: { force: true } }, `course:${videoId}`), 'media')).result, true);
  assert.equal(records.get(owner, 'covers', videoId).source, 'slide');
  assert.equal(records.get(owner, 'covers', videoId).ts, 0.5);
  put('covers', videoId, { ...records.get(owner, 'covers', videoId), source: 'user' });
  assert.equal((await completed(enqueue('cover', { videoId, options: { force: true } }, `course:${videoId}`), 'media')).result, false);
  assert.equal(records.get(owner, 'covers', videoId).source, 'user');

  const controller = new AbortController();
  const processTask = runMediaProcess(['-e', 'setInterval(() => {}, 1000)'], controller.signal, { executable: process.execPath });
  controller.abort();
  await assert.rejects(processTask, error => error.name === 'AbortError');
  await assert.rejects(runMediaProcess(['-e', 'process.stdout.write("x".repeat(1000))'], new AbortController().signal,
    { executable: process.execPath, maxBytes: 10 }), /输出超出限制/);
  await assert.rejects(runMediaProcess(['-e', 'setInterval(() => {}, 1000)'], new AbortController().signal,
    { executable: process.execPath, timeoutMs: 20 }), /超时/);

  const fallback = enqueue('qa', { sessionId: 1 });
  await until(() => get(fallback).status === 'failed');
  assert.equal(get(fallback).executor, 'node');
  assert.equal(get(fallback).error, '问答上下文不存在');
  console.log('Native protocols/text/materials, durable routing/cancellation/restart, real FFmpeg and external browser queue checks passed');
} finally {
  await runner.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true });
}
