import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseStore } from '../storage/database.js';
import { CloudRecords, CloudConflict } from './records.js';
import { CloudConfiguration } from './config.js';
import { CloudTaskRunner, taskDto, TASK_KINDS, workerIdentity } from './tasks.js';
import { workerTokens, workerTokenHash, renewWorker } from './workerAuth.js';
import type { CloudConfig, CloudMutation } from '../../../../packages/contracts/src/cloud.js';
import { accountedFetch } from '../agent/accounted-fetch.js';
import { UsageLedger, BudgetBlocked } from '../agent/budget.js';

interface Dependencies {
  store: DatabaseStore; records: CloudRecords; configuration: CloudConfiguration;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => any;
  checkOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  filesDir: string; maxFileBytes: number; fetch?: typeof fetch;
}

export function registerCloudRoutes(app: FastifyInstance, deps: Dependencies) {
  const { store, records, configuration, requireAuth, checkOrigin } = deps;
  const runner = new CloudTaskRunner(store, { records, configuration, filesDir: deps.filesDir, fetch: deps.fetch });
  const fail = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });
  const ownedTask = (owner: string, id: string) => store.db.prepare('SELECT * FROM cloud_tasks WHERE id=? AND owner_id=?').get(id, owner) as any;
  const authorize = (request: FastifyRequest, reply: FastifyReply, admin = false) => {
    if (!['GET', 'HEAD'].includes(request.method) && !checkOrigin(request, reply)) return null;
    const user = requireAuth(request, reply);
    if (user && admin && workerIdentity(request)) { fail(reply, 403, 'worker_scope_denied'); return null; }
    return user;
  };
  app.addHook('onListen', async () => {
    if (process.env.CLOUD_WORKER_DISABLED === '1') return;
    const address = app.server.address();
    if (address && typeof address === 'object') runner.start(`http://127.0.0.1:${address.port}`);
  });

  app.get('/api/v1/cloud/status', async () => ({ cloud: true, maxFileBytes: deps.maxFileBytes,
    passkeyConfigured: Boolean(process.env.PUBLIC_ORIGIN && process.env.WEBAUTHN_RP_ID), singleUser: true }));
  app.get('/api/v1/cloud/config', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    return configuration.get(user.id);
  });
  app.put<{ Body: CloudConfig }>('/api/v1/cloud/config', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return configuration.save(user.id, request.body); }
    catch (e) { return fail(reply, 400, e instanceof Error ? e.message : 'invalid_config'); }
  });
  app.get<{ Querystring: { after?: string } }>('/api/v1/cloud/records', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    const after = Number(request.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return fail(reply, 400, 'invalid_cursor');
    const result = records.list(user.id, after);
    return { records: result, cursor: result.at(-1)?.revision ?? after, more: result.length === 200 };
  });
  app.get<{ Querystring: { table: string; key: string } }>('/api/v1/cloud/record', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    try { return { value: records.get(user.id, request.query.table, JSON.parse(request.query.key)) }; }
    catch { return fail(reply, 400, 'invalid_record_key'); }
  });
  app.post<{ Body: { mutations: CloudMutation[] } }>('/api/v1/cloud/records', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    const mutations = request.body?.mutations;
    if (!Array.isArray(mutations) || !mutations.length || mutations.length > 20000) return fail(reply, 400, 'invalid_mutations');
    const worker = workerIdentity(request);
    if (worker) {
      const task = ownedTask(user.id, worker.taskId);
      const token = request.headers.authorization?.slice(7);
      if (!task || task.worker_id !== workerTokenHash(token ?? '') || !['running', 'waiting_user'].includes(task.status) || (task.lease_expires_at && Date.parse(task.lease_expires_at) <= Date.now())) return fail(reply, 409, 'worker_lease_expired');
      const policy = configuration.get(user.id).policy;
      const automatic: Record<string, string[]> = {
        chat: ['chats', 'chatSessions'], qa: ['chats', 'chatSessions'],
        transcribe: ['videos', 'segments', 'subtitleTracks'], material: ['videos', 'materialBlocks'],
        cover: ['videos', 'covers'], handout: ['handouts', 'frames'], cards: ['cards'], comments: ['comments'], danmaku: ['danmakus'],
      };
      for (const mutation of mutations) {
        if (!mutation) return fail(reply, 400, 'invalid_mutation');
        if (store.db.prepare('SELECT 1 FROM cloud_operations WHERE owner_id=? AND id=?').get(user.id, mutation.id)) continue;
        if (task.parent_run_id && configuration.taskPolicy(user.id, task.id).write !== 'allow') return fail(reply, 403, 'bot_child_write_permission_required');
        if (automatic[task.kind]?.includes(mutation.table)) {
          const input = JSON.parse(task.input);
          const rows = [mutation.before, mutation.after].filter(Boolean);
          const scoped = rows.every(row => ['chat', 'qa'].includes(task.kind)
            ? (mutation.table === 'chats' ? row!.sessionId === input.sessionId : row!.id === input.sessionId)
            : (mutation.table === 'videos' ? row!.id === input.videoId : row!.videoId === input.videoId || row!.materialId === input.videoId));
          if (!scoped) return fail(reply, 403, 'worker_resource_denied');
          continue;
        }
        const permit = mutation.permissionId && store.db.prepare("SELECT capability FROM cloud_permissions WHERE id=? AND owner_id=? AND task_id=? AND status='consumed'").get(mutation.permissionId, user.id, task.id) as { capability: 'write' | 'remove' } | undefined;
        // A write permit includes replacing a document's derived blocks. Whole-course
        // removal requires the separate remove capability.
        if (!permit || !['write', 'remove'].includes(permit.capability) || policy[permit.capability] === 'deny' ||
            (mutation.table === 'videos' && mutation.after === null && permit.capability !== 'remove')) return fail(reply, 403, `worker_mutation_denied:${mutation.table}:${mutation.permissionId ? 'inactive_permit' : 'missing_permit'}`);
      }
    }
    try { return records.apply(user.id, mutations); }
    catch (e) {
      if (e instanceof CloudConflict) return reply.code(409).send({ error: 'sync_conflict', table: e.table, key: e.key, fields: e.fields });
      return fail(reply, 400, e instanceof Error ? e.message : 'invalid_mutations');
    }
  });

  // Gateway credentials come exclusively from saved configuration. No caller-controlled URL,
  // Authorization forwarding or redirects (which could leak a provider credential).
  app.route<{ Params: { provider: string; '*': string } }>({
    method: ['GET', 'POST'], url: '/api/v1/cloud/models/:provider/*',
    onRequest: async (request, reply) => { authorize(request, reply); },
    handler: async (request, reply) => {
      const user = authorize(request, reply); if (!user) return;
      const provider = configuration.get(user.id, true).providers.find(p => p.id === request.params.provider);
      const endpoint = request.params['*'];
      if (!provider || !['models', 'chat/completions', 'responses', 'messages', 'audio/transcriptions', 'systemone'].includes(endpoint)) return fail(reply, 404, 'model_endpoint_not_found');
      if ((endpoint === 'models') !== (request.method === 'GET')) return fail(reply, 405, 'method_not_allowed');
      const headers: Record<string, string> = {};
      if (provider.apiKey) {
        if (provider.protocol === 'anthropic-messages') headers['x-api-key'] = provider.apiKey;
        else headers.authorization = `Bearer ${provider.apiKey}`;
      }
      if (provider.protocol === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
      if (request.headers['content-type']) headers['content-type'] = request.headers['content-type'];
      const disconnected = new AbortController();
      request.raw.once('aborted', () => disconnected.abort());
      reply.raw.once('close', () => { if (!reply.raw.writableEnded) disconnected.abort(); });
      const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(300000), disconnected.signal]) };
      if (request.method === 'POST') {
        if (request.body instanceof Readable) { init.body = request.body as any; init.duplex = 'half'; }
        else init.body = JSON.stringify(request.body);
      }
      try {
        const pagination = new URLSearchParams();
        if (endpoint === 'models') {
          const query = new URL(request.url, 'http://localhost').searchParams;
          for (const key of ['after_id', 'limit']) {
            const value = query.get(key);
            if (value !== null) pagination.set(key, value);
          }
        }
        const worker = workerIdentity(request);
        const task = worker ? ownedTask(user.id, worker.taskId) : undefined;
        const fetcher = task?.parent_run_id ? accountedFetch(new UsageLedger(store, configuration), { owner: user.id, run: task.parent_run_id, step: task.parent_step_id, task: task.id, purpose: `study:${task.kind}` }, [provider], deps.fetch ?? fetch) : deps.fetch ?? fetch;
        const response = await fetcher(`${provider.baseUrl}/${endpoint}${pagination.size ? `?${pagination}` : ''}`, init);
        if (!response.ok) return fail(reply, response.status, `model_http_${response.status}`);
        reply.header('content-type', response.headers.get('content-type') ?? 'application/json');
        reply.header('cache-control', 'no-store');
        return response.body ? reply.send(Readable.fromWeb(response.body as any)) : reply.send('');
      } catch (error) {
        if (error instanceof BudgetBlocked) {
          const worker = workerIdentity(request);
          if (worker) store.db.prepare("UPDATE runs SET status='paused',error_code=? WHERE id=(SELECT parent_run_id FROM cloud_tasks WHERE id=? AND owner_id=?) AND status NOT IN ('completed','cancelled','failed')").run(error.code, worker.taskId, user.id);
          return fail(reply, 429, error.code);
        }
        return fail(reply, 502, 'model_connection_failed');
      }
    },
  });

  app.get('/api/v1/cloud/tasks', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    return { tasks: (store.db.prepare("SELECT * FROM cloud_tasks WHERE owner_id=? ORDER BY CASE WHEN status IN ('queued','running','waiting_user') THEN 0 ELSE 1 END, created_at DESC LIMIT 200").all(user.id) as any[]).map(taskDto) };
  });
  const leaseMs = 30_000;
  app.post('/api/v1/cloud/worker/claim', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    const now = new Date();
    const expires = new Date(now.getTime() + leaseMs).toISOString();
    const token = crypto.randomBytes(32).toString('base64url');
    const claimed = store.transaction(() => {
      const row = store.db.prepare("SELECT * FROM cloud_tasks WHERE owner_id=? AND executor='browser' AND status='queued' ORDER BY created_at LIMIT 1").get(user.id) as any;
      if (!row) return null;
      const changed = store.db.prepare("UPDATE cloud_tasks SET status='running',worker_id=?,lease_expires_at=?,updated_at=? WHERE id=? AND status='queued'").run(workerTokenHash(token), expires, now.toISOString(), row.id);
      return changed.changes ? row.id : null;
    });
    if (!claimed) return reply.code(204).send();
    workerTokens.set(token, { id: user.id, taskId: claimed, expiresAt: now.getTime() + leaseMs });
    const row = ownedTask(user.id, claimed);
    return { token, leaseExpiresAt: expires, task: taskDto(row) };
  });
  app.post<{ Body: { nonce: string; kind: string; resource: string; input: Record<string, unknown> } }>('/api/v1/cloud/tasks', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    const b = request.body;
    if (!b || !TASK_KINDS.includes(b.kind as any) || typeof b.nonce !== 'string' || b.nonce.length > 100 || !b.nonce ||
        typeof b.resource !== 'string' || b.resource.length > 256 || !b.resource || !b.input || typeof b.input !== 'object' || Array.isArray(b.input)) return fail(reply, 400, 'invalid_task');
    const previous = store.db.prepare('SELECT * FROM cloud_tasks WHERE owner_id=? AND nonce=?').get(user.id, b.nonce);
    if (previous) return taskDto(previous);
    // Resource locking is derived from the payload, not trusted from a client label.
    b.resource = ['chat', 'qa'].includes(b.kind) ? `session:${Number(b.input.sessionId)}`
      : typeof b.input.videoId === 'string' ? `course:${b.input.videoId}` : b.resource;
    if (['chat', 'qa'].includes(b.kind) && !records.get(user.id, 'chatSessions', Number(b.input.sessionId))) return fail(reply, 404, 'session_not_found');
    const active = store.db.prepare("SELECT * FROM cloud_tasks WHERE owner_id=? AND kind=? AND resource=? AND status IN ('queued','running','waiting_user')").get(user.id, b.kind, b.resource);
    if (active && !['chat', 'qa', 'modelOnce', 'artifactEdit', 'handoutEdit'].includes(b.kind)) return taskDto(active);
    const id = crypto.randomUUID(), now = new Date().toISOString();
    store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?)")
      .run(id, user.id, b.nonce, b.kind, b.resource, JSON.stringify(b.input), now, now);
    configuration.audit(user.id, 'task.created', { id, kind: b.kind, resource: b.resource });
    return reply.code(201).send(taskDto(ownedTask(user.id, id)));
  });
  app.get<{ Params: { id: string } }>('/api/v1/cloud/tasks/:id', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    const task = ownedTask(user.id, request.params.id);
    return task ? taskDto(task) : fail(reply, 404, 'task_not_found');
  });
  app.post<{ Params: { id: string } }>('/api/v1/cloud/tasks/:id/cancel', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    const task = ownedTask(user.id, request.params.id); if (!task) return fail(reply, 404, 'task_not_found');
    store.db.prepare("UPDATE cloud_tasks SET status='cancelled',updated_at=? WHERE id=? AND status IN ('queued','running','waiting_user')").run(new Date().toISOString(), task.id);
    await runner.cancel(task.id);
    configuration.audit(user.id, 'task.cancelled', { id: task.id });
    return { cancelled: true };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/v1/cloud/tasks/:id/events', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    if (!ownedTask(user.id, request.params.id)) return fail(reply, 404, 'task_not_found');
    const after = Number(request.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return fail(reply, 400, 'invalid_cursor');
    return { events: (store.db.prepare('SELECT seq,event FROM cloud_task_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 500').all(request.params.id, after) as any[]).map(r => ({ seq: r.seq, ...JSON.parse(r.event) })) };
  });
  app.post<{ Params: { id: string }; Body: { event?: unknown; progress?: unknown } }>('/api/v1/cloud/tasks/:id/report', async (request, reply) => {
    const worker = workerIdentity(request);
    if (!worker || worker.taskId !== request.params.id) return fail(reply, 403, 'worker_scope_denied');
    const task = ownedTask(worker.id, worker.taskId);
    if (!task || !['running', 'waiting_user'].includes(task.status)) return fail(reply, 409, 'task_not_running');
    if (task.worker_id !== workerTokenHash(request.headers.authorization?.slice(7) ?? '') || (task.lease_expires_at && Date.parse(task.lease_expires_at) <= Date.now())) return fail(reply, 409, 'worker_lease_expired');
    const lease = new Date(Date.now() + leaseMs).toISOString();
    store.db.prepare('UPDATE cloud_tasks SET lease_expires_at=?,updated_at=? WHERE id=?').run(lease, new Date().toISOString(), worker.taskId);
    renewWorker(request, Date.now() + leaseMs);
    if (request.body.event) store.db.prepare('INSERT INTO cloud_task_events(task_id,event) VALUES(?,?)').run(worker.taskId, JSON.stringify(request.body.event));
    if (request.body.progress) store.db.prepare('UPDATE cloud_tasks SET progress=?,updated_at=? WHERE id=?').run(JSON.stringify(request.body.progress), new Date().toISOString(), worker.taskId);
    const view = (request.body.progress as any)?.view;
    if (view) {
      const approval = store.db.prepare("SELECT 1 FROM cloud_permissions WHERE task_id=? AND status='pending'").get(worker.taskId);
      store.db.prepare("UPDATE cloud_tasks SET status=? WHERE id=? AND status IN ('running','waiting_user')").run(view.pendingAsk || view.pendingPlan || approval ? 'waiting_user' : 'running', worker.taskId);
    }
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { result?: unknown; error?: string } }>('/api/v1/cloud/tasks/:id/complete', async (request, reply) => {
    const worker = workerIdentity(request);
    if (!worker || worker.taskId !== request.params.id) return fail(reply, 403, 'worker_scope_denied');
    const task = ownedTask(worker.id, worker.taskId);
    const token = request.headers.authorization?.slice(7);
    if (!task || task.worker_id !== workerTokenHash(token ?? '') || !['running', 'waiting_user'].includes(task.status) || (task.lease_expires_at && Date.parse(task.lease_expires_at) <= Date.now())) return fail(reply, 409, 'worker_lease_expired');
    const error = typeof request.body?.error === 'string' ? request.body.error.slice(0, 1000) : '';
    store.db.prepare("UPDATE cloud_tasks SET status=?,result=?,error=?,lease_expires_at=NULL,worker_id=NULL,updated_at=? WHERE id=? AND status IN ('running','waiting_user')")
      .run(error ? 'failed' : 'completed', error ? null : JSON.stringify(request.body?.result ?? null), error || null, new Date().toISOString(), task.id);
    store.db.prepare("UPDATE cloud_permissions SET status='expired' WHERE task_id=? AND status IN ('pending','approved','consumed')").run(task.id);
    workerTokens.delete(token!);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { nonce: string; action: string; value?: unknown } }>('/api/v1/cloud/tasks/:id/commands', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    const task = ownedTask(user.id, request.params.id);
    if (!task || !['running', 'waiting_user'].includes(task.status)) return fail(reply, 409, 'task_not_running');
    const b = request.body;
    if (!b || typeof b.nonce !== 'string' || b.nonce.length > 100 || !['answerAsk','confirmPlan','cancelPlan'].includes(b.action)) return fail(reply, 400, 'invalid_task_command');
    store.db.prepare('INSERT OR IGNORE INTO cloud_task_commands(task_id,nonce,action,value) VALUES(?,?,?,?)').run(task.id, b.nonce, b.action, JSON.stringify(b.value ?? null));
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/v1/cloud/tasks/:id/commands/claim', async (request, reply) => {
    const worker = workerIdentity(request);
    if (!worker || worker.taskId !== request.params.id) return fail(reply, 403, 'worker_scope_denied');
    return store.transaction(() => {
      const commands = store.db.prepare('SELECT id,action,value FROM cloud_task_commands WHERE task_id=? AND consumed=0 ORDER BY id').all(worker.taskId) as any[];
      store.db.prepare('UPDATE cloud_task_commands SET consumed=1 WHERE task_id=? AND consumed=0').run(worker.taskId);
      return { commands: commands.map(c => ({ ...c, value: JSON.parse(c.value) })) };
    });
  });

  app.get('/api/v1/cloud/permissions', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    return { permissions: store.db.prepare('SELECT id,task_id AS taskId,capability,arguments,status,created_at AS createdAt FROM cloud_permissions WHERE owner_id=? ORDER BY created_at DESC LIMIT 100').all(user.id) };
  });
  app.post<{ Params: { id: string }; Body: { approved: boolean } }>('/api/v1/cloud/permissions/:id/resolve', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    if (typeof request.body?.approved !== 'boolean') return fail(reply, 400, 'invalid_decision');
    const status = request.body.approved ? 'approved' : 'rejected';
    const changed = store.db.prepare("UPDATE cloud_permissions SET status=?,resolved_at=? WHERE id=? AND owner_id=? AND status IN ('pending','approved') AND task_id IN (SELECT id FROM cloud_tasks WHERE status IN ('running','waiting_user'))").run(status, new Date().toISOString(), request.params.id, user.id);
    if (!changed.changes) return fail(reply, 409, 'permission_already_resolved');
    configuration.audit(user.id, 'permission.resolved', { id: request.params.id, status });
    return { status };
  });
  app.post<{ Params: { id: string }; Body: { capability: 'read' | 'write' | 'remove' | 'shell'; arguments: unknown; permissionId?: string } }>('/api/v1/cloud/tasks/:id/authorize', async (request, reply) => {
    const worker = workerIdentity(request);
    if (!worker || worker.taskId !== request.params.id) return fail(reply, 403, 'worker_scope_denied');
    const task = ownedTask(worker.id, worker.taskId);
    if (!task || !['running', 'waiting_user'].includes(task.status)) return fail(reply, 409, 'task_not_running');
    if (task.worker_id !== workerTokenHash(request.headers.authorization?.slice(7) ?? '') || (task.lease_expires_at && Date.parse(task.lease_expires_at) <= Date.now())) return fail(reply, 409, 'worker_lease_expired');
    const capability = request.body.capability;
    if (!['read', 'write', 'remove', 'shell'].includes(capability)) return fail(reply, 400, 'invalid_capability');
    const policy = configuration.taskPolicy(worker.id, worker.taskId)[capability];
    if (policy === 'deny') return { status: 'rejected' };
    if (request.body.permissionId) {
      const permission = store.db.prepare('SELECT * FROM cloud_permissions WHERE id=? AND owner_id=? AND task_id=? AND capability=? AND arguments=?')
        .get(request.body.permissionId, worker.id, worker.taskId, capability, JSON.stringify(request.body.arguments)) as any;
      if (!permission) return fail(reply, 404, 'permission_not_found');
      if (permission.status !== 'pending') store.db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=? AND status='waiting_user'").run(task.id);
      if (permission.status === 'approved') {
        const consumed = store.db.prepare("UPDATE cloud_permissions SET status='consumed' WHERE id=? AND status='approved'").run(permission.id);
        if (!consumed.changes) return { id: permission.id, status: 'rejected' };
        configuration.audit(worker.id, 'permission.consumed', { id: permission.id });
      }
      return { id: permission.id, status: ['pending','approved'].includes(permission.status) ? permission.status : 'rejected' };
    }
    const id = crypto.randomUUID();
    store.db.prepare('INSERT INTO cloud_permissions(id,owner_id,task_id,capability,arguments,created_at,status) VALUES(?,?,?,?,?,?,?)')
      .run(id, worker.id, worker.taskId, capability, JSON.stringify(request.body.arguments), new Date().toISOString(), policy === 'allow' ? 'consumed' : 'pending');
    if (policy !== 'allow') store.db.prepare("UPDATE cloud_tasks SET status='waiting_user' WHERE id=?").run(task.id);
    return { id, status: policy === 'allow' ? 'approved' : 'pending' };
  });
  app.post<{ Params: { id: string }; Body: { permissionId: string } }>('/api/v1/cloud/tasks/:id/authorize/finish', async (request, reply) => {
    const worker = workerIdentity(request);
    if (!worker || worker.taskId !== request.params.id) return fail(reply, 403, 'worker_scope_denied');
    store.db.prepare("UPDATE cloud_permissions SET status='finished' WHERE id=? AND task_id=? AND owner_id=? AND status='consumed'").run(request.body.permissionId, worker.taskId, worker.id);
    return { ok: true };
  });
  app.get('/api/v1/cloud/audit', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    return { entries: store.db.prepare('SELECT action,detail,created_at AS createdAt FROM cloud_audit WHERE owner_id=? ORDER BY id DESC LIMIT 100').all(user.id) };
  });
  app.get('/api/v1/cloud/passkeys', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    return { passkeys: store.db.prepare('SELECT id,created_at AS createdAt FROM passkey_credentials WHERE user_id=? ORDER BY created_at').all(user.id) };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/cloud/passkeys/:id', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    store.db.prepare('DELETE FROM passkey_credentials WHERE id=? AND user_id=?').run(request.params.id, user.id);
    configuration.audit(user.id, 'passkey.removed', { id: request.params.id });
    return { removed: true };
  });
  return runner;
}
