import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfiguration } from '../cloud/config.js';
import type { BotRunner } from './runner.js';
import { DEFAULT_MEMORY_JOB, ensureMemoryJob, type MemoryWorker } from './memory-worker.js';
import { BotMemory, type MemoryInput } from './memory.js';
import { BotArtifacts } from './artifacts.js';
import { BotSkills } from './skills.js';
import { UsageLedger, validateBudget, type BotBudget } from './budget.js';

export function registerBotManagement(app: FastifyInstance, store: DatabaseStore, configuration: CloudConfiguration, runner: BotRunner, worker: MemoryWorker, auth: (r: FastifyRequest, p: FastifyReply) => { id: string } | null, origin: (r: FastifyRequest, p: FastifyReply) => boolean) {
  const write = (r: FastifyRequest, p: FastifyReply) => origin(r, p) ? auth(r, p) : null;
  const safe = (p: FastifyReply, action: () => unknown) => { try { return action(); } catch (error) { return p.code(400).send({ error: error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'bot_operation_failed' }); } };
  const memory = new BotMemory(store);
  const ownsRun = (owner: string, id: string) => Boolean(store.db.prepare('SELECT 1 FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=?').get(id, owner));
  app.get<{ Querystring: { offset?: string } }>('/api/v1/bot/manage', async (r, p) => {
    const u = auth(r, p); if (!u) return;
    const offset = Math.max(0, Number(r.query.offset) || 0);
    return {
      budget: new UsageLedger(store, configuration).limits(u.id), timezone: 'UTC',
      memoryJob: { ...ensureMemoryJob(store, u.id), cursor: (store.db.prepare('SELECT cursor FROM bot_memory_jobs WHERE owner_id=?').get(u.id) as { cursor: string | null }).cursor },
      runs: store.db.prepare('SELECT r.id,r.thread_id AS threadId,t.title,r.status,r.error_code AS errorCode,r.step_count AS steps,r.active_ms AS activeMs,r.created_at AS createdAt FROM runs r JOIN threads t ON t.id=r.thread_id WHERE t.owner_id=? AND r.mode=? ORDER BY r.created_at DESC LIMIT 50 OFFSET ?').all(u.id, 'bot', offset),
      usage: store.db.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(input_tokens+output_tokens),0) AS knownTokens,
        COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,
        COUNT(cache_tokens) AS cacheMeasuredRequests,COALESCE(SUM(cache_tokens),0) AS cacheReadTokens,
        COALESCE(SUM(cache_creation_tokens),0) AS cacheWriteTokens,
        COALESCE(SUM(CASE WHEN cache_tokens IS NOT NULL THEN input_tokens ELSE 0 END),0) AS cacheMeasuredInputTokens,
        1.0*SUM(cache_tokens)/NULLIF(SUM(CASE WHEN cache_tokens IS NOT NULL THEN input_tokens ELSE 0 END),0) AS cacheHitRate,
        COALESCE(SUM(CASE WHEN input_tokens IS NULL THEN reserved_tokens ELSE 0 END),0) AS unknownReservedTokens,
        SUM(cost) AS knownCost,COALESCE(SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END),0) AS unknownCostRequests
        FROM bot_requests WHERE owner_id=? AND started_at>=?`).get(u.id, new Date().toISOString().slice(0, 10)),
      cacheByModel: store.db.prepare(`SELECT provider,model,COUNT(*) AS requests,COUNT(cache_tokens) AS measuredRequests,
        SUM(cache_tokens) AS cacheReadTokens,SUM(cache_creation_tokens) AS cacheWriteTokens,
        SUM(CASE WHEN cache_tokens IS NOT NULL THEN input_tokens ELSE 0 END) AS measuredInputTokens,
        1.0*SUM(cache_tokens)/NULLIF(SUM(CASE WHEN cache_tokens IS NOT NULL THEN input_tokens ELSE 0 END),0) AS hitRate
        FROM bot_requests WHERE owner_id=? AND started_at>=? GROUP BY provider,model`).all(u.id, new Date().toISOString().slice(0, 10)),
    };
  });
  app.post<{ Body: BotBudget }>('/api/v1/bot/budget', async (r, p) => { const u = write(r, p); if (!u) return; return safe(p, () => configuration.save(u.id, { ...configuration.get(u.id, true), botBudget: validateBudget(r.body) })); });
  app.get<{ Params: { id: string }; Querystring: { offset?: string } }>('/api/v1/bot/runs/:id', async (r, p) => {
    const u = auth(r, p); if (!u) return; if (!ownsRun(u.id, r.params.id)) return p.code(404).send({ error: 'run_not_found' });
    const offset = Math.max(0, Number(r.query.offset) || 0);
    return {
      budget: new UsageLedger(store, configuration).limits(u.id, r.params.id),
      requests: store.db.prepare('SELECT * FROM bot_requests WHERE run_id=? ORDER BY started_at LIMIT 50 OFFSET ?').all(r.params.id, offset),
      steps: store.db.prepare('SELECT id,tool,status,created_at,completed_at,substr(result,1,2000) AS preview FROM run_steps WHERE run_id=? ORDER BY created_at LIMIT 50 OFFSET ?').all(r.params.id, offset),
      summaries: store.db.prepare('SELECT id,source_start,source_end,version,model,content,created_at FROM bot_summaries WHERE run_id=? ORDER BY created_at DESC LIMIT 10').all(r.params.id),
      artifacts: store.db.prepare('SELECT id,size_bytes,created_at FROM bot_artifacts WHERE run_id=? AND owner_id=? ORDER BY created_at LIMIT 50 OFFSET ?').all(r.params.id, u.id, offset),
    };
  });
  app.post<{ Params: { id: string }; Body: { budget?: BotBudget } }>('/api/v1/bot/runs/:id/resume', async (r, p) => { const u = write(r, p); if (!u) return; if (!ownsRun(u.id, r.params.id)) return p.code(404).send({ error: 'run_not_found' }); return safe(p, () => {
    const budget = r.body?.budget ? validateBudget(r.body.budget) : null;
    const updated = store.db.prepare("UPDATE runs SET status='queued',error_code=NULL,budget_json=? WHERE id=? AND status='paused'").run(budget ? JSON.stringify(budget) : null, r.params.id);
    if (!updated.changes) throw new Error('run_not_paused'); runner.enqueue(r.params.id); return { queued: true };
  }); });
  app.get<{ Params: { id: string }; Querystring: { offset?: string } }>('/api/v1/bot/artifacts/:id', async (r, p) => { const u = auth(r, p); if (!u) return; return safe(p, () => new BotArtifacts(store).read(u.id, r.params.id, Number(r.query.offset) || 0)); });
  app.get<{ Querystring: { query?: string; offset?: string; deleted?: string } }>('/api/v1/bot/memories', async (r, p) => { const u = auth(r, p); if (!u) return; return { memories: memory.list(u.id, r.query.query ?? '', Number(r.query.offset) || 0, r.query.deleted === 'true') }; });
  app.post<{ Body: MemoryInput & { id?: string; revision?: number; path?: string } }>('/api/v1/bot/memories', async (r, p) => { const u = write(r, p); if (!u) return; return safe(p, () => memory.save(u.id, r.body, { id: r.body.id, revision: r.body.revision, path: r.body.path })); });
  app.post<{ Params: { id: string }; Body: { revision: number } }>('/api/v1/bot/memories/:id/delete', async (r, p) => { const u = write(r, p); if (!u) return; return safe(p, () => memory.remove(u.id, r.params.id, r.body.revision)); });
  app.get<{ Params: { id: string }; Querystring: { offset?: string } }>('/api/v1/bot/memories/:id/versions', async (r, p) => { const u = auth(r, p); if (!u) return; return safe(p, () => ({ versions: memory.versions(u.id, r.params.id, Number(r.query.offset) || 0) })); });
  app.post<{ Params: { id: string }; Body: { revision: number; expected: number } }>('/api/v1/bot/memories/:id/restore', async (r, p) => { const u = write(r, p); if (!u) return; return safe(p, () => memory.restore(u.id, r.params.id, r.body.revision, r.body.expected)); });
  app.post<{ Body: { enabled: boolean; tokenBudget?: number; intervalSeconds?: number } }>('/api/v1/bot/memory-job', async (r, p) => { const u = write(r, p); if (!u) return; return safe(p, () => {
    const v = r.body;
    if (typeof v.enabled !== 'boolean' || v.tokenBudget !== undefined && (!Number.isSafeInteger(v.tokenBudget) || v.tokenBudget < 100 || v.tokenBudget > 100000) || v.intervalSeconds !== undefined && (!Number.isSafeInteger(v.intervalSeconds) || v.intervalSeconds < 60 || v.intervalSeconds > 31536000)) throw new Error('invalid_memory_job');
    const current = ensureMemoryJob(store, u.id);
    store.db.prepare('UPDATE bot_memory_jobs SET enabled=?,token_budget=?,interval_seconds=? WHERE owner_id=?').run(Number(v.enabled), v.tokenBudget ?? current.tokenBudget ?? DEFAULT_MEMORY_JOB.tokenBudget, v.intervalSeconds ?? current.intervalSeconds ?? DEFAULT_MEMORY_JOB.intervalSeconds, u.id);
    if (!v.enabled) worker.cancel(u.id); return { saved: true };
  }); });
  app.get<{ Params: { id: string } }>('/api/v1/bot/threads/:id/skills', async (r, p) => { const u = auth(r, p); if (!u) return; return safe(p, () => ({ skills: new BotSkills(store).catalog(u.id, r.params.id), scope: (store.db.prepare('SELECT skill_ids FROM threads WHERE id=? AND owner_id=?').get(r.params.id, u.id) as { skill_ids: string | null }).skill_ids })); });
  app.post<{ Params: { id: string }; Body: { ids: number[] | null } }>('/api/v1/bot/threads/:id/skills', async (r, p) => { const u = write(r, p); if (!u) return; return safe(p, () => {
    const ids = r.body.ids;
    if (ids !== null && (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !Number.isSafeInteger(id)))) throw new Error('invalid_skill_scope');
    if (!store.db.prepare('UPDATE threads SET skill_ids=? WHERE id=? AND owner_id=?').run(ids === null ? null : JSON.stringify(ids), r.params.id, u.id).changes) throw new Error('thread_not_found');
    return { saved: true };
  }); });
}
