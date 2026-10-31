import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CloudTask, CloudMutation } from '@wangke/contracts/cloud';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfiguration } from './config.js';
import type { CloudRecords } from './records.js';
import { ProjectError, ProjectFiles } from '../projects/files.js';
import type { WebSearchService } from '../web-search/service.js';

export type ExecutorKind = 'node' | 'media' | 'browser';
export interface TaskContext {
  task: CloudTask;
  owner: string;
  store: DatabaseStore;
  records: CloudRecords;
  configuration: CloudConfiguration;
  filesDir: string;
  signal: AbortSignal;
  fetch: typeof fetch;
  webSearch?: WebSearchService;
  checkActive(): void;
  report(progress: Record<string, unknown>): void;
}
export type TaskExecutor = (context: TaskContext) => Promise<unknown>;

/**
 * Model orchestration belongs to the API process.  Browser workers are only
 * used for capabilities that genuinely require browser APIs or a UI surface.
 */
const nodeKinds = new Set(['chat', 'qa', 'cards', 'comments', 'danmaku', 'modelOnce', 'artifactEdit', 'handoutEdit']);
/** Routing is explicit: a failed native job must never replay itself in a browser. */
export function executorFor(task: CloudTask, video: Record<string, any> | null): ExecutorKind {
  if (task.kind === 'handout' && task.input.botStudyText === true) return 'node';
  if (nodeKinds.has(task.kind)) return 'node';
  if (task.kind === 'material' && ['md', 'docx'].includes(String(task.input.format))) return 'node';
  // FFmpeg remains the bounded native fallback for video covers. Chromium is
  // gone from the image; browser workers handle the interactive media tasks.
  if (task.kind === 'cover' && video?.kind !== 'material') return 'media';
  return 'browser';
}

export function taskRows(context: TaskContext, table: string, field?: string, value?: unknown): Record<string, any>[] {
  const rows = context.store.db.prepare('SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND value IS NOT NULL')
    .all(context.owner, table) as Array<{ value: string }>;
  return rows.map(row => JSON.parse(row.value)).filter(row => !field || row[field] === value);
}

export function recordMutation(table: string, key: string | number, before: Record<string, any> | null, after: Record<string, any> | null): CloudMutation {
  return { id: crypto.randomUUID(), table, key, before, after };
}

export function commitTask(context: TaskContext, mutations: CloudMutation[]) {
  context.checkActive();
  const linked = context.store.db.prepare('SELECT parent_run_id FROM cloud_tasks WHERE id=? AND owner_id=?').get(context.task.id, context.owner) as any;
  if (linked?.parent_run_id) {
    const policy = context.configuration.taskPolicy(context.owner, context.task.id);
    if (policy.read !== 'allow' || policy.write !== 'allow') throw new Error('bot_child_write_permission_required');
  }
  if (mutations.length) context.records.apply(context.owner, mutations);
}

export function newRecordId() { return crypto.randomInt(1_000_000, 2 ** 48 - 1); }

/** Only resolve owned, server-indexed blobs, never a filename supplied in a task. */
export function taskFile(context: TaskContext, reference: unknown): string {
  const id = (reference as { $file?: unknown } | null)?.$file;
  if (typeof id !== 'string') throw new Error('文件引用不存在');
  const file = context.store.db.prepare('SELECT storage_name FROM files WHERE id=? AND owner_id=?').get(id, context.owner) as { storage_name: string } | undefined;
  if (!file) throw new Error('文件不存在');
  try {
    const root = fs.realpathSync(context.filesDir);
    const filename = fs.realpathSync(path.resolve(root, file.storage_name));
    if (!filename.startsWith(`${root}${path.sep}`)) throw new Error('文件路径无效');
    return filename;
  } catch { throw new Error('文件不可用'); }
}

/** Pin the authoritative file, including across parent renames/symlink swaps.
 * Callers close the descriptor; subprocesses inherit it rather than reopening
 * a mutable workspace path. Legacy blobs are only used for unmigrated courses. */
export function taskCourseFile(context: TaskContext, id: string) {
  const mapped = context.store.db.prepare('SELECT f.project_id,f.path FROM resource_files f JOIN projects p ON p.id=f.project_id AND p.owner_id=f.owner_id WHERE f.owner_id=? AND f.course_id=?')
    .get(context.owner, id) as { project_id: string; path: string } | undefined;
  let opened: { fd: number; size: number; revision: string };
  let files: ProjectFiles | undefined;
  if (mapped) {
    if (process.platform !== 'linux' && context.store.db.prepare('SELECT 1 FROM project_executions WHERE project_id=?').get(mapped.project_id)) throw new ProjectError('project_busy', 409);
    files = new ProjectFiles(path.join(context.filesDir, 'projects'));
    try { opened = files.open(mapped.project_id, mapped.path); }
    catch (error) { if (error instanceof ProjectError && error.status === 404) return null; throw error; }
  } else {
    const edited = context.records.get(context.owner, 'files', id);
    const original = context.records.get(context.owner, 'courseFiles', id);
    if (!edited && !original) return null;
    const filename = taskFile(context, edited ? edited.blob : { $file: original!.fileId });
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    opened = { fd, size: fs.fstatSync(fd).size, revision: '' };
  }
  let closed = false;
  return { fd: opened.fd, size: opened.size, filename: `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${opened.fd}`,
    assertCurrent() {
      if (!mapped || !files) return;
      const current = files.open(mapped.project_id, mapped.path);
      try { if (current.revision !== opened.revision) throw new ProjectError('project_file_conflict', 409); }
      finally { fs.closeSync(current.fd); }
    },
    close() { if (!closed) { closed = true; fs.closeSync(opened.fd); } },
  };
}
