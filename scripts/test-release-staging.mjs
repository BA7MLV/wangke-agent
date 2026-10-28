import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { fenceRemoteWorkers } from '../apps/api/src/storage/release.ts';
import { workerTokens, workerTokenHash } from '../apps/api/src/cloud/workerAuth.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/release-staging-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/secret'), CLOUD_WORKER_DISABLED: '1', API_RELEASE_ID: crypto.randomUUID(), API_RELEASE_TOKEN: crypto.randomBytes(32).toString('hex') });
const dbPath = path.join(directory, 'db/wangke.sqlite');
const seed = new DatabaseStore(dbPath);
const owner = crypto.randomUUID(); seed.db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, 'Owner', new Date().toISOString());
const config = new CloudConfiguration(seed, path.join(directory, 'config'));
config.save(owner, { ...config.get(owner), providers: [{ id: 'fake', name: 'Fake', protocol: 'openai-chat', baseUrl: 'https://fake.invalid/v1', apiKey: 'test', serves: ['chat'], catalogId: '' }], llmModel: { providerId: 'fake', model: 'fake' } });
const service = new BotApplicationService(seed, { enqueue() {}, cancel() {} });
const thread = service.create(owner, 'bot', 'Must stay staged');
service.send(owner, thread.id, { clientNonce: 'held', content: 'Do not start until activation' });
seed.close();
const { buildServer } = await import('../apps/api/src/server.ts');
let calls = 0, app, workerStore;
const oldToken = crypto.randomUUID(), browserTask = crypto.randomUUID();
const fetcher = async () => { calls++; return Response.json({ choices: [{ message: { tool_calls: [{ id: 'done', type: 'function', function: { name: 'send_message', arguments: '{"kind":"text","text":"Activated"}' } }] } }] }); };
try {
  app = buildServer({ fetch: fetcher });
  let origin = await app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await fetch(`${origin}/api/v1/ready`)).status, 503);
  assert.equal((await fetch(`${origin}/api/v1/resources`)).status, 503, 'even read-side migrations stay fenced');
  assert.equal((await fetch(`${origin}/api/v1/cloud/worker/claim`, { method: 'POST' })).status, 503);
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(calls, 0, 'no task/IM scheduler admission before activation');
  const headers = { 'x-deployment-token': process.env.API_RELEASE_TOKEN };
  assert.equal((await fetch(`${origin}/api/v1/deployment/status`)).status, 403);
  assert.equal((await app.inject({ url: '/api/v1/deployment/status', headers, remoteAddress: '203.0.113.10' })).statusCode, 403, 'proxy/external requests cannot use the control token');
  const status = await (await fetch(`${origin}/api/v1/deployment/status`, { headers })).json();
  assert.equal(status.held, true); assert.match(status.database.schemaHash, /^[a-f0-9]{64}$/);
  assert.equal((await fetch(`${origin}/api/v1/deployment/activate`, { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/ready`)).status, 200);
  for (let i = 0; i < 200 && !calls; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(calls > 0);
  assert.equal((await fetch(`${origin}/api/v1/cloud/tasks/old-attempt/report`, { method: 'POST', headers: { authorization: 'Bearer old-process-token', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  workerStore = new DatabaseStore(dbPath);
  const at = new Date().toISOString();
  workerTokens.set(oldToken, { id: owner, taskId: browserTask, expiresAt: Date.now() + 600000 });
  workerStore.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at,executor,worker_id,lease_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(browserTask, owner, browserTask, 'modelOnce', browserTask, '{}', 'running', at, at, 'browser', workerTokenHash(oldToken), new Date(Date.now() + 600000).toISOString());
  const oldHeaders = { authorization: `Bearer ${oldToken}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/v1/cloud/tasks/${browserTask}/report`, { method: 'POST', headers: oldHeaders, body: '{"progress":{"content":"before stop"}}' })).status, 200, 'real old scoped credential works before the switch');
  await app.drainForRelease(2000); await app.close();
  fenceRemoteWorkers(workerStore.db);
  assert.equal(workerTokens.has(oldToken), true, 'same-process test deliberately retains the bearer entry');
  app = buildServer({ fetch: fetcher }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await fetch(`${origin}/api/v1/ready`)).status, 200, 'activation is durable across a container/process restart');
  // Deliberately retain the old in-memory bearer entry (stronger than a real
  // process restart) to prove the persistent lease fence itself rejects writes.
  const stale = await fetch(`${origin}/api/v1/cloud/tasks/${browserTask}/report`, { method: 'POST', headers: oldHeaders, body: '{"progress":{"content":"stale write"}}' });
  assert.equal(stale.status, 403); assert.equal((await stale.json()).error, 'worker_task_inactive');
  assert.equal(workerStore.db.prepare('SELECT worker_id FROM cloud_tasks WHERE id=?').get(browserTask).worker_id, null);
  await app.drainForRelease(2000);
  assert.equal((await fetch(`${origin}/api/v1/deployment/activate`, { method: 'POST', headers })).status, 503, 'drain cannot be reopened');
  console.log('Release staging: no external/read-side/worker/scheduler admission, local authenticated control, real Bot activation, stale-token rejection and durable restart passed');
} finally {
  await app?.close(); workerTokens.delete(oldToken); workerStore?.close(); fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.API_RELEASE_ID; delete process.env.API_RELEASE_TOKEN;
}
