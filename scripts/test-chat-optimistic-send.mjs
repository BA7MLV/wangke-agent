#!/usr/bin/env node
// Real store + IndexedDB + cloud submission; all HTTP is held locally, no model/key needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { webTestAssets } from './lib/web-test-assets.mjs';

Object.assign(globalThis, { indexedDB, IDBKeyRange });
const root = new URL('..', import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), 'chat-optimistic-'));
writeFileSync(join(out, 'entry.ts'), [
  `export { useCourseChat, reflectCloudTasks } from '${root}apps/web/src/store/courseChat.ts';`,
  `export { db } from '${root}apps/web/src/store/db.ts';`,
  `export { cloud } from '${root}apps/web/src/cloud/state.ts';`,
  `export { applyCloudConfig } from '${root}apps/web/src/cloud/sync.ts';`,
  `export { LIBRARY_ASSISTANT_ID } from '${root}apps/web/src/harness/libraryAssistant.ts';`,
].join('\n'));
await build({
  entryPoints: [join(out, 'entry.ts')], outfile: join(out, 'bundle.mjs'),
  bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
  loader: { '.md': 'text' }, define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [webTestAssets],
});
const { useCourseChat: store, db, cloud, applyCloudConfig, reflectCloudTasks, LIBRARY_ASSISTANT_ID } = await import(pathToFileURL(join(out, 'bundle.mjs')).href);
cloud.enabled = true;
const model = { providerId: '', model: '' };
applyCloudConfig({ providers: [], llmModel: model, visionModel: model, asrModel: model, policy: { maxSteps: 100 } });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let network;
globalThis.fetch = async (url, init) => {
  if (url.includes('/records?')) {
    network.syncReached.resolve();
    await network.sync.promise;
    return Response.json({ records: [], cursor: 0, more: false });
  }
  if (url.endsWith('/tasks') && init?.method === 'POST') {
    const request = JSON.parse(init.body);
    network.task = { id: crypto.randomUUID(), kind: 'chat', resource: request.resource, input: request.input,
      status: 'queued', progress: null, result: null, error: null, createdAt: new Date().toISOString() };
    network.postReached.resolve();
    await network.post.promise;
    return Response.json(network.task);
  }
  throw new Error(`Unexpected request: ${url}`);
};
async function fresh(draft = '立即显示这条消息') {
  network = { sync: deferred(), syncReached: deferred(), post: deferred(), postReached: deferred() };
  const row = { videoId: LIBRARY_ASSISTANT_ID, title: '新会话', createdAt: Date.now() };
  const id = await db.chatSessions.add(row);
  store.setState({ ready: true, activeId: id, loaded: true, messages: [], sessions: [{ ...row, id }],
    loading: false, runningIds: [], draft, queued: [], pendingAsk: null, pendingPlan: null,
    historyError: null, skillIds: undefined, mcpServerIds: undefined, contextCourses: [], sendMode: 'queue' });
  return id;
}

await test('shows user + preparing state before sync or task acceptance; polls do not erase them', async () => {
  const id = await fresh();
  const sending = store.getState().send(store.getState().draft);
  assert.deepEqual(store.getState().messages.map(m => m.role), ['user', 'ai']);
  assert.equal(store.getState().messages[0].content, '立即显示这条消息');
  assert.equal(store.getState().messages[1].processPhase, 'preparing');
  assert.equal(store.getState().messages[1].streaming, true);
  assert.equal(store.getState().draft, '');
  await network.syncReached.promise;
  await reflectCloudTasks([], true);
  assert.equal(store.getState().messages.length, 2);
  assert.equal(store.getState().loading, true);
  assert(store.getState().runningIds.includes(id));
  network.sync.resolve();
  await network.postReached.promise;
  await reflectCloudTasks([{ ...network.task, progress: { content: '先到的进度' } }]);
  assert.equal(store.getState().messages.length, 2, 'early poll must not duplicate the optimistic turn');
  network.post.resolve();
  await sending;
  assert(store.getState().messages.every(m => m.taskId === network.task.id));
  assert(store.getState().messages.every(m => m.key.startsWith('cloud-pending-')));
  await reflectCloudTasks([{ ...network.task, status: 'running', progress: { content: '正在回答' } }]);
  assert.equal(store.getState().messages.length, 2);
  assert.equal(store.getState().messages[1].content, '正在回答');
});

await test('submission failure ends placeholder and restores draft without hiding the error', async () => {
  await fresh('网络失败时保留');
  const sending = store.getState().send(store.getState().draft);
  network.sync.resolve();
  await network.postReached.promise;
  network.post.reject(new Error('模拟网络断开'));
  await sending;
  assert.equal(store.getState().loading, false);
  assert.equal(store.getState().draft, '网络失败时保留');
  assert.equal(store.getState().messages[1].streaming, false);
  assert.equal(store.getState().messages[1].error, true);
  assert.match(store.getState().messages[1].content, /发送失败.*模拟网络断开/);
  await reflectCloudTasks([]);
  assert.equal(store.getState().messages.length, 2);
});

await test('sync failure is visible and does not overwrite text typed while sending', async () => {
  await fresh();
  const sending = store.getState().send(store.getState().draft);
  await network.syncReached.promise;
  store.getState().setDraft('刚输入的新草稿');
  network.sync.reject(new Error('同步失败'));
  await sending;
  assert.equal(store.getState().draft, '刚输入的新草稿');
  assert.equal(store.getState().messages[1].error, true);
  assert.equal(store.getState().loading, false);
});

await test('switching sessions while submitting keeps both the turn and the other draft isolated', async () => {
  const id = await fresh('后台提交');
  const sending = store.getState().send(store.getState().draft);
  await network.syncReached.promise;
  await store.getState().createSession();
  store.getState().setDraft('新会话的草稿');
  network.sync.resolve();
  await network.postReached.promise;
  network.post.resolve();
  await sending;
  assert.equal(store.getState().draft, '新会话的草稿');
  assert.equal(store.getState().messages.length, 0);
  await store.getState().loadSession(id);
  assert.equal(store.getState().messages[0].content, '后台提交');
  assert.equal(store.getState().messages.length, 2);
});

await test('first message in a new session is visible while network is blocked', async () => {
  await fresh('新会话首条消息');
  await store.getState().createSession();
  store.getState().setDraft('新会话首条消息');
  const sending = store.getState().send(store.getState().draft);
  await network.syncReached.promise;
  assert.notEqual(store.getState().activeId, null);
  assert.equal(store.getState().messages[0].content, '新会话首条消息');
  assert.equal(store.getState().messages[1].streaming, true);
  await reflectCloudTasks([], true);
  assert.equal(store.getState().messages.length, 2);
  network.sync.resolve();
  await network.postReached.promise;
  network.post.resolve();
  await sending;
  assert.equal(store.getState().messages.length, 2);
});

async function streamedTurn() {
  const id = await fresh();
  const task = { id: crypto.randomUUID(), kind: 'chat', resource: `session:${id}`, input: { sessionId: id, text: '同步不能清空回答' },
    status: 'running', progress: { content: '已经显示的回答' }, result: null, error: null, createdAt: new Date().toISOString() };
  await reflectCloudTasks([task]);
  const userRowId = 100000 + id * 2;
  const rowId = userRowId + 1;
  return { id, task, completed: { ...task, status: 'completed', result: { content: '最终完整回答', rowId, userRowId } },
    rows: [
      { id: userRowId, taskId: task.id, sessionId: id, videoId: LIBRARY_ASSISTANT_ID, role: 'user', content: task.input.text, createdAt: 1 },
      { id: rowId, taskId: task.id, sessionId: id, videoId: LIBRARY_ASSISTANT_ID, role: 'assistant', content: '最终完整回答', createdAt: 2 },
    ] };
}

await test('completion before sync never exposes empty/loading UI; partial sync merges in place', async () => {
  const { id, task, completed, rows } = await streamedTurn();
  const keys = store.getState().messages.map(m => m.key);
  const unsubscribe = store.subscribe(state => {
    assert.equal(state.activeId, id);
    assert.equal(state.loaded, true, 'background refresh must not enter initial loading');
    assert(state.messages.length >= 2, 'no transient welcome screen');
  });
  try {
    await reflectCloudTasks([completed]);
    assert.equal(store.getState().loading, false);
    assert.equal(store.getState().messages[1].streaming, false);
    assert.equal(store.getState().messages[1].content, '最终完整回答');
    await reflectCloudTasks([task]); // stale running snapshot cannot restart a finished turn
    assert.equal(store.getState().loading, false);
    assert.equal(store.getState().messages[1].content, '最终完整回答');
    await db.chats.add(rows[0]);
    await reflectCloudTasks([completed], true);
    assert.equal(store.getState().messages.length, 2);
    assert.equal(store.getState().messages[1].syncPending, true);
    await db.chats.add(rows[1]);
    await reflectCloudTasks([completed], true);
    assert.deepEqual(store.getState().messages.map(m => m.key), keys);
    assert(store.getState().messages.every(m => !m.syncPending));
    await reflectCloudTasks([completed], true);
    assert.equal(store.getState().messages.length, 2, 'duplicate completion is idempotent');
  } finally { unsubscribe(); }
});

await test('background completion and delayed sync cannot switch the foreground session', async () => {
  const { id, completed, rows } = await streamedTurn();
  await store.getState().createSession();
  store.getState().setDraft('正在写的新问题');
  await reflectCloudTasks([completed]);
  assert.equal(store.getState().activeId, null);
  assert.equal(store.getState().draft, '正在写的新问题');
  await db.chats.bulkAdd(rows);
  await reflectCloudTasks([completed], true);
  assert.equal(store.getState().activeId, null);
  await store.getState().loadSession(id);
  assert.equal(store.getState().messages.length, 2);
  assert.equal(store.getState().messages[1].content, '最终完整回答');
  assert.equal(store.getState().loading, false);
});

await test('failed/cancelled generation preserves partial output instead of returning home', async () => {
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    const { task } = await streamedTurn();
    await reflectCloudTasks([{ ...task, status, error: '连接中断' }]);
    assert.equal(store.getState().loading, false);
    assert.equal(store.getState().messages[1].content, '已经显示的回答');
    assert.equal(store.getState().messages[1].interrupted, true);
  }
});

await test('history read failure retains output and a later retry recovers', async () => {
  const { completed, rows } = await streamedTurn();
  const original = db.chats.bulkGet;
  db.chats.bulkGet = async () => { throw new Error('模拟本地读取失败'); };
  try { await reflectCloudTasks([completed]); }
  finally { db.chats.bulkGet = original; }
  assert.equal(store.getState().messages[1].content, '最终完整回答');
  assert.match(store.getState().historyError, /模拟本地读取失败/);
  await db.chats.bulkAdd(rows);
  await reflectCloudTasks([completed], true);
  assert.equal(store.getState().historyError, null);
  assert.equal(store.getState().messages.length, 2);
});

await test('an older refresh cannot overwrite a newer message snapshot', async () => {
  const { completed } = await streamedTurn();
  const original = db.chats.bulkGet;
  const reached = deferred(), release = deferred();
  db.chats.bulkGet = async (...args) => { reached.resolve(); await release.promise; return original.apply(db.chats, args); };
  const old = reflectCloudTasks([completed]);
  await reached.promise;
  db.chats.bulkGet = original;
  store.setState(state => ({ messages: [...state.messages, { key: 'new-question', role: 'user', content: '较新的消息' }] }));
  release.resolve();
  await old;
  assert.equal(store.getState().messages.at(-1).content, '较新的消息');
});

await test('late initial history cannot erase progress received while loading', async () => {
  const id = await db.chatSessions.add({ videoId: LIBRARY_ASSISTANT_ID, title: '加载竞态', createdAt: Date.now() });
  const original = db.chatSessions.get;
  const reached = deferred(), release = deferred();
  db.chatSessions.get = async (...args) => { reached.resolve(); await release.promise; return original.apply(db.chatSessions, args); };
  const loading = store.getState().loadSession(id);
  await reached.promise;
  db.chatSessions.get = original;
  await reflectCloudTasks([{ id: crypto.randomUUID(), kind: 'chat', status: 'running', input: { sessionId: id, text: '问题' },
    progress: { content: '读取历史期间收到的新回答' }, createdAt: new Date().toISOString() }]);
  release.resolve();
  await loading;
  assert.equal(store.getState().messages.at(-1).content, '读取历史期间收到的新回答');
  assert.equal(store.getState().loading, true);
});

await test('confirmed deletion still removes persisted messages without replaying completed tasks', async () => {
  const { completed, rows } = await streamedTurn();
  await db.chats.bulkAdd(rows);
  await reflectCloudTasks([completed], true);
  await db.chats.delete(rows[1].id);
  await reflectCloudTasks([completed], true);
  assert.equal(store.getState().messages.length, 1);
  assert.equal(store.getState().messages[0].role, 'user');
});

db.close();
