import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-account-reset-'));
const dbPath = path.join(directory, 'db/wangke.sqlite');
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_DIR: directory, DB_PATH: dbPath,
  BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret'),
  FILES_DIR: path.join(directory, 'files'), PUBLIC_ORIGIN: 'https://learn.example.com',
  CLOUD_WORKER_DISABLED: '1',
});
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath });
const password = 'reset-current-password-2026';
let db;
try {
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: password } })).statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const userId = login.json().user.id;
  const thread = await app.inject({ method: 'POST', url: '/api/v1/threads', headers: { cookie }, payload: { title: 'to be removed', mode: 'chat' } });
  assert.equal(thread.statusCode, 201);

  db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,?,?,?)').run(userId, 'videos', JSON.stringify('course-1'), JSON.stringify({ id: 'course-1', name: 'fixture' }));
  db.prepare('INSERT INTO webauthn_challenges(id,kind,challenge,created_at,expires_at) VALUES(?,?,?,?,?)').run('challenge', 'authentication', 'challenge', now, '2099-01-01T00:00:00.000Z');
  fs.mkdirSync(path.join(directory, 'files/projects/project-1'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'files/fixture.bin'), 'delete me');
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/account/reset', headers: { cookie }, payload: { password: 'wrong-password' } })).statusCode, 401);
  assert.equal(fs.existsSync(path.join(directory, 'files/fixture.bin')), true);

  const reset = await app.inject({ method: 'POST', url: '/api/v1/account/reset', headers: { cookie }, payload: { password } });
  assert.equal(reset.statusCode, 200, reset.body);
  const resetBody = reset.json();
  assert.equal(resetBody.reset, true);
  assert.ok(resetBody.bootstrapSecret);
  assert.equal(fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(), resetBody.bootstrapSecret);
  assert.equal(fs.readdirSync(process.env.FILES_DIR).length, 0, 'uploaded files and project workspaces are removed');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie } })).json().authenticated, false);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/bootstrap/status' })).json().initialized, false);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'").all();
  for (const { name } of tables) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count, 0, `${name} should be empty`);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': resetBody.bootstrapSecret }, payload: { adminPassword: password } })).statusCode, 201);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password } })).statusCode, 200);
  console.log('Account reset: password confirmation, task-safe data deletion, bootstrap regeneration and fresh initialization passed');
} finally {
  db?.close();
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
