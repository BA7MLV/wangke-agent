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
  assert.deepEqual(store.getState().messages.map(m => m.key), [`cloud-user-${network.task.id}`, `cloud-answer-${network.task.id}`]);
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

db.close();
