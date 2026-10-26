import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import argon2 from 'argon2';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { BootstrapInitializeRequest, ConversationMode, MessageRole } from '../../../packages/contracts/src/index.js';
import { DatabaseStore } from './storage/database.js';
import { BootstrapRepository } from './storage/bootstrapRepository.js';
import { BotRunner } from './agent/runner.js';
import { CloudRecords } from './cloud/records.js';
import { CloudConfiguration } from './cloud/config.js';
import { receiveFile, byteRange } from './cloud/files.js';
import { registerCloudRoutes } from './cloud/routes.js';
import { workerIdentity } from './cloud/tasks.js';
import { McpRepository } from './mcp/repository.js';
import { McpManager } from './mcp/manager.js';
import { registerMcpRoutes } from './mcp/routes.js';
import { ProjectRepository } from './projects/repository.js';
import { ProjectError } from './projects/files.js';
import { registerProjectRoutes } from './projects/routes.js';
import type { SandboxCleanup, SandboxExecutor } from './agent/sandbox.js';

const defaultDataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
const messageKinds = new Set(['text', 'progress', 'attachment', 'widget', 'question', 'approval']);

function loadOrCreateSecret(secretFile: string): { secret: string; createdAt: number } {
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  if (fs.existsSync(secretFile)) return { secret: fs.readFileSync(secretFile, 'utf8').trim(), createdAt: fs.statSync(secretFile).birthtimeMs || fs.statSync(secretFile).ctimeMs };
  const secret = crypto.randomBytes(32).toString('base64url');
  try { fs.writeFileSync(secretFile, `${secret}\n`, { mode: 0o600, flag: 'wx' }); }
  catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const stat = fs.statSync(secretFile);
    return { secret: fs.readFileSync(secretFile, 'utf8').trim(), createdAt: stat.birthtimeMs || stat.ctimeMs };
  }
  fs.chmodSync(secretFile, 0o600);
  return { secret, createdAt: Date.now() };
}
const hashToken = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const parseCookies = (header = '') => {
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 1) continue;
    const key = part.slice(0, equals).trim();
    try { result[key] = decodeURIComponent(part.slice(equals + 1).trim()); } catch { /* ignore malformed cookie */ }
  }
  return result;
};
const publicUser = (user: any) => ({ id: user.id, name: user.name });

function webauthnChallengeFromResponse(body: unknown): string | null {
  const clientDataJSON = (body as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON;
  if (typeof clientDataJSON !== 'string' || clientDataJSON.length > 16384) return null;
  try {
    const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof clientData.challenge === 'string' && clientData.challenge.length > 0 ? clientData.challenge : null;
  } catch {
    return null;
  }
}

export function buildServer(options: { dbPath?: string; staticDir?: string; fetch?: typeof fetch; sandbox?: SandboxExecutor; sandboxCleanup?: SandboxCleanup } = {}) {
  const secretFile = process.env.BOOTSTRAP_SECRET_FILE ?? path.join(defaultDataDir, 'config/bootstrap-secret');
  const dbPath = options.dbPath ?? process.env.DB_PATH ?? path.join(defaultDataDir, 'db/wangke.sqlite');
  const bootstrapTtlMs = Number(process.env.BOOTSTRAP_TTL_MS ?? 15 * 60 * 1000);
  const sessionTtlMs = Number(process.env.SESSION_TTL_MS ?? 30 * 24 * 60 * 60 * 1000);
  const filesDir = process.env.FILES_DIR ?? path.join(defaultDataDir, 'files');
  const configuredMaxFileBytes = Number(process.env.MAX_FILE_BYTES ?? 512 * 1024 * 1024);
  const maxFileBytes = Number.isFinite(configuredMaxFileBytes) ? Math.max(1, Math.min(512 * 1024 * 1024, Math.floor(configuredMaxFileBytes))) : 512 * 1024 * 1024;
  fs.mkdirSync(filesDir, { recursive: true });
  const store = new DatabaseStore(dbPath);
  const cloudRecords = new CloudRecords(store);
  const cloudConfig = new CloudConfiguration(store, path.dirname(secretFile));
  const repo = new BootstrapRepository(store);
  const mcp = new McpManager(new McpRepository(store, cloudConfig));
  const projects = new ProjectRepository(store, path.join(filesDir, 'projects'));
  const runner = new BotRunner(store, { fetch: options.fetch, sandbox: options.sandbox, sandboxCleanup: options.sandboxCleanup, configuration: cloudConfig, mcp, projects });
  projects.isActive = id => runner.isProjectActive(id);
  // Never recreate a bootstrap secret after the database has been initialized.
  const bootstrap = repo.isInitialized() ? { secret: '', createdAt: 0 } : loadOrCreateSecret(secretFile);
  if (repo.isInitialized()) fs.rmSync(secretFile, { force: true });
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 16 * 1024 * 1024 });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProjectError) return reply.code(error.status).send({ error: error.code });
    return reply.send(error);
  });
  app.addContentTypeParser('application/octet-stream', (_request, stream, done) => done(null, stream));
  app.addContentTypeParser(/^multipart\/form-data/, (_request, stream, done) => done(null, stream));
  runner.start();
  const attempts = new Map<string, { count: number; until: number; seen: number }>();
  const dummyHash = argon2.hash('unusable-login-dummy', { type: argon2.argon2id });
  const secureCookie = (process.env.PUBLIC_ORIGIN ?? '').startsWith('https://');
  const expectedOrigin = process.env.PUBLIC_ORIGIN;
  const rpID = process.env.WEBAUTHN_RP_ID;
  const rpName = process.env.WEBAUTHN_RP_NAME;
  /**
   * 前后端分离：浏览器前端在别的域名时，在 CORS_ORIGINS 里列出它（逗号分隔，完整 origin）。
   * 原生壳层（iOS / macOS）不发 Origin，也不需要 CORS，它们用 Bearer token。
   */
  const corsOrigins = new Set((process.env.CORS_ORIGINS ?? '').split(',').map((value) => value.trim().replace(/\/+$/, '')).filter(Boolean));
  /** 跨站点（不同注册域）部署时 Cookie 需要 SameSite=None（必须同时 HTTPS）；同站子域名用默认的 Lax 即可。 */
  const sameSite = (() => {
    const value = (process.env.COOKIE_SAMESITE ?? 'lax').toLowerCase();
    if (value === 'none' && secureCookie) return 'None';
    if (value === 'strict') return 'Strict';
    return 'Lax';
  })();
  /** SERVE_WEB=false 时只提供 API，不托管前端静态文件（前端由独立的 web 容器或 CDN 提供）。 */
  const serveWeb = !['false', '0', 'no'].includes((process.env.SERVE_WEB ?? 'true').toLowerCase());
  const tokenTtlMs = Number(process.env.TOKEN_TTL_MS ?? 90 * 24 * 60 * 60 * 1000);

  app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: { policy: 'require-corp' },
    // 放行了跨域前端时，文件下载等响应要允许被别的 origin 读取。
    crossOriginResourcePolicy: { policy: corsOrigins.size ? 'cross-origin' : 'same-origin' },
  });
  const staticDir = options.staticDir ?? path.resolve(process.cwd(), 'dist');
  const hasWeb = serveWeb && fs.existsSync(staticDir);
  if (hasWeb) app.register(fastifyStatic, { root: staticDir, wildcard: false });

  // CORS：只对 CORS_ORIGINS 里列出的 origin 回写允许头；预检请求在这里直接结束。
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !corsOrigins.has(origin) || !request.url.startsWith('/api/')) return;
    reply.header('access-control-allow-origin', origin);
    reply.header('access-control-allow-credentials', 'true');
    reply.header('vary', 'Origin');
    if (request.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      reply.header('access-control-allow-headers', 'Authorization,Content-Type,Accept,Last-Event-ID,X-File-Name,X-File-Mime,X-Bootstrap-Secret,Range');
      reply.header('access-control-expose-headers', 'Content-Disposition,Content-Range,Content-Length');
      reply.header('access-control-max-age', '600');
      return reply.code(204).send();
    }
    reply.header('access-control-expose-headers', 'Content-Disposition,Content-Range,Content-Length');
  });

  function session(request: FastifyRequest) {
    const worker = workerIdentity(request);
    if (worker) return store.db.prepare('SELECT id,name FROM users WHERE id=?').get(worker.id);
    const cookieToken = parseCookies(request.headers.cookie).wangke_session;
    if (cookieToken) {
      const cookieSession = store.db.prepare(`SELECT s.id AS session_id, u.id, u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?`).get(hashToken(cookieToken), now()) as any;
      if (cookieSession) return cookieSession;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return null;
    const bearer = authorization.slice(7).trim();
    if (!bearer || bearer.length > 256) return null;
    return store.db.prepare(`SELECT NULL AS session_id, t.id AS token_id, u.id, u.name FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?`).get(hashToken(bearer), now()) as any ?? null;
  }
  function requireAuth(request: FastifyRequest, reply: FastifyReply) {
    const user = session(request);
    if (!user) { reply.code(401).send({ error: 'unauthorized' }); return null; }
    return user;
  }
  function checkOrigin(request: FastifyRequest, reply: FastifyReply) {
    if (workerIdentity(request)) return true;
    const origin = request.headers.origin;
    if (!origin) return true;
    // Bearer token 不会被浏览器自动附带，没有 CSRF 风险；原生壳层和脚本走这条。
    if (request.headers.authorization?.startsWith('Bearer ') && !request.headers.cookie?.includes('wangke_session=')) return true;
    if (corsOrigins.has(origin)) return true;
    const allowed = expectedOrigin ?? `${request.protocol}://${request.headers.host}`;
    if (origin !== allowed && process.env.ALLOW_INSECURE_CSRF !== 'true') { reply.code(403).send({ error: 'origin_not_allowed' }); return false; }
    return true;
  }
  function issueSession(userId: string, reply: FastifyReply) {
    const token = crypto.randomBytes(32).toString('base64url');
    const created = Date.now();
    store.db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), userId, hashToken(token), new Date(created).toISOString(), new Date(created + sessionTtlMs).toISOString());
    reply.header('set-cookie', `wangke_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}${secureCookie ? '; Secure' : ''}; Max-Age=${Math.floor(sessionTtlMs / 1000)}`);
  }
  const bad = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });
  const pruneAttempts = () => { const cutoff = Date.now() - 15 * 60_000; for (const [ip, value] of attempts) if (value.until < cutoff && value.seen < cutoff) attempts.delete(ip); while (attempts.size > 10_000) attempts.delete(attempts.keys().next().value!); };

   const cloudRunner = registerCloudRoutes(app, { store, records: cloudRecords, configuration: cloudConfig, requireAuth, checkOrigin, filesDir, maxFileBytes, fetch: options.fetch });
   registerMcpRoutes(app, { manager: mcp, store, records: cloudRecords, requireAuth, checkOrigin });
   registerProjectRoutes(app, { projects, requireAuth, checkOrigin, maxFileBytes, stopProject: (id) => {
     const runs = store.db.prepare("SELECT r.id FROM runs r JOIN threads t ON t.id=r.thread_id WHERE t.project_id=? AND r.status IN ('queued','running','waiting_user')").all(id) as Array<{ id: string }>;
     for (const run of runs) { store.db.prepare("UPDATE runs SET status='cancelled',completed_at=?,wake_at=NULL WHERE id=?").run(now(), run.id); runner.cancel(run.id); }
   } });
  app.get('/api/v1/health', async () => ({ status: 'ok', version: process.env.APP_VERSION ?? '0.1.0', cloud: true, auth: ['password', 'token', 'passkey'] }));
  app.addHook('onRequest', async (request, reply) => {
    const worker = workerIdentity(request);
    if (worker && request.url.startsWith('/api/')) {
      const url = request.url.split('?')[0];
      const read = request.method === 'GET' && (['/api/v1/cloud/status', '/api/v1/cloud/config', '/api/v1/cloud/records', '/api/v1/auth/session', '/api/v1/bootstrap/status'].includes(url) || /^\/api\/v1\/files\/[^/]+$/.test(url));
      const write = request.method === 'POST' && (['/api/v1/cloud/records', '/api/v1/files', '/api/v1/cloud/mcp/catalog', '/api/v1/cloud/mcp/call'].includes(url) || url.startsWith('/api/v1/cloud/models/') || [`/api/v1/cloud/tasks/${worker.taskId}/report`, `/api/v1/cloud/tasks/${worker.taskId}/authorize`, `/api/v1/cloud/tasks/${worker.taskId}/authorize/finish`, `/api/v1/cloud/tasks/${worker.taskId}/commands/claim`].includes(url));
      if (!read && !write) return reply.code(403).send({ error: 'worker_scope_denied' });
      const task = store.db.prepare('SELECT status FROM cloud_tasks WHERE id=? AND owner_id=?').get(worker.taskId, worker.id) as { status: string } | undefined;
      if (!task || !['running', 'waiting_user'].includes(task.status)) return reply.code(403).send({ error: 'worker_task_inactive' });
    }
    if (request.url.split('?')[0] === '/api/v1/files' && request.method === 'POST') {
      if (!checkOrigin(request, reply)) return;
      if (!requireAuth(request, reply)) return;
      const size = request.headers['content-length'];
      if (size && (!Number.isSafeInteger(Number(size)) || Number(size) > maxFileBytes)) return reply.code(413).send({ error: 'file_too_large_or_invalid' });
    }
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });
   app.get('/api/v1/bootstrap/status', async () => { const initialized = repo.isInitialized(); const available = !initialized && Date.now() < bootstrap.createdAt + bootstrapTtlMs; return { initialized, bootstrapAvailable: available, expiresAt: available ? new Date(bootstrap.createdAt + bootstrapTtlMs).toISOString() : null }; });
  app.post<{ Body: BootstrapInitializeRequest }>('/api/v1/bootstrap/initialize', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    if (repo.isInitialized()) return bad(reply, 410, 'bootstrap_closed');
     if (Date.now() >= bootstrap.createdAt + bootstrapTtlMs || request.headers['x-bootstrap-secret'] !== bootstrap.secret) return bad(reply, 403, 'invalid_or_expired_bootstrap_secret');
    const { adminPassword, adminName = 'Administrator' } = request.body ?? {};
    if (typeof adminPassword !== 'string' || adminPassword.length < 12 || adminPassword.length > 256) return bad(reply, 400, 'admin_password_must_be_12_to_256_characters');
    const initialized = repo.initializeAdmin(adminName.trim().slice(0, 100) || 'Administrator', await argon2.hash(adminPassword, { type: argon2.argon2id }));
    if (!initialized) return bad(reply, 410, 'bootstrap_closed');
    fs.rmSync(secretFile, { force: true });
    return reply.code(201).send({ initialized: true });
  });

  /** 密码校验 + 按 IP 退避。浏览器登录（发 Cookie）和原生壳层登录（发 token）共用。 */
  async function verifyPassword(request: FastifyRequest<{ Body: { name?: string; username?: string; password?: string } }>) {
    pruneAttempts(); const key = request.ip; const attempt = attempts.get(key); const wait = attempt && attempt.until > Date.now() ? attempt.until - Date.now() : 0;
    if (wait) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 1500)));
    const identifier = String(request.body?.username ?? request.body?.name ?? '');
    const record = store.db.prepare('SELECT u.id,u.name,p.password_hash FROM users u JOIN password_credentials p ON p.user_id=u.id WHERE u.name=?').get(identifier) as any;
    const valid = typeof request.body?.password === 'string' && await argon2.verify(record?.password_hash ?? await dummyHash, request.body.password);
    if (!valid) { const seen = Date.now(); attempts.set(key, { count: (attempt?.count ?? 0) + 1, until: seen + Math.min(1000 * 2 ** Math.min(attempt?.count ?? 0, 4), 10000), seen }); return null; }
    attempts.delete(key); return record as { id: string; name: string };
  }
  app.post<{ Body: { name?: string; username?: string; password?: string } }>('/api/v1/auth/password/login', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const record = await verifyPassword(request);
    if (!record) return bad(reply, 401, 'invalid_credentials');
    issueSession(record.id, reply); return { user: publicUser(record) };
  });
  /**
   * 原生壳层（iOS / macOS）和脚本的登录：用户名 + 密码换一个 Bearer token。
   * token 只在这次响应里出现一次，库里只存哈希；`POST /auth/logout` 带上它即可吊销。
   */
  app.post<{ Body: { name?: string; username?: string; password?: string; deviceName?: string } }>('/api/v1/auth/token', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const record = await verifyPassword(request);
    if (!record) return bad(reply, 401, 'invalid_credentials');
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    const expiresAt = new Date(createdAt + tokenTtlMs).toISOString();
    const deviceName = typeof request.body?.deviceName === 'string' ? request.body.deviceName.trim().slice(0, 100) : '';
    const tokenId = crypto.randomUUID();
    store.db.prepare('INSERT INTO api_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(tokenId, record.id, hashToken(token), deviceName || 'Native client', new Date(createdAt).toISOString(), expiresAt);
    return reply.code(201).send({ token, tokenId, tokenType: 'Bearer', expiresAt, user: publicUser(record) });
  });
  app.get('/api/v1/auth/session', async (request) => { const user = session(request); return { authenticated: Boolean(user), user: user ? publicUser(user) : null }; });
  app.post('/api/v1/auth/logout', async (request, reply) => { if (!checkOrigin(request, reply)) return; const user = session(request); const authorization = request.headers.authorization; if (authorization?.startsWith('Bearer ')) { const bearer = authorization.slice(7).trim(); if (bearer) store.db.prepare('UPDATE api_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').run(now(), hashToken(bearer)); } else if (user?.session_id) store.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(now(), user.session_id); reply.header('set-cookie', `wangke_session=; Path=/; HttpOnly; SameSite=${sameSite}${secureCookie ? '; Secure' : ''}; Max-Age=0`); return { ok: true }; });

  app.post<{ Body: { deviceName?: string } }>('/api/v1/pairing/create', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const code = crypto.randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    const expiresAt = new Date(createdAt + 5 * 60_000).toISOString();
    const deviceName = typeof request.body?.deviceName === 'string' ? request.body.deviceName.trim().slice(0, 100) : '';
    store.db.prepare('INSERT INTO device_pairings(id,owner_id,code_hash,device_name,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), user.id, hashToken(code), deviceName || null, new Date(createdAt).toISOString(), expiresAt);
    return reply.code(201).send({ code, expiresAt });
  });

  app.get<{ Params: { code: string } }>('/api/v1/pairing/:code', async (request, reply) => {
    const code = request.params.code;
    if (typeof code !== 'string' || code.length < 32 || code.length > 128) return bad(reply, 404, 'pairing_not_found');
    const pairing = store.db.prepare('SELECT approved_at,used_at,expires_at FROM device_pairings WHERE code_hash=?').get(hashToken(code)) as { approved_at: string | null; used_at: string | null; expires_at: string } | undefined;
    if (!pairing || pairing.used_at || pairing.expires_at <= now()) return { status: 'expired' as const };
    return { status: pairing.approved_at ? 'approved' as const : 'pending' as const, expiresAt: pairing.expires_at };
  });

  app.post<{ Params: { code: string }; Body: { deviceName?: string } }>('/api/v1/pairing/:code/approve', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const deviceName = typeof request.body?.deviceName === 'string' ? request.body.deviceName.trim().slice(0, 100) : '';
    const approved = store.transaction(() => {
      const pairing = store.db.prepare('SELECT id FROM device_pairings WHERE code_hash=? AND owner_id=? AND used_at IS NULL AND expires_at>?').get(hashToken(request.params.code), user.id, now()) as { id: string } | undefined;
      if (!pairing) return false;
      store.db.prepare('UPDATE device_pairings SET approved_at=COALESCE(approved_at,?), device_name=COALESCE(?,device_name) WHERE id=?').run(now(), deviceName || null, pairing.id);
      return true;
    });
    if (!approved) return bad(reply, 404, 'pairing_not_found');
    return { approved: true };
  });

  app.post<{ Params: { code: string }; Body: { deviceName?: string } }>('/api/v1/pairing/:code/exchange', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    const expiresAt = new Date(createdAt + 90 * 24 * 60 * 60_000).toISOString();
    const deviceName = typeof request.body?.deviceName === 'string' ? request.body.deviceName.trim().slice(0, 100) : '';
    const exchanged = store.transaction(() => {
      const pairing = store.db.prepare('SELECT id,owner_id,device_name FROM device_pairings WHERE code_hash=? AND approved_at IS NOT NULL AND used_at IS NULL AND expires_at>?').get(hashToken(request.params.code), now()) as { id: string; owner_id: string; device_name: string | null } | undefined;
      if (!pairing) return false;
      const claimed = store.db.prepare('UPDATE device_pairings SET used_at=? WHERE id=? AND used_at IS NULL').run(new Date(createdAt).toISOString(), pairing.id);
      if (claimed.changes !== 1) return false;
      const tokenId = crypto.randomUUID();
      store.db.prepare('INSERT INTO api_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(tokenId, pairing.owner_id, hashToken(token), deviceName || pairing.device_name || 'Paired device', new Date(createdAt).toISOString(), expiresAt);
      return tokenId;
    });
    if (!exchanged) return bad(reply, 403, 'pairing_not_approved_or_expired');
    return { token, tokenId: exchanged, tokenType: 'Bearer', expiresAt };
  });

  function webauthnConfigured(reply: FastifyReply) { if (!expectedOrigin || !rpID || !rpName || (!expectedOrigin.startsWith('https://') && !/^http:\/\/localhost(?::\d+)?$/.test(expectedOrigin))) { bad(reply, 503, 'webauthn_not_configured'); return false; } return true; }
  app.post('/api/v1/auth/passkey/register/options', async (request, reply) => {
    if (!checkOrigin(request, reply)) return; const user = requireAuth(request, reply); if (!user || !webauthnConfigured(reply)) return;
    store.db.prepare("DELETE FROM webauthn_challenges WHERE (used_at IS NOT NULL OR expires_at<=?) AND (user_id=? OR user_id IS NULL)").run(now(), user.id);
    const credentials = store.db.prepare('SELECT id FROM passkey_credentials WHERE user_id=?').all(user.id) as any[];
      const options = await generateRegistrationOptions({ rpName: rpName!, rpID: rpID!, userName: user.name, userID: new TextEncoder().encode(user.id), attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: credentials.map((x) => ({ id: x.id })) });
    store.db.prepare('INSERT INTO webauthn_challenges(id,user_id,kind,challenge,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), user.id, 'registration', options.challenge, now(), new Date(Date.now() + 120000).toISOString());
    return options;
  });
  app.post('/api/v1/auth/passkey/register/verify', async (request, reply) => {
    if (!checkOrigin(request, reply)) return; const user = requireAuth(request, reply); if (!user || !webauthnConfigured(reply)) return;
    const responseChallenge = webauthnChallengeFromResponse(request.body);
    if (!responseChallenge) return bad(reply, 400, 'challenge_missing_or_expired');
    const challenge = store.db.prepare("SELECT * FROM webauthn_challenges WHERE user_id=? AND kind='registration' AND challenge=? AND used_at IS NULL AND expires_at>? LIMIT 1").get(user.id, responseChallenge, now()) as any;
    if (!challenge) return bad(reply, 400, 'challenge_missing_or_expired');
    try { const result = await verifyRegistrationResponse({ response: request.body as any, expectedChallenge: challenge.challenge, expectedOrigin: expectedOrigin!, expectedRPID: rpID!, requireUserVerification: true }); if (!result.verified || !result.registrationInfo) return bad(reply, 400, 'passkey_verification_failed'); const c = result.registrationInfo.credential; const consumed = store.transaction(() => { const claimed = store.db.prepare("UPDATE webauthn_challenges SET used_at=? WHERE id=? AND used_at IS NULL").run(now(), challenge.id); if (claimed.changes !== 1) return false; store.db.prepare('INSERT INTO passkey_credentials(id,user_id,public_key,counter,transports,created_at) VALUES(?,?,?,?,?,?)').run(c.id, user.id, Buffer.from(c.publicKey), c.counter, JSON.stringify(c.transports ?? []), now()); return true; }); if (!consumed) return bad(reply, 400, 'challenge_missing_or_expired'); return { verified: true }; } catch { return bad(reply, 400, 'passkey_verification_failed'); }
  });
  app.post('/api/v1/auth/passkey/login/options', async (request, reply) => {
    if (!checkOrigin(request, reply)) return; if (!webauthnConfigured(reply)) return;
    store.db.prepare("DELETE FROM webauthn_challenges WHERE used_at IS NOT NULL OR expires_at<=?").run(now());
    const options = await generateAuthenticationOptions({ rpID: rpID!, userVerification: 'required' }); const id = crypto.randomUUID(); store.db.prepare('INSERT INTO webauthn_challenges(id,kind,challenge,created_at,expires_at) VALUES(?,?,?,?,?)').run(id, 'authentication', options.challenge, now(), new Date(Date.now() + 120000).toISOString()); return options;
  });
  app.post('/api/v1/auth/passkey/login/verify', async (request, reply) => {
    if (!checkOrigin(request, reply)) return; if (!webauthnConfigured(reply)) return;
    const body = request.body as any; const credential = store.db.prepare('SELECT * FROM passkey_credentials WHERE id=?').get(body?.id) as any; const responseChallenge = webauthnChallengeFromResponse(body); const challenge = responseChallenge ? store.db.prepare("SELECT * FROM webauthn_challenges WHERE kind='authentication' AND challenge=? AND used_at IS NULL AND expires_at>? LIMIT 1").get(responseChallenge, now()) as any : null;
    if (!credential || !challenge) return bad(reply, 401, 'passkey_verification_failed');
    try { const result = await verifyAuthenticationResponse({ response: body, expectedChallenge: challenge.challenge, expectedOrigin: expectedOrigin!, expectedRPID: rpID!, credential: { id: credential.id, publicKey: new Uint8Array(credential.public_key), counter: credential.counter }, requireUserVerification: true }); if (!result.verified) return bad(reply, 401, 'passkey_verification_failed'); const consumed = store.transaction(() => { const claimed = store.db.prepare("UPDATE webauthn_challenges SET used_at=?, credential_id=?, user_id=? WHERE id=? AND used_at IS NULL AND (credential_id IS NULL OR credential_id=?) AND (user_id IS NULL OR user_id=?)").run(now(), credential.id, credential.user_id, challenge.id, credential.id, credential.user_id); if (claimed.changes !== 1) return false; store.db.prepare('UPDATE passkey_credentials SET counter=? WHERE id=?').run(result.authenticationInfo.newCounter, credential.id); return true; }); if (!consumed) return bad(reply, 401, 'passkey_verification_failed'); issueSession(credential.user_id, reply); return { verified: true, user: publicUser(store.db.prepare('SELECT * FROM users WHERE id=?').get(credential.user_id)) }; } catch { return bad(reply, 401, 'passkey_verification_failed'); }
  });

  function agentDto(row: any) {
    return { id: row.id, name: row.name, avatar: row.avatar ?? null, role: row.role, enabled: Boolean(row.enabled) };
  }
  function ensureDefaultAgent(userId: string) {
    const existing = store.db.prepare("SELECT * FROM agent_profiles WHERE owner_id=? AND name='Wangke Bot'").get(userId) as any;
    if (existing) return existing;
    const timestamp = now();
    const row = { id: crypto.randomUUID(), owner_id: userId, name: 'Wangke Bot', avatar: null, role: '本机学习助手', system_prompt: 'You are Wangke Bot, a safe learning assistant.', enabled: 1, created_at: timestamp, updated_at: timestamp };
    store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,avatar,role,system_prompt,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(row.id, row.owner_id, row.name, row.avatar, row.role, row.system_prompt, row.enabled, row.created_at, row.updated_at);
    return row;
  }
  function ownedThread(userId: string, threadId: string) { return store.db.prepare('SELECT * FROM threads WHERE id=? AND owner_id=?').get(threadId, userId) as any; }
  function appendEvent(threadId: string, type: string, payload: unknown) {
    const seq = (store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM message_events WHERE thread_id=?').get(threadId) as { seq: number }).seq;
    store.db.prepare('INSERT INTO message_events(id,thread_id,seq,type,payload,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), threadId, seq, type, JSON.stringify(payload), now());
  }

  app.get('/api/v1/agents', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    ensureDefaultAgent(user.id);
    return { agents: (store.db.prepare('SELECT * FROM agent_profiles WHERE owner_id=? ORDER BY created_at').all(user.id) as any[]).map(agentDto) };
  });
  app.post<{ Body: { name?: string; avatar?: string; role?: string; systemPrompt?: string } }>('/api/v1/agents', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const body = request.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const role = typeof body.role === 'string' ? body.role.trim() : '';
    const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';
    const avatar = typeof body.avatar === 'string' ? body.avatar.trim() : '';
    if (!name || name.length > 80 || /[\u0000\r\n]/.test(name) || role.length > 120 || systemPrompt.length > 4000 || avatar.length > 500) return bad(reply, 400, 'invalid_agent_profile');
    if ((store.db.prepare('SELECT COUNT(*) AS count FROM agent_profiles WHERE owner_id=?').get(user.id) as { count: number }).count >= 16) return bad(reply, 409, 'agent_limit_reached');
    const timestamp = now(); const row = { id: crypto.randomUUID(), name, avatar: avatar || null, role: role || '协作 Agent', system_prompt: systemPrompt || `You are ${name}, a safe collaborative learning assistant.`, enabled: 1, created_at: timestamp, updated_at: timestamp };
    try { store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,avatar,role,system_prompt,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(row.id, user.id, row.name, row.avatar, row.role, row.system_prompt, row.enabled, row.created_at, row.updated_at); } catch (error: any) { if (String(error?.code) === 'SQLITE_CONSTRAINT_UNIQUE') return bad(reply, 409, 'agent_name_taken'); throw error; }
    return reply.code(201).send(agentDto(row));
  });

  const threadFields = 'id,mode,title,project_id AS projectId,agent_id AS agentId,archived,created_at AS createdAt,updated_at AS updatedAt';
  app.get<{ Querystring: { projectId?: string; agentId?: string } }>('/api/v1/threads', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const { projectId, agentId } = request.query;
    if (projectId) projects.get(user.id, projectId);
    if (agentId) projects.agent(user.id, agentId);
    // preview：最近一条文本消息，给会话列表显示「最后一句话」。走 messages(thread_id, seq) 唯一索引，每行一次索引查找。
    const preview = "(SELECT content FROM messages WHERE thread_id=threads.id AND kind='text' ORDER BY seq DESC LIMIT 1) AS preview";
    const rows = store.db.prepare(`SELECT ${threadFields},${preview} FROM threads WHERE owner_id=?${projectId ? ' AND project_id=?' : ''}${agentId ? ' AND agent_id=?' : ''} ORDER BY updated_at DESC,id`).all(user.id, ...(projectId ? [projectId] : []), ...(agentId ? [agentId] : [])) as Array<Record<string, unknown>>;
    return { threads: rows.map(row => ({ ...row, archived: Boolean(row.archived), preview: typeof row.preview === 'string' ? row.preview.slice(0, 160) : null })) };
  });
  app.post<{ Body: { mode?: ConversationMode; title?: string; projectId?: string; agentId?: string } }>('/api/v1/threads', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    if (request.body?.mode !== 'chat' && request.body?.mode !== 'bot') return bad(reply, 400, 'invalid_mode');
    const projectId = request.body.projectId ?? null;
    if (projectId !== null && (typeof projectId !== 'string' || !projectId || request.body.mode !== 'bot')) return bad(reply, 400, 'invalid_project');
    const agentId = request.body.agentId ?? (request.body.mode === 'bot' ? ensureDefaultAgent(user.id).id : null);
    if (agentId !== null) projects.agent(user.id, agentId);
    if (projectId) projects.authorize(user.id, projectId, agentId);
    const id = crypto.randomUUID(); const timestamp = now(); const title = String(request.body.title ?? '').slice(0, 200) || null;
    store.transaction(() => {
      store.db.prepare('INSERT INTO threads(id,owner_id,mode,title,project_id,agent_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, user.id, request.body!.mode, title, projectId, agentId, timestamp, timestamp);
      if (request.body!.mode === 'bot') {
        store.db.prepare('INSERT INTO thread_participants(thread_id,agent_id,joined_at) VALUES(?,?,?)').run(id, agentId, timestamp);
      }
    });
    return reply.code(201).send({ id, mode: request.body.mode, title, projectId, agentId, archived: false, createdAt: timestamp, updatedAt: timestamp });
  });
  app.patch<{ Params: { id: string }; Body: { title?: unknown; archived?: unknown } }>('/api/v1/threads/:id', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    const body = request.body;
    if (!body || Object.keys(body).some(k => !['title', 'archived'].includes(k)) || (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200)) || (body.archived !== undefined && typeof body.archived !== 'boolean')) return bad(reply, 400, 'invalid_thread');
    store.db.prepare('UPDATE threads SET title=?,archived=?,updated_at=? WHERE id=?').run(body.title ?? thread.title, Number(body.archived ?? thread.archived), now(), thread.id);
    if (body.archived === true) {
      const runs = store.db.prepare("SELECT id FROM runs WHERE thread_id=? AND status IN ('queued','running','waiting_user')").all(thread.id) as Array<{ id: string }>;
      for (const run of runs) { store.db.prepare("UPDATE runs SET status='cancelled',completed_at=?,wake_at=NULL WHERE id=?").run(now(), run.id); runner.cancel(run.id); }
    }
    return { ...store.db.prepare(`SELECT ${threadFields} FROM threads WHERE id=?`).get(thread.id) as object, archived: Boolean(body.archived ?? thread.archived) };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/threads/:id', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    if (runner.isThreadActive(thread.id) || store.db.prepare("SELECT 1 FROM runs WHERE thread_id=? AND status IN ('queued','running','waiting_user')").get(thread.id)) return bad(reply, 409, 'thread_busy');
    store.transaction(() => { store.db.prepare('DELETE FROM approvals WHERE thread_id=?').run(thread.id); store.db.prepare('DELETE FROM threads WHERE id=?').run(thread.id); });
    return { deleted: true };
  });
  app.post<{ Params: { id: string }; Body: { agentId?: string } }>('/api/v1/threads/:id/participants', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread || thread.mode !== 'bot') return bad(reply, 404, 'thread_not_found');
    if (thread.project_id) return bad(reply, 409, 'project_thread_single_agent');
    const agent = store.db.prepare('SELECT * FROM agent_profiles WHERE id=? AND owner_id=? AND enabled=1').get(request.body?.agentId, user.id) as any;
    if (!agent) return bad(reply, 404, 'agent_not_found');
    if ((store.db.prepare('SELECT COUNT(*) AS count FROM thread_participants WHERE thread_id=?').get(thread.id) as { count: number }).count >= 8) return bad(reply, 409, 'participant_limit_reached');
    store.db.prepare('INSERT OR IGNORE INTO thread_participants(thread_id,agent_id,joined_at) VALUES(?,?,?)').run(thread.id, agent.id, now());
    return agentDto(agent);
  });
  app.delete<{ Params: { id: string; agentId: string } }>('/api/v1/threads/:id/participants/:agentId', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    if (thread.project_id) return bad(reply, 409, 'project_thread_single_agent');
    const agent = store.db.prepare('SELECT id,name FROM agent_profiles WHERE id=? AND owner_id=?').get(request.params.agentId, user.id) as { id: string; name: string } | undefined;
    if (!agent) return bad(reply, 404, 'agent_not_found');
    const removed = store.db.prepare('DELETE FROM thread_participants WHERE thread_id=? AND agent_id=?').run(thread.id, agent.id);
    if (!removed.changes) return bad(reply, 404, 'participant_not_found');
    return { removed: true };
  });

  function fileDto(row: any) {
    return { id: row.id, originalName: row.original_name, mimeType: row.mime_type, sizeBytes: row.size_bytes, sha256: row.sha256, createdAt: row.created_at };
  }
  app.get('/api/v1/files/config', async () => ({ maxFileBytes }));
  app.get('/api/v1/files', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    return { files: (store.db.prepare('SELECT * FROM files WHERE owner_id=? ORDER BY created_at DESC LIMIT 500').all(user.id) as any[]).map(fileDto) };
  });
  app.post('/api/v1/files', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const body = request.body instanceof Readable ? request.body : null;
    const declaredSize = request.headers['content-length'] === undefined ? undefined : Number(request.headers['content-length']);
    if (!body || (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > maxFileBytes))) return bad(reply, 413, 'file_too_large_or_invalid');
    const encodedName = request.headers['x-file-name'];
    const mimeHeader = request.headers['x-file-mime'];
    let originalName = typeof encodedName === 'string' ? encodedName : 'attachment';
    try { originalName = decodeURIComponent(originalName); } catch { return bad(reply, 400, 'invalid_file_name'); }
    if (!originalName || originalName.length > 255 || /[\u0000\\/]/.test(originalName)) return bad(reply, 400, 'invalid_file_name');
    const mimeType = typeof mimeHeader === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mimeHeader) ? mimeHeader.slice(0, 200) : 'application/octet-stream';
    return reply.code(201).send(await receiveFile(store, filesDir, user.id, body, originalName, mimeType, maxFileBytes, declaredSize));
  });
  app.get<{ Params: { id: string } }>('/api/v1/files/:id', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const file = store.db.prepare('SELECT * FROM files WHERE id=? AND owner_id=?').get(request.params.id, user.id) as any;
    if (!file) return bad(reply, 404, 'file_not_found');
    const resolved = path.resolve(filesDir, file.storage_name);
    if (!resolved.startsWith(`${path.resolve(filesDir)}${path.sep}`)) return bad(reply, 404, 'file_not_found');
    if (!fs.existsSync(resolved)) return bad(reply, 404, 'file_not_found');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    reply.type(file.mime_type);
    reply.header('accept-ranges', 'bytes');
    const range = byteRange(request.headers.range, file.size_bytes);
    if (range === false) return reply.code(416).header('content-range', `bytes */${file.size_bytes}`).send();
    if (range) {
      reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${file.size_bytes}`).header('content-length', range.end - range.start + 1);
      return reply.send(fs.createReadStream(resolved, range));
    }
    reply.header('content-length', file.size_bytes);
    return reply.send(fs.createReadStream(resolved));
  });
  app.delete<{ Params: { id: string } }>('/api/v1/files/:id', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const file = store.db.prepare('SELECT * FROM files WHERE id=? AND owner_id=?').get(request.params.id, user.id) as any;
    if (!file) return bad(reply, 404, 'file_not_found');
    store.db.prepare('DELETE FROM files WHERE id=? AND owner_id=?').run(file.id, user.id);
    fs.rmSync(path.join(filesDir, file.storage_name), { force: true });
    return { deleted: true };
  });
  app.get<{ Params: { id: string } }>('/api/v1/threads/:id', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    const participants = (store.db.prepare('SELECT a.* FROM agent_profiles a JOIN thread_participants p ON p.agent_id=a.id WHERE p.thread_id=? ORDER BY p.joined_at').all(thread.id) as any[]).map(agentDto);
    const approvals = store.db.prepare('SELECT id,message_id AS messageId,run_id AS runId,status,created_at AS createdAt,resolved_at AS resolvedAt,resolution FROM approvals WHERE thread_id=? ORDER BY created_at').all(thread.id);
    // running：有没有排队或正在跑的任务，前端据此显示「正在输入」和已读。
    const running = Boolean(store.db.prepare("SELECT 1 FROM runs WHERE thread_id=? AND status IN ('queued','running') LIMIT 1").get(thread.id));
    return { id: thread.id, mode: thread.mode, title: thread.title, projectId: thread.project_id, agentId: thread.agent_id, archived: Boolean(thread.archived), createdAt: thread.created_at, updatedAt: thread.updated_at, participants, approvals, running, messages: store.db.prepare('SELECT id,thread_id AS threadId,client_nonce AS clientNonce,seq,role,kind,content,reply_to AS replyTo,created_at AS createdAt FROM messages WHERE thread_id=? ORDER BY seq').all(thread.id) };
  });
  app.post<{ Params: { id: string } }>('/api/v1/threads/:id/stop', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    const runs = store.db.prepare("SELECT id FROM runs WHERE thread_id=? AND status IN ('queued','running','waiting_user')").all(thread.id) as Array<{ id: string }>;
    store.transaction(() => {
      store.db.prepare("UPDATE runs SET status='cancelled',completed_at=?,wake_at=NULL WHERE thread_id=? AND status IN ('queued','running','waiting_user')").run(now(), thread.id);
    });
    for (const run of runs) runner.cancel(run.id);
    return { stopped: runs.length };
  });
  app.get<{ Params: { id: string } }>('/api/v1/threads/:id/runs', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    return { runs: store.db.prepare('SELECT id,status,step_count AS stepCount,wake_at AS wakeAt,error_code AS errorCode FROM runs WHERE thread_id=? ORDER BY created_at DESC LIMIT 50').all(thread.id) };
  });
  app.post<{ Params: { id: string }; Body: { clientNonce?: string; role?: MessageRole; kind?: string; content?: string; replyTo?: string } }>('/api/v1/threads/:id/messages', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    if (thread.archived) return bad(reply, 409, 'thread_archived');
    if (thread.project_id) projects.authorize(user.id, thread.project_id, thread.agent_id);
    const b = request.body ?? {};
    const nonce = b.clientNonce;
    const kind = b.kind ?? 'text';
    // This endpoint accepts client-authored messages only. Server roles cannot be forged by a browser client.
    if (typeof nonce !== 'string' || nonce.length < 1 || nonce.length > 200 ||
        (b.role !== undefined && b.role !== 'user') || !messageKinds.has(kind) ||
        typeof b.content !== 'string' || b.content.length > 100000 ||
        (kind === 'attachment' && (() => {
          try {
            const value = JSON.parse(b.content);
            if (thread.project_id) {
              if (value.projectId !== thread.project_id || typeof value.projectPath !== 'string') return true;
              if (process.platform !== 'linux') projects.assertIdle(thread.project_id);
              const file = projects.files.open(thread.project_id, value.projectPath); fs.closeSync(file.fd); return false;
            }
            return typeof value?.fileId !== 'string' || !store.db.prepare('SELECT 1 FROM files WHERE id=? AND owner_id=?').get(value.fileId, user.id);
          } catch { return true; }
        })())) return bad(reply, 400, 'invalid_message');
    if (b.replyTo && !store.db.prepare('SELECT 1 FROM messages WHERE id=? AND thread_id=?').get(b.replyTo, thread.id)) return bad(reply, 400, 'invalid_reply_to');
    const makeDto = (row: any, deduplicated = false) => ({ id: row.id, threadId: row.thread_id, clientNonce: row.client_nonce, seq: row.seq, role: row.role, kind: row.kind, content: row.content, replyTo: row.reply_to, createdAt: row.created_at, ...(deduplicated ? { deduplicated: true } : {}) });
    const existing = store.db.prepare('SELECT * FROM messages WHERE thread_id=? AND client_nonce=?').get(thread.id, nonce) as any;
    if (existing) return makeDto(existing, true);
    try {
      const message = store.transaction(() => {
        const seq = (store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages WHERE thread_id=?').get(thread.id) as any).seq;
        const timestamp = now(); const id = crypto.randomUUID();
        const dto = { id, threadId: thread.id, clientNonce: nonce, seq, role: 'user', kind, content: b.content!, replyTo: b.replyTo ?? null, createdAt: timestamp };
         store.db.prepare('INSERT INTO messages(id,thread_id,client_nonce,seq,role,kind,content,reply_to,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, thread.id, nonce, seq, 'user', kind, b.content, dto.replyTo, timestamp);
         if (thread.mode === 'bot' && typeof b.content === 'string') {
           const requested = new Set(Array.from(b.content.matchAll(/@([^\s@,，。！？!?]{1,64})/g), match => match[1].toLocaleLowerCase()));
           const participants = store.db.prepare('SELECT a.id,a.name FROM agent_profiles a JOIN thread_participants p ON p.agent_id=a.id WHERE p.thread_id=? AND a.enabled=1').all(thread.id) as Array<{ id: string; name: string }>;
           for (const participant of participants) if (requested.has(participant.name.toLocaleLowerCase())) store.db.prepare('INSERT OR IGNORE INTO message_mentions(message_id,agent_id,created_at) VALUES(?,?,?)').run(id, participant.id, timestamp);
         }
         store.db.prepare('INSERT INTO message_events(id,thread_id,seq,type,payload,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), thread.id, seq, 'message.accepted', JSON.stringify(dto), timestamp);
        if (thread.mode === 'bot') store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at,trigger_message_id) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), thread.id, 'bot', 'queued', timestamp, id);
        store.db.prepare('UPDATE threads SET updated_at=? WHERE id=?').run(timestamp, thread.id);
        return dto;
      });
      if (thread.mode === 'bot') {
        const run = store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(message.id) as { id: string } | undefined;
        if (run) runner.enqueue(run.id);
      }
      return reply.code(201).send({ ...message, deduplicated: false });
    } catch (error: any) {
      if (String(error?.code) === 'SQLITE_CONSTRAINT_UNIQUE') {
        const row = store.db.prepare('SELECT * FROM messages WHERE thread_id=? AND client_nonce=?').get(thread.id, nonce) as any;
        if (row) return makeDto(row, true);
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string }; Body: { reaction?: string } }>('/api/v1/messages/:id/reactions', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const reaction = typeof request.body?.reaction === 'string' ? request.body.reaction.trim() : '';
    if (!/^(?:\p{Extended_Pictographic}|[+\-_*#]){1,8}$/u.test(reaction)) return bad(reply, 400, 'invalid_reaction');
    const message = store.db.prepare('SELECT m.id,m.thread_id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=? AND t.owner_id=?').get(request.params.id, user.id) as { id: string; thread_id: string } | undefined;
    if (!message) return bad(reply, 404, 'message_not_found');
    const result = store.transaction(() => {
      const existing = store.db.prepare('SELECT 1 FROM message_reactions WHERE message_id=? AND user_id=? AND reaction=?').get(message.id, user.id, reaction);
      if (existing) { store.db.prepare('DELETE FROM message_reactions WHERE message_id=? AND user_id=? AND reaction=?').run(message.id, user.id, reaction); appendEvent(message.thread_id, 'message.reaction', { messageId: message.id, reaction, active: false }); return false; }
      store.db.prepare('INSERT INTO message_reactions(message_id,user_id,reaction,created_at) VALUES(?,?,?,?)').run(message.id, user.id, reaction, now());
      appendEvent(message.thread_id, 'message.reaction', { messageId: message.id, reaction, active: true });
      return true;
    });
    return { messageId: message.id, reaction, active: result };
  });

  app.get<{ Params: { id: string } }>('/api/v1/messages/:id/reactions', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const message = store.db.prepare('SELECT m.id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=? AND t.owner_id=?').get(request.params.id, user.id) as { id: string } | undefined;
    if (!message) return bad(reply, 404, 'message_not_found');
    return { reactions: store.db.prepare('SELECT reaction,COUNT(*) AS count,MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS mine FROM message_reactions WHERE message_id=? GROUP BY reaction ORDER BY reaction').all(user.id, message.id) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/approvals/:id', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const approval = store.db.prepare('SELECT a.id,a.message_id AS messageId,a.thread_id AS threadId,a.run_id AS runId,a.status,a.created_at AS createdAt,a.resolved_at AS resolvedAt,a.resolution FROM approvals a JOIN threads t ON t.id=a.thread_id WHERE a.id=? AND t.owner_id=?').get(request.params.id, user.id) as any;
    if (!approval) return bad(reply, 404, 'approval_not_found');
    return approval;
  });
  app.post<{ Params: { id: string }; Body: { approved?: boolean; resolution?: string } }>('/api/v1/approvals/:id/resolve', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    if (typeof request.body?.approved !== 'boolean') return bad(reply, 400, 'invalid_approval_resolution');
    const resolution = typeof request.body.resolution === 'string' ? request.body.resolution.trim().slice(0, 2000) : '';
    const resolved = store.transaction(() => {
      const approval = store.db.prepare('SELECT a.*,t.owner_id FROM approvals a JOIN threads t ON t.id=a.thread_id WHERE a.id=? AND t.owner_id=?').get(request.params.id, user.id) as any;
      if (!approval) return { error: 'approval_not_found' as const };
      if (approval.status !== 'pending') return { error: 'approval_already_resolved' as const };
      const status = request.body!.approved ? 'approved' : 'rejected'; const timestamp = now();
      store.db.prepare('UPDATE approvals SET status=?,resolved_at=?,resolution=? WHERE id=? AND status=\'pending\'').run(status, timestamp, resolution || null, approval.id);
      const run = (approval.run_id ? store.db.prepare("SELECT id FROM runs WHERE id=? AND status='waiting_user'").get(approval.run_id) : store.db.prepare("SELECT id FROM runs WHERE thread_id=? AND status='waiting_user' ORDER BY created_at DESC LIMIT 1").get(approval.thread_id)) as { id: string } | undefined;
      if (run) {
        const nonce = `approval:${approval.id}:${status}`;
        const seq = (store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages WHERE thread_id=?').get(approval.thread_id) as { seq: number }).seq;
        const messageId = crypto.randomUUID(); const content = `Approval ${status}: ${resolution || (status === 'approved' ? 'approved' : 'rejected')}`;
        const dto = { id: messageId, threadId: approval.thread_id, clientNonce: nonce, seq, role: 'user', kind: 'text', content, replyTo: approval.message_id, createdAt: timestamp };
        store.db.prepare('INSERT INTO messages(id,thread_id,client_nonce,seq,role,kind,content,reply_to,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(messageId, approval.thread_id, nonce, seq, 'user', 'text', content, approval.message_id, timestamp);
        store.db.prepare('INSERT INTO message_events(id,thread_id,seq,type,payload,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), approval.thread_id, seq, 'message.accepted', JSON.stringify(dto), timestamp);
        store.db.prepare("UPDATE runs SET status='queued',completed_at=NULL,error_code=NULL WHERE id=? AND status='waiting_user'").run(run.id);
        store.db.prepare('UPDATE threads SET updated_at=? WHERE id=?').run(timestamp, approval.thread_id);
      }
      return { approval: { id: approval.id, messageId: approval.message_id, threadId: approval.thread_id, runId: approval.run_id ?? run?.id ?? null, status, createdAt: approval.created_at, resolvedAt: timestamp, resolution: resolution || null }, runId: run?.id ?? null };
    });
    if ('error' in resolved) {
      const errorCode = resolved.error ?? 'approval_not_found';
      return bad(reply, errorCode === 'approval_not_found' ? 404 : 409, errorCode);
    }
    if (resolved.runId) runner.enqueue(resolved.runId);
    return resolved.approval;
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/v1/threads/:id/events', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    const rawCursor = request.query.after ?? request.headers['last-event-id'];
    const after = rawCursor === undefined || rawCursor === '' ? 0 : Number(rawCursor);
    if (!Number.isSafeInteger(after) || after < 0) return bad(reply, 400, 'invalid_event_cursor');
    const events = store.db.prepare('SELECT event_id,type,payload FROM message_events WHERE thread_id=? AND event_id>? ORDER BY event_id').all(thread.id, after) as any[];
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
     for (const event of events) {
       // Message events created by early migrations stored the DTO directly;
       // the versioned contract exposes it under `message`. Normalize both
       // shapes at the transport boundary so old volumes remain readable.
       let payload = event.payload;
       if (event.type.startsWith('message.')) {
         try {
           const parsed = JSON.parse(event.payload) as Record<string, unknown>;
           if (!('message' in parsed)) payload = JSON.stringify({ message: parsed });
         } catch {
           payload = JSON.stringify({ message: { content: '消息事件格式无效。' } });
         }
       }
       reply.raw.write(`id: ${event.event_id}\nevent: ${event.type}\ndata: ${payload}\n\n`);
     }
    reply.raw.end();
  });

  app.post<{ Body: { threadId?: string; mode?: ConversationMode } }>('/api/v1/runs', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.body?.threadId ?? '');
    if (!thread || (request.body?.mode && request.body.mode !== thread.mode)) return bad(reply, 404, 'thread_not_found');
    if (thread.archived) return bad(reply, 409, 'thread_archived');
    if (thread.project_id) projects.authorize(user.id, thread.project_id, thread.agent_id);
    const id = crypto.randomUUID(); const timestamp = now();
    store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,?,?,?)').run(id, thread.id, thread.mode, 'queued', timestamp);
    if (thread.mode === 'bot') runner.enqueue(id);
    return reply.code(201).send({ id, threadId: thread.id, mode: thread.mode, status: 'queued', createdAt: timestamp, completedAt: null });
  });
  app.get<{ Params: { id: string } }>('/api/v1/runs/:id', async (request, reply) => { const user = requireAuth(request, reply); if (!user) return; const run = store.db.prepare('SELECT r.* FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=?').get(request.params.id, user.id) as any; if (!run) return bad(reply, 404, 'run_not_found'); return { id: run.id, threadId: run.thread_id, mode: run.mode, status: run.status, createdAt: run.created_at, startedAt: run.started_at ?? null, completedAt: run.completed_at ?? null, errorCode: run.error_code ?? null }; });
  app.post<{ Params: { id: string } }>('/api/v1/runs/:id/cancel', async (request, reply) => { if (!checkOrigin(request, reply)) return; const user = requireAuth(request, reply); if (!user) return; const run = store.db.prepare('SELECT r.* FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=?').get(request.params.id, user.id) as any; if (!run) return bad(reply, 404, 'run_not_found'); if (!['completed', 'failed', 'cancelled'].includes(run.status)) store.transaction(() => { store.db.prepare("UPDATE runs SET status='cancelled',completed_at=? WHERE id=? AND status NOT IN ('completed','failed','cancelled')").run(now(), run.id); }); runner.cancel(run.id); const updated = store.db.prepare('SELECT * FROM runs WHERE id=?').get(run.id) as any; return { id: updated.id, threadId: updated.thread_id, mode: updated.mode, status: updated.status, createdAt: updated.created_at, startedAt: updated.started_at ?? null, completedAt: updated.completed_at ?? null, errorCode: updated.error_code ?? null }; });

  if (hasWeb) app.setNotFoundHandler((request, reply) => request.method === 'GET' && !request.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: 'not_found' }));
  app.addHook('onClose', async () => { await cloudRunner.close(); await runner.close(); await mcp.close(); store.close(); });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) { const app = buildServer(); app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3000) }).catch((error) => { app.log.error(error); process.exit(1); }); }
