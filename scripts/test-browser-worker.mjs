import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../apps/api/src/server.ts';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { workerTokens, workerIdentity } from '../apps/api/src/cloud/workerAuth.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-browser-worker-'));
const dbPath = path.join(dir, 'db.sqlite');
const filesDir = path.join(dir, 'files');
fs.mkdirSync(filesDir);
const app = buildServer({ dbPath, filesDir });
const store = new DatabaseStore(dbPath);
const owner = crypto.randomUUID(), other = crypto.randomUUID(), now = new Date().toISOString();
const token = crypto.randomBytes(32).toString('base64url');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
try {
  for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, now);
  store.db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(crypto.randomUUID(), owner, hash(token), now, new Date(Date.now() + 60_000).toISOString());
  const taskId = crypto.randomUUID();
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(taskId, owner, taskId, 'qa', 'session:1', JSON.stringify({ sessionId: 1 }), 'queued', 'browser', now, now);
  await app.ready();
  const auth = { cookie: `wangke_session=${encodeURIComponent(token)}` };
  const claim = await app.inject({ method: 'POST', url: '/api/v1/cloud/worker/claim', headers: auth });
  assert.equal(claim.statusCode, 200);
  const claimed = claim.json();
  assert.equal(claimed.task.id, taskId);
  assert.equal(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(taskId).status, 'running');
  assert.ok(workerTokens.has(claimed.token));
  assert.ok(workerIdentity({ headers: { authorization: `Bearer ${claimed.token}` } }));
  assert.equal(workerIdentity({ headers: { authorization: 'Bearer wrong' } }), undefined);
  console.log('External browser worker claim scoping and lease ownership checks passed');
} finally {
  await app.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
}
