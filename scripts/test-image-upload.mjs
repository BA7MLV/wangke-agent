import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import test from 'node:test';

test('HTTP upload paths agree on real image extensions, conflicts and invalid-image rejection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-upload-'));
  Object.assign(process.env, { DATA_DIR: root, FILES_DIR: path.join(root, 'files'), BOOTSTRAP_SECRET_FILE: path.join(root, 'config/bootstrap-secret'), NODE_ENV: 'test', CLOUD_BROWSER_DISABLED: '1' });
  const { buildServer } = await import('../apps/api/src/server.ts');
  const app = buildServer({ dbPath: path.join(root, 'db.sqlite') });
  try {
    const bootstrap = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'image-upload-test-password' } });
    assert.equal(bootstrap.statusCode, 201, bootstrap.body);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'image-upload-test-password' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: 'white' } }).png().toBuffer();
    const upload = (url, payload = bytes, headers = {}) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { cookie, 'content-type': 'application/octet-stream', ...headers }, payload });
    const blob = await upload('/files', bytes, { 'x-file-name': encodeURIComponent('原图.jpg'), 'x-file-mime': 'image/jpeg' });
    assert.equal(blob.statusCode, 201, blob.body);
    assert.equal(blob.json().originalName, '原图.png');
    assert.equal(blob.json().mimeType, 'image/png');
    const unnamed = await upload('/files');
    assert.equal(unnamed.statusCode, 201, unnamed.body);
    assert.match(unnamed.json().originalName, /^图片_\d{8}_[a-f0-9]{8}\.png$/);
    const agent = await app.inject({ method: 'POST', url: '/api/v1/agents', headers: { cookie }, payload: { name: 'Test', role: 'assistant', systemPrompt: '' } });
    assert.equal(agent.statusCode, 201, agent.body);
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie }, payload: { name: '图片', agentId: agent.json().id } });
    assert.equal(project.statusCode, 201, project.body);
    const id = project.json().id;
    const route = name => `/projects/${id}/uploads?path=${encodeURIComponent(name)}`;
    const first = await upload(route('截图.jpg'));
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(first.json().path, '截图.png');
    const conflict = await upload(route('截图.jpg'));
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal((await upload(route('fake.png'), Buffer.from('not an image'))).statusCode, 400);
    assert.equal((await upload('/files', Buffer.from('not an image'), { 'x-file-name': 'fake.png' })).statusCode, 400);
    const download = await app.inject({ url: `/api/v1/projects/${id}/download?path=${encodeURIComponent('截图.png')}`, headers: { cookie } });
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.rawPayload, bytes);
    const stored = await app.inject({ url: `/api/v1/files/${blob.json().id}`, headers: { cookie } });
    assert.deepEqual(stored.rawPayload, bytes, 'ID still resolves the untouched snapshot');
    assert.ok(fs.readdirSync(path.join(root, 'files/projects', id)).every(name => name === '截图.png'));
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
