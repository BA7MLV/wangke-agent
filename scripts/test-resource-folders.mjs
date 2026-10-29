import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-resources-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
let app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let cookie = '', db;
const call = async (method, url, payload, expected = 200, headers = {}) => {
  const result = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie, ...headers }, ...(payload !== undefined ? { payload } : {}) });
  assert.equal(result.statusCode, expected, `${method} ${url}: ${result.body}`);
  return result;
};
const json = async (...args) => (await call(...args)).json();
  const listing = (id, p = '') => json('GET', `/resources?projectId=${id}&path=${encodeURIComponent(p)}`);
const location = (id, action, p) => `/projects/${id}/${action}?path=${encodeURIComponent(p)}`;
try {
  await json('POST', '/bootstrap/initialize', { adminPassword: 'resource-test-password' }, 201, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() });
  const login = await call('POST', '/auth/password/login', { password: 'resource-test-password' });
  cookie = login.headers['set-cookie'].split(';')[0];
  db = new Database(path.join(directory, 'db.sqlite'));
  const agent = (await json('GET', '/agents')).agents[0];
  const oldProject = await json('POST', '/projects', { name: '原工作区', agentId: agent.id }, 201);
  const oldThread = await json('POST', '/threads', { mode: 'bot', projectId: oldProject.id, agentId: agent.id, title: '保留会话' }, 201);
  await json('PUT', location(oldProject.id, 'text', 'existing.md'), { text: 'existing project file', expectedRevision: null });
  const original = '# 旧笔记\n\n旧资料正文。';
  const upload = await json('POST', '/files', Buffer.from(original), 201, { 'content-type': 'application/octet-stream', 'x-file-name': 'legacy', 'x-file-mime': 'text/markdown' });
  const entries = [
    ['folders', 1, { id: 1, name: '课程资料', createdAt: 1 }],
    ['folders', 2, { id: 2, name: '第一章', parentId: 1, createdAt: 2 }],
    ['videos', 'legacy-course', { id: 'legacy-course', name: '旧笔记', folderId: 2, kind: 'material', materialFormat: 'md', mimeType: 'text/markdown', size: Buffer.byteLength(original), duration: 0, createdAt: 3, status: 'transcribed', unitCount: 1 }],
    ['courseFiles', 'legacy-course', { id: 'legacy-course', fileId: upload.id, mimeType: 'text/markdown', size: Buffer.byteLength(original) }],
    ['materialBlocks', 1, { id: 1, materialId: 'legacy-course', unit: 1, text: '旧资料正文。' }],
  ];
  await json('POST', '/cloud/records', { mutations: entries.map(([table, key, after]) => ({ id: crypto.randomUUID(), table, key, before: null, after })) });
  const root = await json('GET', '/resources');
  const folder = root.entries.find(e => e.name === '课程资料');
  assert.ok(folder?.scope, 'old virtual root folder becomes a real sandbox scope');
  assert.ok(root.entries.some(e => e.projectId === oldProject.id));
  const nested = (await listing(folder.projectId)).entries.find(e => e.name === '第一章');
  const note = (await listing(folder.projectId, nested.path)).entries.find(e => e.courseId === 'legacy-course');
  assert.ok(note, 'course ID and nested folder are preserved');
  const physical = path.join(directory, 'files/projects', folder.projectId, note.path);
  assert.equal(fs.readFileSync(physical, 'utf8'), original);
  assert.equal(fs.statSync(physical).nlink, 1);
  assert.equal(fs.readFileSync(path.join(directory, 'files', `${upload.id}.bin`), 'utf8'), original, 'migration leaves original backup untouched');
  assert.equal((await call('GET', '/resources/courses/legacy-course')).body, original);
  assert.equal((await call('GET', '/resources/courses/legacy-course', undefined, 206, { range: 'bytes=0-3' })).rawPayload.toString(), Buffer.from(original).subarray(0, 4).toString());
  assert.equal((await json('GET', `/threads/${oldThread.id}`)).title, '保留会话');
  assert.equal((await json('GET', `/projects/${oldProject.id}`)).grants[0].agentId, agent.id);
  await json('POST', '/resources/courses/legacy-course/text', { text: '# 新正文', expected: original });
  assert.equal(fs.readFileSync(physical, 'utf8'), '# 新正文');
  await json('POST', '/resources/courses/legacy-course/text', { text: 'stale overwrite', expected: original }, 409);
  fs.writeFileSync(physical, '# Bot 直接修改\n\n新内容');
  const afterExternal = (await listing(folder.projectId, nested.path)).entries.find(e => e.courseId === note.courseId);
  assert.equal(afterExternal.courseId, note.courseId);
  assert.equal((await call('GET', '/resources/courses/legacy-course')).body, '# Bot 直接修改\n\n新内容');
  assert.equal(db.prepare("SELECT value FROM cloud_records WHERE table_name='materialBlocks' AND record_key='1'").get().value, null, 'external changes invalidate stale search blocks');
  await json('POST', '/resources/move', { projectId: folder.projectId, path: afterExternal.path, targetProjectId: folder.projectId, target: '第一章/改名.md', revision: afterExternal.revision });
  assert.equal((await listing(folder.projectId, nested.path)).entries.find(e => e.name === '改名.md').courseId, note.courseId);
  const renamed = path.join(path.dirname(physical), '改名.md');
  fs.renameSync(renamed, path.join(path.dirname(renamed), '机器改名.md'));
  assert.equal((await listing(folder.projectId, nested.path)).entries.find(e => e.name === '机器改名.md').courseId, note.courseId, 'external rename retains learning identity');

  // A folder is not a Bot/project setup wizard and works with no enabled Bot.
  db.prepare('UPDATE agent_profiles SET enabled=0').run();
  const fresh = await json('POST', '/resources/folders', { name: '纯文件夹' }, 201);
  assert.deepEqual(fresh.grants, []);
  await json('POST', location(fresh.id, 'directories', '子目录'), undefined, 201);
  await json('PUT', location(fresh.id, 'text', '子目录/bot.md'), { text: 'Shared physical file', expectedRevision: null });
  assert.ok((await listing(fresh.id, '子目录')).entries.some(e => e.name === 'bot.md'));
  const unsafe = path.join(directory, 'private.txt'); fs.writeFileSync(unsafe, 'private');
  fs.symlinkSync(unsafe, path.join(directory, 'files/projects', fresh.id, 'link.md'));
  assert.ok(!(await listing(fresh.id)).entries.some(e => e.name === 'link.md'));
  await json('GET', `/resources?projectId=${fresh.id}&path=..`, undefined, 400);
  await json('POST', '/resources/move', { projectId: fresh.id, path: '子目录', targetProjectId: fresh.id, target: '子目录/inside', revision: (await listing(fresh.id)).entries.find(e => e.name === '子目录').revision }, 400);
  const destination = await json('POST', '/resources/folders', { name: '移动目标' }, 201);
  const child = (await listing(fresh.id)).entries.find(e => e.name === '子目录');
  const botNote = (await listing(fresh.id, '子目录')).entries.find(e => e.name === 'bot.md');
  await json('POST', '/cloud/records', { mutations: [{ id: 'bot-material-block', table: 'materialBlocks', key: 2, before: null, after: { id: 2, materialId: botNote.courseId, unit: 1, text: 'Bot 资料块' } }] });
  const childFolderId = (await listing(fresh.id, '子目录')).folderId;
  await json('POST', '/resources/move', { projectId: fresh.id, path: child.path, targetProjectId: destination.id, target: '搬来的目录', revision: child.revision });
  assert.equal((await listing(destination.id, '搬来的目录')).folderId, childFolderId, 'moving a directory preserves its folder identity');
  assert.equal((await listing(destination.id, '搬来的目录')).entries.find(e => e.name === 'bot.md').courseId, botNote.courseId);
  const change = async (table, key, patch) => {
    const before = (await json('GET', `/cloud/record?table=${table}&key=${encodeURIComponent(JSON.stringify(key))}`)).value;
    await json('POST', '/cloud/records', { mutations: [{ id: crypto.randomUUID(), table, key, before, after: { ...before, ...patch } }] });
  };
  await change('folders', childFolderId, { name: '兼容改名' });
  assert.equal((await listing(destination.id, '兼容改名')).entries[0].courseId, botNote.courseId, 'legacy folder rename reaches the disk');
  await change('videos', botNote.courseId, { name: '兼容文件改名', folderId: undefined });
  const movedCourse = (await json('GET', '/resources')).entries.find(e => e.courseId === botNote.courseId);
  assert.equal(movedCourse.name, '兼容文件改名.md', 'legacy file rename/move reaches the real resource root');
  await json('PATCH', `/projects/${destination.id}`, { name: '新的顶层名称' });
  assert.ok((await json('GET', '/resources')).entries.some(e => e.name === '新的顶层名称'), 'renaming a scope must not be undone by its compatibility index');
  const owner = crypto.randomUUID(), token = crypto.randomUUID();
  db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, 'Other', new Date().toISOString());
  db.prepare('INSERT INTO api_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), owner, crypto.createHash('sha256').update(token).digest('hex'), 'test', '2026', '2999');
  const otherHeaders = { cookie: '', authorization: `Bearer ${token}` };
  await json('GET', `/resources?projectId=${fresh.id}`, undefined, 404, otherHeaders);
  await json('GET', '/resources/courses/legacy-course', undefined, 404, otherHeaders);
  const beforeRestart = db.prepare('SELECT count(*) AS n FROM projects').get().n;
  await app.close();
  app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
  await json('GET', '/resources');
  assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get().n, beforeRestart, 'migration is idempotent after restart');
  const current = (await listing(folder.projectId, nested.path)).entries.find(e => e.courseId === note.courseId);
  await json('DELETE', `${location(folder.projectId, 'files', current.path)}&revision=${encodeURIComponent(current.revision)}`);
  await json('GET', '/resources');
  assert.ok(!fs.existsSync(path.join(path.dirname(renamed), '机器改名.md')), 'deleted files are never resurrected from legacy blobs');
  assert.ok((await listing(folder.projectId, nested.path)).entries.some(e => e.courseId === note.courseId && e.missing), 'learning history remains reachable after removing the source file');
  assert.ok(db.prepare("SELECT value FROM cloud_records WHERE table_name='videos' AND record_key=?").get(JSON.stringify(note.courseId)).value, 'learning history is retained');
  const fullDelete = (await json('GET', '/resources')).entries.find(e => e.courseId === botNote.courseId);
  assert.ok(fullDelete, 'mapped resource remains available for the resource-library delete path');
  await json('DELETE', `/resources/file?projectId=${encodeURIComponent(fullDelete.projectId)}&path=${encodeURIComponent(fullDelete.path)}&revision=${encodeURIComponent(fullDelete.revision)}`);
  assert.ok(!fs.existsSync(path.join(directory, 'files/projects', fullDelete.projectId, fullDelete.path)), 'resource-library deletion removes the authoritative file');
  assert.ok(!(await json('GET', '/resources')).entries.some(e => e.courseId === botNote.courseId), 'resource-library deletion removes the learning entry');
  for (const table of ['videos', 'materialBlocks', 'courseFiles']) {
    const deleted = db.prepare(`SELECT value FROM cloud_records WHERE table_name=? AND record_key=?`).get(table, JSON.stringify(botNote.courseId));
    assert.equal(deleted?.value ?? null, null, `${table} is deleted with the resource`);
  }
  console.log('Resource folders: migration, real I/O, nested directories, shared Bot files, stable IDs, conflicts, ranges, permissions, restart and deletion OK');
} finally {
  await app.close(); db?.close(); fs.rmSync(directory, { recursive: true, force: true });
}
