import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/server-drain-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { workerTokens, workerTokenHash } = await import('../apps/api/src/cloud/workerAuth.ts');
const app = buildServer();
let store;
try {
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: 'drain-test-password' } })).statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'drain-test-password' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  store = new DatabaseStore(path.join(directory, 'db/wangke.sqlite'));
  const owner = store.db.prepare('SELECT id FROM users').get().id;
  const task = crypto.randomUUID(), token = crypto.randomUUID(), at = new Date().toISOString();
  workerTokens.set(token, { id: owner, taskId: task, expiresAt: Date.now() + 60000 });
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at,worker_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(task, owner, task, 'modelOnce', task, '{}', 'running', at, at, workerTokenHash(token));
  assert.equal((await fetch(`${origin}/api/v1/ready`)).status, 200);
  await assert.rejects(() => app.drainForRelease(-1), /invalid_drain_deadline/);
  const drain = app.drainForRelease(1000);
  assert.equal(app.drainForRelease(1000), drain, 'drain is one-way and idempotent');
  assert.equal((await fetch(`${origin}/api/v1/ready`)).status, 503);
  assert.equal((await fetch(`${origin}/api/v1/health`)).status, 200, 'liveness is distinct from readiness');
  for (const url of ['/api/v1/cloud/worker/claim', '/api/v1/threads', '/api/v1/auth/password/login']) {
    const result = await fetch(`${origin}${url}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(result.status, 503, url);
    assert.equal((await result.json()).error, 'api_draining');
  }
  // A live, task-scoped worker keeps the existing authorization/lease checks.
  const report = await fetch(`${origin}/api/v1/cloud/tasks/${task}/report`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ progress: { content: 'finishing' } }) });
  assert.equal(report.status, 200, await report.text());
  const denied = await fetch(`${origin}/api/v1/threads`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403, 'drain exemption does not expand worker scope');
  assert.equal(await drain, true);
  await app.close();
  workerTokens.delete(token);
  console.log('Server drain: readiness, external write/claim rejection, scoped loopback reports and idempotent close passed (not a consistent snapshot)');
} finally {
  await app.close(); store?.close(); fs.rmSync(directory, { recursive: true, force: true });
}
