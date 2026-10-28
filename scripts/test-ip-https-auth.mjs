// Disposable API regression: extra IP origin, secure cookies, CSRF and account persistence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-ip-https-'));
const origin = 'https://192.0.2.10';
const domain = 'https://learn.example.com';
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'),
  BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret'),
  PUBLIC_ORIGIN: domain, WEBAUTHN_RP_ID: 'learn.example.com',
  CORS_ORIGINS: origin, COOKIE_SAMESITE: 'lax',
});
delete process.env.ALLOW_INSECURE_CSRF;
const { buildServer } = await import('../apps/api/src/server.ts');
const options = { dbPath: path.join(directory, 'db.sqlite') };
let app = buildServer(options);
const password = 'disposable-ip-login-test-only';
try {
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize',
    headers: { origin: domain, 'x-bootstrap-secret': secret }, payload: { adminPassword: password },
  })).statusCode, 201);
  const login = () => app.inject({ method: 'POST', url: '/api/v1/auth/password/login',
    headers: { origin }, payload: { password },
  });
  const response = await login();
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['access-control-allow-origin'], origin);
  const setCookie = response.headers['set-cookie'];
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Lax/);
  assert.doesNotMatch(setCookie, /; Domain=/, 'cookies must be host-only for both entrypoints');
  const cookie = setCookie.split(';')[0];
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie } })).json().authenticated, true);
  for (const deniedOrigin of ['http://192.0.2.10', 'https://192.0.2.11', 'https://evil.example']) {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { origin: deniedOrigin, cookie } });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error, 'origin_not_allowed');
  }
  await app.close();
  app = buildServer(options);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/bootstrap/status' })).json().initialized, true);
  assert.equal(fs.existsSync(process.env.BOOTSTRAP_SECRET_FILE), false);
  assert.equal((await login()).statusCode, 200, 'existing password survives restart');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie } })).json().authenticated, true, 'sessions survive restart');
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', headers: { origin: domain },
    payload: { password },
  })).statusCode, 200, 'original domain still works');
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { origin, cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie } })).json().authenticated, false);
  console.log('IP HTTPS origin, secure host-only cookies, CSRF rejection and account/session persistence passed');
} finally {
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
