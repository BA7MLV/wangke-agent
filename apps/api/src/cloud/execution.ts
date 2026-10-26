import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CloudTask, CloudMutation } from '../../../../packages/contracts/src/cloud.js';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfiguration } from './config.js';
import type { CloudRecords } from './records.js';

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

/** Match getCourseFile: an edited copy wins over the original streaming upload. */
export function taskCourseFile(context: TaskContext, id: string): string | null {
  const edited = context.records.get(context.owner, 'files', id);
  if (edited) return taskFile(context, edited.blob);
  const original = context.records.get(context.owner, 'courseFiles', id);
  return original ? taskFile(context, { $file: original.fileId }) : null;
}
