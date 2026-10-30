import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SystemMaterials } from './system-materials.js';
import type { CloudConfiguration } from '../cloud/config.js';
import { workerIdentity } from '../cloud/tasks.js';
import { workerTokenHash } from '../cloud/workerAuth.js';
import { MCP_PATH, systemSaveArguments } from '@wangke/contracts/system';

export function registerSystemRoutes(app: FastifyInstance, files: SystemMaterials, configuration: CloudConfiguration,
  auth: (r: FastifyRequest, p: FastifyReply) => { id: string } | null,
  origin: (r: FastifyRequest, p: FastifyReply) => boolean) {
  const safe = (p: FastifyReply, action: () => unknown) => {
    try { return action(); } catch (e) {
      const code = e instanceof Error && /^[a-z_]{1,80}$/.test(e.message) ? e.message : 'system_file_failed';
      return p.code(code.includes('conflict') || code === 'system_file_changed' ? 409 : code.endsWith('not_found') ? 404 : 400).send({ error: code });
    }
  };
  app.get<{ Querystring: { path: string; offset?: string; query?: string } }>('/api/v1/system/files', async (r, p) => {
    const u = auth(r, p); if (!u) return;
    return safe(p, () => files.list(u.id, r.query.path, Number(r.query.offset ?? 0), r.query.query ?? ''));
  });
  app.get<{ Querystring: { path: string } }>('/api/v1/system/file', async (r, p) => {
    const u = auth(r, p); if (!u) return;
    return safe(p, () => files.read(u.id, r.query.path));
  });
  app.post<{ Body: { path: string; content: string; expected: string; revision: number; permissionId?: string } }>('/api/v1/system/file', async (r, p) => {
    if (!origin(r, p)) return;
    const u = auth(r, p); if (!u) return;
    const worker = workerIdentity(r);
    // Browser learning jobs cannot reconfigure the owner's global connectors.
    // The main Bot uses notebook edit with an exact, human-approved run step.
    if (worker && r.body?.path === MCP_PATH) return p.code(403).send({ error: 'mcp_context_denied' });
    if (worker) {
      const task = files.store.db.prepare('SELECT worker_id,lease_expires_at FROM cloud_tasks WHERE id=? AND owner_id=?').get(worker.taskId, u.id) as { worker_id: string | null; lease_expires_at: string | null } | undefined;
      if (!task || task.worker_id !== workerTokenHash(r.headers.authorization?.slice(7) ?? '') || !(Date.parse(task.lease_expires_at ?? '') > Date.now())) return p.code(409).send({ error: 'worker_lease_expired' });
      if (configuration.taskPolicy(u.id, worker.taskId).write === 'deny') return p.code(403).send({ error: 'system_write_denied' });
      const permit = files.store.db.prepare("SELECT arguments FROM cloud_permissions WHERE id=? AND owner_id=? AND task_id=? AND capability='write' AND status='consumed'").get(r.body?.permissionId ?? '', u.id, worker.taskId) as { arguments: string } | undefined;
      if (!permit || permit.arguments !== JSON.stringify(systemSaveArguments(r.body?.path, r.body?.content, r.body?.expected, r.body?.revision))) return p.code(403).send({ error: 'system_write_permission_required' });
    }
    return safe(p, () => {
      const result = files.save(u.id, r.body?.path, r.body?.content, r.body?.expected, r.body?.revision);
      if (worker) files.store.db.prepare("UPDATE cloud_permissions SET status='finished' WHERE id=? AND status='consumed'").run(r.body.permissionId);
      return result;
    });
  });
}
