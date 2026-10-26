import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudRecords } from '../cloud/records.js';
import { workerIdentity } from '../cloud/workerAuth.js';
import type { McpContext, McpServerInput } from '../../../../packages/contracts/src/mcp.js';
import { McpManager, mcpError } from './manager.js';

export function registerMcpRoutes(app: FastifyInstance, deps: {
  manager: McpManager; store: DatabaseStore; records: CloudRecords;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => any;
  checkOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean;
}) {
  const { manager, store, records } = deps;
  const authorize = (request: FastifyRequest, reply: FastifyReply, admin = false) => {
    if (!['GET', 'HEAD'].includes(request.method) && !deps.checkOrigin(request, reply)) return null;
    const user = deps.requireAuth(request, reply);
    if (user && admin && workerIdentity(request)) { reply.code(403).send({ error: 'worker_scope_denied' }); return null; }
    reply.header('cache-control', 'no-store');
    return user;
  };
  const scope = (owner: string, context: McpContext, request: FastifyRequest): string[] | undefined => {
    if (!context || (context.sessionId !== undefined) === (context.threadId !== undefined)) throw new Error('mcp_invalid_context');
    const worker = workerIdentity(request);
    if (worker) {
      const task = store.db.prepare("SELECT input FROM cloud_tasks WHERE id=? AND owner_id=? AND kind IN ('chat','qa') AND status IN ('running','waiting_user')").get(worker.taskId, owner) as { input: string } | undefined;
      if (!task || JSON.parse(task.input).sessionId !== context.sessionId || context.threadId) throw new Error('mcp_context_denied');
    }
    let ids: unknown;
    if (context.sessionId !== undefined) {
      if (!Number.isSafeInteger(context.sessionId)) throw new Error('mcp_invalid_context');
      const session = records.get(owner, 'chatSessions', context.sessionId);
      if (!session) throw new Error('mcp_context_denied');
      ids = session.mcpServerIds;
    } else {
      if (typeof context.threadId !== 'string') throw new Error('mcp_invalid_context');
      const thread = store.db.prepare('SELECT mcp_server_ids,project_id FROM threads WHERE id=? AND owner_id=?').get(context.threadId, owner) as { mcp_server_ids: string | null; project_id: string | null } | undefined;
      if (!thread) throw new Error('mcp_context_denied');
      // Existing connectors are owner-scoped, not project-scoped. A project
      // cannot widen its boundary through a global external connector.
      if (thread.project_id) return [];
      ids = thread.mcp_server_ids === null ? undefined : JSON.parse(thread.mcp_server_ids);
    }
    if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) throw new Error('mcp_invalid_scope');
    return ids as string[] | undefined;
  };
  const fail = (reply: FastifyReply, error: unknown) => reply.code(400).send({ error: mcpError(error) });
  app.post<{ Body: unknown }>('/api/v1/cloud/mcp/import/preview', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return { servers: manager.repository.previewImport(user.id, request.body) }; } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: unknown }>('/api/v1/cloud/mcp/import', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return { servers: manager.repository.import(user.id, request.body) }; } catch (e) { return fail(reply, e); }
  });
  app.get<{ Params: { id: string } }>('/api/v1/cloud/mcp/:id/log', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return { text: manager.log(user.id, request.params.id) }; } catch (e) { return fail(reply, e); }
  });
  app.post<{ Params: { id: string } }>('/api/v1/cloud/mcp/:id/oauth/start', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try {
      const server = manager.repository.get(user.id, request.params.id);
      if (!server) throw new Error('mcp_not_found');
      const origin = process.env.MCP_PUBLIC_ORIGIN || process.env.PUBLIC_ORIGIN || (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(request.host) ? `${request.protocol}://${request.host}` : '');
      if (!origin || !['http:', 'https:'].includes(new URL(origin).protocol)) throw new Error('mcp_oauth_origin');
      await manager.invalidate(user.id, server.id);
      manager.repository.resetOAuth(user.id, server.id);
      return await manager.oauth(user.id, server.id, true).begin(server.url, new URL(`/api/v1/cloud/mcp/${server.id}/oauth/callback`, origin).href);
    } catch (e) { return fail(reply, e); }
  });
  app.get<{ Params: { id: string }; Querystring: { state?: string; code?: string; error?: string } }>('/api/v1/cloud/mcp/:id/oauth/callback', { logLevel: 'silent' }, async (request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    try {
      const owner = manager.repository.owner(request.params.id);
      if (!owner || !request.query.state) throw new Error('mcp_oauth_state');
      const server = manager.repository.get(owner, request.params.id)!;
      await manager.oauth(owner, server.id).complete(server.url, request.query.state, request.query.error ? undefined : request.query.code);
      await manager.invalidate(owner, server.id);
      return reply.type('text/plain; charset=utf-8').send('MCP 授权成功 / Authorization complete. 请关闭此页，返回设置刷新并测试连接。');
    } catch (e) { return reply.code(400).type('text/plain').send(mcpError(e)); }
  });
  app.post<{ Params: { id: string } }>('/api/v1/cloud/mcp/:id/oauth/disconnect', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { await manager.invalidate(user.id, request.params.id); return await manager.oauth(user.id, request.params.id).disconnect(); } catch (e) { return fail(reply, e); }
  });
  app.get('/api/v1/cloud/mcp', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    return { servers: manager.list(user.id) };
  });
  app.post<{ Body: McpServerInput }>('/api/v1/cloud/mcp', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return manager.repository.public(manager.repository.save(user.id, request.body)); } catch (e) { return fail(reply, e); }
  });
  app.put<{ Params: { id: string }; Body: McpServerInput }>('/api/v1/cloud/mcp/:id', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try {
      const server = manager.repository.save(user.id, request.body, request.params.id);
      await manager.invalidate(user.id, server.id);
      return manager.repository.public(server);
    } catch (e) { return fail(reply, e); }
  });
  app.delete<{ Params: { id: string } }>('/api/v1/cloud/mcp/:id', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { manager.repository.remove(user.id, request.params.id); await manager.invalidate(user.id, request.params.id); return { ok: true }; }
    catch (e) { return fail(reply, e); }
  });
  app.post<{ Params: { id: string } }>('/api/v1/cloud/mcp/:id/test', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return await manager.test(user.id, request.params.id); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: McpContext }>('/api/v1/cloud/mcp/catalog', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    try { return await manager.catalog(user.id, scope(user.id, request.body, request)); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: McpContext & { name: string; arguments: Record<string, unknown> } }>('/api/v1/cloud/mcp/call', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', abort);
    try {
      const b = request.body;
      const ids = scope(user.id, b, request);
      if (typeof b.name !== 'string' || !/^mcp_[a-f0-9]{48}$/.test(b.name) || !b.arguments || typeof b.arguments !== 'object' || Array.isArray(b.arguments) || JSON.stringify(b.arguments).length > 100000) throw new Error('mcp_invalid_arguments');
      return await manager.call(user.id, b.name, b.arguments, ids, controller.signal);
    } catch (e) { return fail(reply, e); }
    finally { reply.raw.off('close', abort); }
  });
  app.post<{ Body: McpContext }>('/api/v1/cloud/mcp/scope', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return { serverIds: scope(user.id, request.body, request) ?? null }; } catch (e) { return fail(reply, e); }
  });
  app.put<{ Body: McpContext & { serverIds: string[] | null } }>('/api/v1/cloud/mcp/scope', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try {
      scope(user.id, request.body, request);
      const { serverIds, threadId } = request.body;
      if (threadId && (store.db.prepare('SELECT project_id FROM threads WHERE id=? AND owner_id=?').get(threadId, user.id) as { project_id: string | null })?.project_id) throw new Error('mcp_context_denied');
      // Browser chat scopes live in the synchronized chatSession record. Bot threads use SQLite.
      if (!threadId || (serverIds !== null && (!Array.isArray(serverIds) || serverIds.length > 30 || serverIds.some(id => typeof id !== 'string' || !manager.repository.get(user.id, id))))) throw new Error('mcp_invalid_scope');
      store.db.prepare('UPDATE threads SET mcp_server_ids=? WHERE id=? AND owner_id=?').run(serverIds === null ? null : JSON.stringify(serverIds), threadId, user.id);
      return { serverIds };
    } catch (e) { return fail(reply, e); }
  });
}
