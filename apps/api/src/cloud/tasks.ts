import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudTask, CloudTaskKind } from '../../../../packages/contracts/src/cloud.js';

const workerTokens = new Map<string, { id: string; taskId: string }>();
export function workerIdentity(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  return authorization?.startsWith('Bearer ') ? workerTokens.get(authorization.slice(7)) : undefined;
}
export const TASK_KINDS: CloudTaskKind[] = ['chat', 'qa', 'transcribe', 'handout', 'cards', 'comments', 'danmaku', 'material', 'cover', 'artifactEdit', 'handoutEdit', 'modelOnce'];
export function taskDto(row: any): CloudTask {
  return { id: row.id, kind: row.kind, resource: row.resource, status: row.status, input: JSON.parse(row.input),
    progress: row.progress ? JSON.parse(row.progress) : null, result: row.result ? JSON.parse(row.result) : null,
    error: row.error, createdAt: row.created_at };
}

/** Tasks run in a server-owned browser, never in the user's tab. Browser engines supply
 * WebCodecs/Canvas/DOM required by the existing media and document pipelines. */
export class CloudTaskRunner {
  private stopped = false;
  private active = new Map<string, { close: () => Promise<void> }>();
  private draining = false;
  private timer?: ReturnType<typeof setInterval>;
  private running = new Set<Promise<void>>();
  constructor(private store: DatabaseStore) {}

  start(origin: string) {
    // Retain completed checkpoints, but require an explicit retry after process loss.
    this.store.db.prepare("UPDATE cloud_tasks SET status='interrupted',error='服务器重启，任务已中断，可重试' WHERE status IN ('running','waiting_user')").run();
    this.store.db.prepare("UPDATE cloud_permissions SET status='expired' WHERE status IN ('pending','approved','consumed') AND task_id IN (SELECT id FROM cloud_tasks WHERE status NOT IN ('running','waiting_user'))").run();
    this.timer = setInterval(() => void this.drain(origin), 1000);
    this.timer.unref();
    void this.drain(origin);
  }
  async cancel(id: string) { await this.active.get(id)?.close(); }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.active.values()].map(c => c.close()));
    await Promise.allSettled([...this.running]);
  }
  private async drain(origin: string) {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      const limit = Math.max(1, Math.min(4, Number(process.env.CLOUD_CONCURRENCY) || 2));
      const rows = this.store.db.prepare("SELECT * FROM cloud_tasks WHERE status='queued' ORDER BY created_at LIMIT 50").all() as any[];
      for (const row of rows) {
        const computing = this.store.db.prepare("SELECT COUNT(*) AS count FROM cloud_tasks WHERE status='running'").get() as { count: number };
        if (computing.count >= limit || this.active.size >= 8) break;
        const busy = this.store.db.prepare("SELECT 1 FROM cloud_tasks WHERE owner_id=? AND resource=? AND status IN ('running','waiting_user') AND id!=?").get(row.owner_id, row.resource, row.id);
        if (busy) continue;
        const claim = this.store.db.prepare("UPDATE cloud_tasks SET status='running',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(), row.id);
        if (!claim.changes) continue;
        this.active.set(row.id, { close: async () => {} });
        const promise = this.execute(origin, row).finally(() => { this.active.delete(row.id); this.running.delete(promise); });
        this.running.add(promise);
      }
    } finally { this.draining = false; }
  }
  private async execute(origin: string, row: any) {
    const token = crypto.randomBytes(32).toString('base64url');
    workerTokens.set(token, { id: row.owner_id, taskId: row.id });
    let context: any;
    let browser: any;
    try {
      const { chromium } = await import('playwright');
      // One browser per task prevents launch races and isolates crashes/cancellation.
      browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
      context = await browser.newContext({ serviceWorkers: 'block' });
      this.active.set(row.id, { close: () => browser.close() });
      const status = this.store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(row.id) as { status: string };
      if (this.stopped || status.status !== 'running') return;
      await context.route('**/*', async (route: any) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        return route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } });
      });
      const page = await context.newPage();
      await page.goto(`${origin}/?cloud-worker=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => typeof (window as any).__runCloudTask === 'function', undefined, { timeout: 120000 });
      const result = await page.evaluate(async (task: CloudTask) => (window as any).__runCloudTask(task), taskDto(row));
      this.store.db.prepare("UPDATE cloud_tasks SET status='completed',result=?,error=NULL,updated_at=? WHERE id=? AND status IN ('running','waiting_user')")
        .run(JSON.stringify(result ?? null), new Date().toISOString(), row.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : '执行器运行失败';
      this.store.db.prepare("UPDATE cloud_tasks SET status=?,error=?,updated_at=? WHERE id=? AND status IN ('running','waiting_user')")
        .run(this.stopped ? 'interrupted' : 'failed', message.slice(0, 1000), new Date().toISOString(), row.id);
    } finally {
      workerTokens.delete(token);
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      this.store.db.prepare("UPDATE cloud_permissions SET status='expired' WHERE task_id=? AND status IN ('pending','approved','consumed')").run(row.id);
    }
  }
}
