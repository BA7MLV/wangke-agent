import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-cloud-files-'));
Object.assign(process.env, { DATA_DIR: dir, FILES_DIR: path.join(dir, 'files'), BOOTSTRAP_SECRET_FILE: path.join(dir, 'config/bootstrap-secret'), NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1' });
delete process.env.MAX_FILE_BYTES;
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(dir, 'db.sqlite'), staticDir: path.join(dir, 'empty') });
try {
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'streaming-test-password' } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'streaming-test-password' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  const chunk = Buffer.alloc(1024 * 1024, 97);
  const upload = await fetch(`${origin}/api/v1/files`, { method: 'POST', duplex: 'half', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'boundary.bin' }, body: Readable.from((function* () { for (let i = 0; i < 512; i++) yield chunk; })()) });
  assert.equal(upload.status, 201);
  const file = await upload.json();
  assert.equal(file.sizeBytes, 512 * 1024 * 1024);
  const ranged = await fetch(`${origin}/api/v1/files/${file.id}`, { headers: { cookie, range: 'bytes=-17' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes ${file.sizeBytes - 17}-${file.sizeBytes - 1}/${file.sizeBytes}`);
  assert.equal((await ranged.text()), 'a'.repeat(17));
  const badRange = await fetch(`${origin}/api/v1/files/${file.id}`, { headers: { cookie, range: `bytes=${file.sizeBytes}-` } });
  assert.equal(badRange.status, 416);
  const oversized = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { cookie, 'content-type': 'application/octet-stream', 'content-length': String(file.sizeBytes + 1) }, payload: Buffer.alloc(1) });
  assert.equal(oversized.statusCode, 413);
  assert.equal(fs.readdirSync(process.env.FILES_DIR).length, 1);
  console.log('Cloud files: real HTTP 512 MiB chunked upload, Range boundary, oversized rejection and cleanup passed');
} finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
