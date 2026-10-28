import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { GatewayCore } from './core.js';

export function registerGatewayRoutes(app: FastifyInstance, gateway: GatewayCore, auth: (r: FastifyRequest, p: FastifyReply) => { id: string } | null, origin: (r: FastifyRequest, p: FastifyReply) => boolean) {
  app.get('/api/v1/gateway', async (r, p) => {
    const user = auth(r, p); if (!user) return;
    return { accounts: gateway.list(user.id), channels: Object.values(gateway.factories).map(factory => factory().manifest),
      deliveries: gateway.store.db.prepare(`SELECT o.id,o.seq,o.status,o.attempts,o.error,o.created_at AS createdAt,b.thread_id AS threadId,a.channel,a.id AS accountId FROM gateway_outbox o JOIN gateway_bindings b ON b.id=o.binding_id JOIN gateway_accounts a ON a.id=b.account_id WHERE a.owner_id=? ORDER BY o.seq DESC LIMIT 100`).all(user.id),
      inboxFailures: gateway.store.db.prepare("SELECT i.id,i.error,a.channel FROM gateway_inbox i JOIN gateway_accounts a ON a.id=i.account_id WHERE a.owner_id=? AND i.status='failed' ORDER BY i.id DESC LIMIT 50").all(user.id),
      projectionFailures: gateway.store.db.prepare('SELECT f.event_id AS eventId,f.error,b.thread_id AS threadId,a.channel FROM gateway_projection_failures f JOIN gateway_bindings b ON b.id=f.binding_id JOIN gateway_accounts a ON a.id=b.account_id WHERE a.owner_id=? LIMIT 50').all(user.id),
      reminders: gateway.store.db.prepare('SELECT id,thread_id AS threadId,text,timezone,next_at AS nextAt,interval_seconds AS intervalSeconds,status FROM bot_reminders WHERE owner_id=? ORDER BY next_at LIMIT 200').all(user.id),
    };
  });
  const write = (r: FastifyRequest, p: FastifyReply) => origin(r, p) ? auth(r, p) : null;
  const safe = async (p: FastifyReply, action: () => unknown) => { try { return await action(); } catch (e) { return p.code(400).send({ error: e instanceof Error && /^[a-z_]{1,80}$/.test(e.message) ? e.message : 'gateway_operation_failed' }); } };
  app.post('/api/v1/gateway/accounts', async (r, p) => { const u = write(r, p); if (!u) return; return safe(p, () => gateway.save(u.id, r.body as any)); });
  app.delete<{ Params: { id: string } }>('/api/v1/gateway/accounts/:id', async (r, p) => { const u = write(r, p); if (!u) return; return safe(p, () => gateway.remove(u.id, r.params.id)); });
  app.post<{ Params: { id: string } }>('/api/v1/gateway/accounts/:id/pair', async (r, p) => { const u = write(r, p); if (!u) return; return safe(p, () => gateway.pair(u.id, r.params.id)); });
  app.post<{ Params: { id: string }; Body: { bindingId: string } }>('/api/v1/gateway/accounts/:id/revoke', async (r, p) => { const u = write(r, p); if (!u) return; return safe(p, () => { gateway.revoke(u.id, r.params.id, r.body.bindingId); return { revoked: true }; }); });
  app.post<{ Params: { id: string }; Body: Record<string, string> }>('/api/v1/gateway/accounts/:id/login', async (r, p) => {
    const u = write(r, p); if (!u) return;
    const controller = new AbortController();
    const abort = () => { if (!p.raw.writableEnded) controller.abort(); };
    r.raw.once('aborted', abort); p.raw.once('close', abort);
    try { return await safe(p, () => gateway.login(u.id, r.params.id, r.body, controller.signal)); }
    finally { r.raw.off('aborted', abort); p.raw.off('close', abort); }
  });
  app.post<{ Params: { id: string }; Body: { acknowledgeUncertain?: boolean } }>('/api/v1/gateway/deliveries/:id/retry', async (r, p) => { const u = write(r, p); if (!u) return; return safe(p, () => { gateway.retry(u.id, r.params.id, r.body?.acknowledgeUncertain === true); return { queued: true }; }); });
  app.post<{ Params: { id: string } }>('/api/v1/gateway/deliveries/:id/discard', async (r, p) => { const u = write(r, p); if (!u) return; return safe(p, () => { gateway.discard(u.id, r.params.id); return { cancelled: true }; }); });
  app.post<{ Params: { id: string } }>('/api/v1/gateway/reminders/:id/cancel', async (r, p) => { const u = write(r, p); if (!u) return; return { cancelled: gateway.store.db.prepare("UPDATE bot_reminders SET status='cancelled' WHERE id=? AND owner_id=? AND status='active'").run(r.params.id, u.id).changes === 1 }; });
}
