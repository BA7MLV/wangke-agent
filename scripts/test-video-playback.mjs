// Read-only media HTTP contract, including old unmigrated imports.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-video-http-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
const db = new Database(path.join(directory, 'db.sqlite'));
let cookie = '';
const call = async (method, url, payload, status = 200, headers = {}) => {
  const result = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie, ...headers }, ...(payload === undefined ? {} : { payload }) });
  assert.equal(result.statusCode, status, `${method} ${url}: ${result.body}`);
  return result;
};
const url = '/resources/courses/progressive-video';
const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const snapshot = () => JSON.stringify({ records: db.prepare('SELECT * FROM cloud_records ORDER BY table_name,record_key').all(),
  placements: db.prepare('SELECT * FROM resource_files').all(), projects: db.prepare('SELECT * FROM projects').all() });
try {
  await call('POST', '/bootstrap/initialize', { adminPassword: 'video-http-password' }, 201, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() });
  cookie = (await call('POST', '/auth/password/login', { password: 'video-http-password' })).headers['set-cookie'].split(';')[0];
  const uploaded = (await call('POST', '/files', bytes, 201, { 'content-type': 'application/octet-stream', 'x-file-name': 'test.mp4', 'x-file-mime': 'video/mp4' })).json();
  const entries = [
    ['videos', 'progressive-video', { id: 'progressive-video', name: '渐进播放', mimeType: 'video/mp4', size: bytes.length, duration: 60, createdAt: 1, status: 'new' }],
    ['courseFiles', 'progressive-video', { id: 'progressive-video', fileId: uploaded.id, mimeType: 'video/mp4', size: bytes.length }],
  ];
  await call('POST', '/cloud/records', { mutations: entries.map(([table, key, after]) => ({ id: crypto.randomUUID(), table, key, before: null, after })) });
  const initial = snapshot();
  const head = await call('HEAD', url);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String(bytes.length));
  assert.equal(head.headers['content-type'], 'video/mp4');
  assert.equal(head.headers['content-disposition'], 'inline');
  assert.equal(head.headers['accept-ranges'], 'bytes');
  assert.equal(head.headers['cache-control'], 'private, no-cache');
  assert.ok(head.headers.etag);
  const etag = head.headers.etag;
  for (const [range, start, end] of [['bytes=0-3', 0, 3], ['bytes=10-', 10, bytes.length - 1], ['bytes=-5', bytes.length - 5, bytes.length - 1], ['bytes=32-99999', 32, bytes.length - 1]]) {
    const response = await call('GET', url, undefined, 206, { range });
    assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${bytes.length}`);
    assert.equal(response.headers['content-length'], String(end - start + 1));
    assert.deepEqual(response.rawPayload, bytes.subarray(start, end + 1));
  }
  for (const range of ['bytes=999-', 'bytes=5-2', 'bytes=-0', 'bytes=nope']) {
    const response = await call('GET', url, undefined, 416, { range });
    assert.equal(response.headers['content-range'], `bytes */${bytes.length}`);
  }
  assert.equal((await call('HEAD', url, undefined, 200, { range: 'bytes=0-3' })).headers['content-length'], String(bytes.length));
  assert.deepEqual((await call('GET', url)).rawPayload, bytes);
  assert.equal((await call('GET', url, undefined, 304, { 'if-none-match': `W/${etag}` })).body, '');
  assert.equal((await call('HEAD', url, undefined, 304, { 'if-none-match': etag })).body, '');
  assert.deepEqual((await call('GET', url, undefined, 200, { range: 'bytes=0-3', 'if-range': '"outdated"' })).rawPayload, bytes);
  await call('GET', url, undefined, 206, { range: 'bytes=0-3', 'if-range': etag });
  await call('GET', url, undefined, 401, { cookie: '' });
  await call('HEAD', url, undefined, 401, { cookie: '' });
  // Validators cannot bypass authorization.
  await call('GET', url, undefined, 401, { cookie: '', 'if-none-match': etag });
  const owner = crypto.randomUUID(), token = crypto.randomUUID();
  db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, 'Other', new Date().toISOString());
  db.prepare('INSERT INTO api_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), owner, crypto.createHash('sha256').update(token).digest('hex'), 'test', '2026', '2999');
  await call('GET', url, undefined, 404, { cookie: '', authorization: `Bearer ${token}` });
  assert.equal(snapshot(), initial, 'HEAD/GET/Range must never migrate, index or change records');

  // A normal library visit migrates once; subsequent seeks are still read-only.
  await call('GET', '/resources');
  const placement = db.prepare('SELECT * FROM resource_files WHERE course_id=?').get('progressive-video');
  assert.ok(placement);
  const migrated = snapshot();
  const mappedHead = await call('HEAD', url);
  await call('GET', url, undefined, 206, { range: 'bytes=20-25' });
  assert.equal(snapshot(), migrated);
  const physical = path.join(directory, 'files/projects', placement.project_id, placement.path);
  fs.writeFileSync(physical, Buffer.concat([bytes, Buffer.from('changed')]));
  const changed = await call('GET', url, undefined, 200, { 'if-none-match': mappedHead.headers.etag });
  assert.notEqual(changed.headers.etag, mappedHead.headers.etag);
  fs.unlinkSync(physical);
  await call('HEAD', url, undefined, 404);
  await call('GET', url, undefined, 404);
  assert.ok(fs.existsSync(path.join(directory, 'files', `${uploaded.id}.bin`)), 'backup retained but never resurrected');
  console.log('PASS media HTTP: header-only HEAD, ranges, validators, private auth, legacy fallback, read-only seeks and no resurrection');
} finally {
  await app.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true });
}
