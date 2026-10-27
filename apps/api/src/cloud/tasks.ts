import path from 'node:path';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudTask, CloudTaskKind } from '../../../../packages/contracts/src/cloud.js';
import { CloudConfiguration } from './config.js';
import { CloudRecords } from './records.js';
import { executeMediaTask } from './media.js';
import { executorFor, type TaskContext, type TaskExecutor } from './execution.js';
export { workerIdentity } from './workerAuth.js';

export const TASK_KINDS: CloudTaskKind[] = ['chat', 'qa', 'transcribe', 'handout', 'cards', 'comments', 'danmaku', 'material', 'cover', 'artifactEdit', 'handoutEdit', 'modelOnce'];
export function taskDto(row: any): CloudTask {
  return { id: row.id, kind: row.kind, resource: row.resource, status: row.status, input: JSON.parse(row.input),
    progress: row.progress ? JSON.parse(row.progress) : null, result: row.result ? JSON.parse(row.result) : null,
    error: row.error, createdAt: row.created_at, executor: row.executor ?? undefined };
}

let nativeRuntime: Promise<{ executeNodeTask: TaskExecutor }> | undefined;
const executeNodeTask: TaskExecutor = async context => {
  const runtime = new URL(import.meta.url.endsWith('.ts')
    ? '../../../../dist-api/apps/api/runtime/node.mjs' : '../../runtime/node.mjs', import.meta.url);
  nativeRuntime ??= import(runtime.href);
  return (await nativeRuntime!).executeNodeTask(context);
};

interface RunnerOptions {
  records?: CloudRecords;
  configuration?: CloudConfiguration;
  filesDir?: string;
  fetch?: typeof fetch;
  /** Dependency injection for scheduler tests; never accepted over HTTP. */
  executors?: Partial<Record<'node' | 'media' | 'browser', TaskExecutor>>;
}

/** Single-instance durable scheduler; execution backends do not own queue state. */
export class CloudTaskRunner {
  private stopped = false;
  private active = new Map<string, AbortController>();
  private draining = false;
  private resetting = false;
  private timer?: ReturnType<typeof setInterval>;
  private running = new Map<string, Promise<void>>();
  private readonly records: CloudRecords;
  constructor(private store: DatabaseStore, private options: RunnerOptions = {}) {
    this.records = options.records ?? new CloudRecords(store);
  }

  start(origin: string) {
    this.store.db.prepare("UPDATE cloud_tasks SET status=CASE WHEN executor='browser' THEN 'queued' ELSE 'interrupted' END,worker_id=NULL,lease_expires_at=NULL,error=CASE WHEN executor='browser' THEN NULL ELSE '服务器重启，任务已中断，可重试' END WHERE status IN ('running','waiting_user')").run();
    this.store.db.prepare("UPDATE cloud_permissions SET status='expired' WHERE status IN ('pending','approved','consumed') AND task_id IN (SELECT id FROM cloud_tasks WHERE status NOT IN ('running','waiting_user'))").run();
    this.timer = setInterval(() => void this.drain(origin), 1000);
    this.timer.unref();
    void this.drain(origin);
  }
  async cancel(id: string) { this.active.get(id)?.abort(); await this.running.get(id); }
  async reset() {
    this.resetting = true;
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled(this.running.values());
    this.resetting = false;
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled(this.running.values());
  }
  private async drain(origin: string) {
    if (this.stopped || this.resetting || this.draining) return;
    this.draining = true;
    try {
      this.store.db.prepare("UPDATE cloud_tasks SET status='queued',worker_id=NULL,lease_expires_at=NULL,updated_at=? WHERE executor='browser' AND status IN ('running','waiting_user') AND lease_expires_at IS NOT NULL AND lease_expires_at<=?")
        .run(new Date().toISOString(), new Date().toISOString());
      const limit = Math.max(1, Math.min(4, Number(process.env.CLOUD_CONCURRENCY) || 2));
      const rows = this.store.db.prepare("SELECT * FROM cloud_tasks WHERE status='queued' ORDER BY created_at LIMIT 50").all() as any[];
      for (const row of rows) {
        const task = taskDto(row);
        const video = typeof task.input.videoId === 'string' ? this.records.get(row.owner_id, 'videos', task.input.videoId) : null;
        const selected = executorFor(task, video);
        if (selected === 'browser') {
          this.store.db.prepare("UPDATE cloud_tasks SET executor='browser',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(), row.id);
          continue;
        }
        const computing = this.store.db.prepare("SELECT COUNT(*) AS count FROM cloud_tasks WHERE status='running'").get() as { count: number };
        if (computing.count >= limit || this.active.size >= 8) break;
        const busy = this.store.db.prepare("SELECT 1 FROM cloud_tasks WHERE owner_id=? AND resource=? AND status IN ('running','waiting_user') AND id!=?").get(row.owner_id, row.resource, row.id);
        if (busy) continue;
        const claim = this.store.db.prepare("UPDATE cloud_tasks SET status='running',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(), row.id);
        if (!claim.changes) continue;
        const controller = new AbortController();
        this.active.set(row.id, controller);
        const promise = this.execute(origin, row, controller.signal).finally(() => { this.active.delete(row.id); this.running.delete(row.id); });
        this.running.set(row.id, promise);
      }
    } finally { this.draining = false; }
  }
  private async execute(origin: string, row: any, signal: AbortSignal) {
    try {
      const task = taskDto(row);
      task.status = 'running';
      const video = typeof task.input.videoId === 'string' ? this.records.get(row.owner_id, 'videos', task.input.videoId) : null;
      const executor = executorFor(task, video);
      this.store.db.prepare('UPDATE cloud_tasks SET executor=? WHERE id=?').run(executor, row.id);
      task.executor = executor;
      const checkActive = () => {
        signal.throwIfAborted();
        if (this.stopped || (this.store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(row.id) as { status: string } | undefined)?.status !== 'running') {
          throw new DOMException('任务已停止', 'AbortError');
        }
      };
      const directory = process.env.DATA_DIR ?? path.resolve('data');
      const context: TaskContext = {
        task, owner: row.owner_id, store: this.store, records: this.records,
        configuration: this.options.configuration ?? new CloudConfiguration(this.store, path.join(directory, 'config')),
        filesDir: this.options.filesDir ?? process.env.FILES_DIR ?? path.join(directory, 'files'),
        signal, fetch: this.options.fetch ?? fetch, checkActive,
        report: progress => {
          checkActive();
          this.store.db.prepare("UPDATE cloud_tasks SET progress=?,updated_at=? WHERE id=? AND status='running'")
            .run(JSON.stringify(progress), new Date().toISOString(), row.id);
        },
      };
      if (executor === 'browser') throw new Error('browser_task_requires_external_worker');
      const execute = this.options.executors?.[executor] ?? (executor === 'node' ? executeNodeTask : executeMediaTask);
      const result = await execute(context);
      signal.throwIfAborted();
      this.store.db.prepare("UPDATE cloud_tasks SET status='completed',result=?,error=NULL,updated_at=? WHERE id=? AND status IN ('running','waiting_user')")
        .run(JSON.stringify(result ?? null), new Date().toISOString(), row.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : '执行器运行失败';
      this.store.db.prepare("UPDATE cloud_tasks SET status=?,error=?,updated_at=? WHERE id=? AND status IN ('running','waiting_user')")
        .run(this.stopped ? 'interrupted' : signal.aborted ? 'cancelled' : 'failed', message.slice(0, 1000), new Date().toISOString(), row.id);
    } finally {
      this.store.db.prepare("UPDATE cloud_permissions SET status='expired' WHERE task_id=? AND status IN ('pending','approved','consumed')").run(row.id);
    }
  }
}
