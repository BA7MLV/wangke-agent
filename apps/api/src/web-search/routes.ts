import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudRecords } from '../cloud/records.js';
import type { CloudConfiguration } from '../cloud/config.js';
import { workerIdentity } from '../cloud/workerAuth.js';
import type { WebSearchConfig } from '@wangke/contracts/web-search';
import { WebSearchError } from './config.js';
import { WebSearchService, webError } from './service.js';

export function registerWebSearchRoutes(app: FastifyInstance, deps: {
  service: WebSearchService; store: DatabaseStore; records: CloudRecords; configuration: CloudConfiguration;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => any;
  checkOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean;
}) {
  const { service, store, records, configuration } = deps;
  const authorize = (request: FastifyRequest, reply: FastifyReply, admin = false) => {
    if (request.method !== 'GET' && !deps.checkOrigin(request, reply)) return null;
    const user = deps.requireAuth(request, reply);
    if (user && admin && workerIdentity(request)) { reply.code(403).send({ error: 'worker_scope_denied' }); return null; }
    reply.header('cache-control', 'no-store'); return user;
  };
  const scope = (owner: string, sessionId: unknown, request: FastifyRequest) => {
    if (!Number.isSafeInteger(sessionId) || !records.get(owner, 'chatSessions', sessionId as number)) throw new WebSearchError('web_context_denied', 403);
    const worker = workerIdentity(request);
    if (worker) {
      const task = store.db.prepare("SELECT input,parent_run_id FROM cloud_tasks WHERE id=? AND owner_id=? AND kind IN ('chat','qa') AND status IN ('running','waiting_user')").get(worker.taskId, owner) as { input: string; parent_run_id: string | null } | undefined;
      if (!task || JSON.parse(task.input).sessionId !== sessionId) throw new WebSearchError('web_context_denied', 403);
      if (task.parent_run_id) {
        const parent = store.db.prepare('SELECT r.status,t.project_id FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=?').get(task.parent_run_id, owner) as { status: string; project_id: string | null } | undefined;
        if (!parent || ['cancelled', 'failed', 'paused'].includes(parent.status)) throw new WebSearchError('web_context_denied', 403);
        if (parent.project_id) {
          const project = store.db.prepare('SELECT network_policy,archived FROM projects WHERE id=? AND owner_id=?').get(parent.project_id, owner) as { network_policy: string; archived: number } | undefined;
          if (!project || project.archived || project.network_policy !== 'allow') return false;
        }
      }
    }
    const policy = worker ? configuration.taskPolicy(owner, worker.taskId) : configuration.get(owner).policy;
    return policy.network === 'allow';
  };
  const fail = (reply: FastifyReply, error: unknown) => { const e = webError(error); return reply.code(e.status >= 400 && e.status <= 599 ? e.status : 502).send({ error: e.code }); };
  app.get('/api/v1/cloud/web-search/config', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    return service.configuration.get(user.id);
  });
  app.put<{ Body: WebSearchConfig }>('/api/v1/cloud/web-search/config', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return service.configuration.save(user.id, request.body); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { sessionId: number } }>('/api/v1/cloud/web-search/catalog', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    try { return { tools: service.definitions(user.id, scope(user.id, request.body?.sessionId, request)) }; } catch (e) { return fail(reply, e); }
  });
  for (const test of [false, true]) app.post<{ Body: { sessionId?: number; name: string; arguments: Record<string, unknown> } }>(`/api/v1/cloud/web-search/${test ? 'test' : 'call'}`, async (request, reply) => {
    const user = authorize(request, reply, test); if (!user) return;
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', abort);
    try {
      const permitted = () => test ? configuration.get(user.id).policy.network === 'allow' : scope(user.id, request.body?.sessionId, request);
      const result = await service.call(user.id, test ? 'websearch' : request.body?.name, request.body?.arguments, controller.signal, permitted);
      return result;
    } catch (e) { return fail(reply, e); }
    finally { reply.raw.off('close', abort); }
  });
}
