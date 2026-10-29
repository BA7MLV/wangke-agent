import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectStorageUsage, storageUsageReader } from '../apps/api/src/storage/usage.ts';

const temporary = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(temporary, { recursive: true });
const fixture = () => {
  const root = fs.mkdtempSync(path.join(temporary, 'wangke-storage-'));
  const paths = { dataDir: path.join(root, 'data'), filesDir: path.join(root, 'external-files'), dbPath: path.join(root, 'external-db/app.sqlite'), configDir: path.join(root, 'data/config') };
  for (const dir of [paths.dataDir, paths.filesDir, path.dirname(paths.dbPath), paths.configDir]) fs.mkdirSync(dir, { recursive: true });
  const write = (file, size) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.alloc(size, 97)); };
  return { root, paths, write };
};

test('physical files, external roots, SQLite sidecars, hard links, symlinks and refresh', async () => {
  const { root, paths, write } = fixture();
  try {
    for (const [suffix, size] of [['', 101], ['-wal', 53], ['-shm', 29], ['-journal', 7]]) write(paths.dbPath + suffix, size);
    write(path.join(paths.filesDir, 'upload.bin'), 43);
    const workspace = path.join(paths.filesDir, 'projects/id');
    write(path.join(workspace, 'nested/note.md'), 67);
    fs.linkSync(path.join(workspace, 'nested/note.md'), path.join(workspace, 'hard-link.md'));
    write(path.join(paths.filesDir, 'system-files/owner/system/AGENTS.md'), 37);
    write(path.join(paths.configDir, 'credentials.key'), 31);
    write(path.join(paths.dataDir, 'backups/db.sqlite'), 19);
    write(path.join(root, 'outside/secret'), 99999);
    fs.symlinkSync(path.join(root, 'outside'), path.join(workspace, 'external-link'));
    fs.symlinkSync(workspace, path.join(workspace, 'cycle'));
    fs.symlinkSync(path.join(root, 'outside/secret'), path.join(workspace, 'secret-link'));
    const read = storageUsageReader(paths);
    const pending = read();
    assert.equal(read(), pending, 'simultaneous requests share one scan');
    const result = await pending;
    assert.deepEqual(Object.fromEntries(result.categories.map(c => [c.id, c.bytes])), {
      database: 190, files: 43, workspaces: 67, system: 37, other: 50,
    });
    assert.equal(result.totalBytes, 387);
    assert.equal(result.partial, false);
    assert.equal(result.volumes.length, 1, 'one disk is not counted once per directory');
    const capacity = result.volumes[0].capacity;
    assert.ok(capacity.totalBytes > 0 && capacity.availableBytes >= 0 && capacity.usedBytes <= capacity.totalBytes);
    assert.ok(!JSON.stringify(result).includes(root), 'no server paths or filenames in the response');
    write(path.join(workspace, 'new-file'), 71);
    fs.rmSync(path.join(paths.filesDir, 'upload.bin'));
    const next = await read();
    assert.equal(next.totalBytes, 415, 'refresh reflects creation and deletion without a metadata row');
    assert.equal(next.categories.find(c => c.id === 'files').bytes, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('overlapping roots, empty storage and missing required paths', async () => {
  const { root, paths, write } = fixture();
  try {
    paths.filesDir = path.join(paths.dataDir, 'files');
    paths.dbPath = path.join(paths.dataDir, 'db.sqlite');
    fs.mkdirSync(paths.filesDir);
    write(paths.dbPath, 0);
    let result = await collectStorageUsage(paths);
    assert.equal(result.totalBytes, 0);
    assert.equal(result.partial, false);
    write(path.join(paths.filesDir, 'projects/p/file'), 1024);
    write(paths.dbPath, 20);
    result = await collectStorageUsage(paths);
    assert.equal(result.totalBytes, 1044, 'nested roots counted once');
    fs.rmSync(paths.filesDir, { recursive: true });
    result = await collectStorageUsage(paths);
    assert.equal(result.partial, true, 'missing required storage is not reported as an accurate zero');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unreadable directories produce partial results', { skip: process.getuid?.() === 0 }, async () => {
  const { root, paths, write } = fixture();
  const denied = path.join(paths.filesDir, 'projects/denied');
  try {
    write(paths.dbPath, 11);
    write(path.join(denied, 'hidden'), 9999);
    fs.chmodSync(denied, 0);
    const result = await collectStorageUsage(paths);
    assert.equal(result.partial, true);
    assert.equal(result.totalBytes, 11);
  } finally { fs.chmodSync(denied, 0o700); fs.rmSync(root, { recursive: true, force: true }); }
});

test('storage API requires account authentication, denies workers and reads live files', async () => {
  const { root, paths } = fixture();
  Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: paths.dataDir, FILES_DIR: paths.filesDir, BOOTSTRAP_SECRET_FILE: path.join(paths.configDir, 'bootstrap-secret'), CLOUD_WORKER_DISABLED: '1' });
  const { buildServer } = await import('../apps/api/src/server.ts');
  const { workerTokens } = await import('../apps/api/src/cloud/workerAuth.ts');
  const app = buildServer({ dbPath: paths.dbPath });
  try {
    assert.equal((await app.inject('/api/v1/cloud/storage')).statusCode, 401);
    const initialized = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'storage-test-password' } });
    assert.equal(initialized.statusCode, 201, initialized.body);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'storage-test-password' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const read = async () => {
      const response = await app.inject({ url: '/api/v1/cloud/storage', headers: { cookie } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      return response.json();
    };
    const before = await read();
    assert.ok(before.categories.find(c => c.id === 'database').bytes > 0);
    const upload = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'usage-test.bin' }, payload: Buffer.alloc(4096, 97) });
    assert.equal(upload.statusCode, 201, upload.body);
    const after = await read();
    assert.equal(after.categories.find(c => c.id === 'files').bytes - before.categories.find(c => c.id === 'files').bytes, 4096);
    assert.equal(after.partial, false);
    workerTokens.set('storage-worker', { id: login.json().user.id, taskId: 'not-needed', expiresAt: Date.now() + 60000 });
    assert.equal((await app.inject({ url: '/api/v1/cloud/storage', headers: { authorization: 'Bearer storage-worker' } })).statusCode, 403);
  } finally { workerTokens.delete('storage-worker'); await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
