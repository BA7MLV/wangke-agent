// 前后端分离相关的 API 行为：CORS 放行 / 拒绝、token 登录、Bearer 访问与吊销、SERVE_WEB=false。
// Run: npx tsx scripts/test-api-split.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-split-'));
const web = path.join(dir, 'web');
fs.mkdirSync(web);
fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>web</title>');
process.env.DATA_DIR = dir;
process.env.BOOTSTRAP_SECRET_FILE = path.join(dir, 'config/bootstrap-secret');
process.env.NODE_ENV = 'test';
process.env.CORS_ORIGINS = 'https://app.example.com, https://other.example.com/';
process.env.SERVE_WEB = 'false';
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(dir, 'db/wangke.sqlite'), staticDir: web });
const password = 'a-secure-test-password';
try {
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: password } })).statusCode, 201);

  // SERVE_WEB=false：不托管前端，未知路径返回 404 而不是 index.html。
  const page = await app.inject({ method: 'GET', url: '/library' });
  assert.equal(page.statusCode, 404);

  // 预检：放行的 origin 得到 204 和允许头；未放行的 origin 不带允许头。
  const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/auth/password/login', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://app.example.com');
  assert.equal(preflight.headers['access-control-allow-credentials'], 'true');
  assert.match(String(preflight.headers['access-control-allow-headers']), /Authorization/);
  const trailingSlashOrigin = await app.inject({ method: 'OPTIONS', url: '/api/v1/health', headers: { origin: 'https://other.example.com' } });
  assert.equal(trailingSlashOrigin.statusCode, 204);
  const denied = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin: 'https://evil.example' } });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);

  // 跨域浏览器登录：放行 origin 的写请求通过 Origin 校验。
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', headers: { origin: 'https://app.example.com' }, payload: { password } });
  assert.equal(login.statusCode, 200);
  assert.equal(login.headers['access-control-allow-origin'], 'https://app.example.com');
  const evilLogin = await app.inject({ method: 'POST', url: '/api/v1/threads', headers: { origin: 'https://evil.example', cookie: login.headers['set-cookie'].split(';')[0] }, payload: { mode: 'bot' } });
  assert.equal(evilLogin.statusCode, 403);

  // 原生壳层：密码换 token。
  const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { password: 'nope' } });
  assert.equal(wrong.statusCode, 401);
  const issued = await app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { password, deviceName: 'iPhone' } });
  assert.equal(issued.statusCode, 201);
  const { token, tokenType, user } = issued.json();
  assert.equal(tokenType, 'Bearer');
  assert.equal(user.name, 'Administrator');
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: auth })).json().authenticated, true);

  // Bearer 写请求不受 Origin 限制（没有 Cookie 就没有 CSRF）。
  const thread = await app.inject({ method: 'POST', url: '/api/v1/threads', headers: { ...auth, origin: 'capacitor://localhost' }, payload: { mode: 'bot', title: 'From iOS' } });
  assert.equal(thread.statusCode, 201);
  const list = await app.inject({ method: 'GET', url: '/api/v1/threads', headers: auth });
  assert.equal(list.json().threads.length, 1);

  // 退出即吊销。
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: auth })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/threads', headers: auth })).statusCode, 401);
  console.log('api split ok');
} finally {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
