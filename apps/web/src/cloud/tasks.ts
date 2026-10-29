import { cloudRequest } from './state';
import { flushCloud } from './sync';
import { db } from '../store/db';
import { messageWidgets } from '../harness/widgetLayout';
import type { WidgetPayload } from '../harness/widgetRuntime';
import type { CloudTask, CloudTaskKind } from '@wangke/contracts/cloud';

export async function submitCloudTask(kind: CloudTaskKind, resource: string, input: Record<string, unknown>): Promise<CloudTask> {
  await flushCloud();
  const nonce = crypto.randomUUID();
  return cloudRequest('/tasks', { method: 'POST', body: JSON.stringify({ nonce, kind, resource, input }) });
}
export async function runCloudTask<T>(kind: CloudTaskKind, resource: string, input: Record<string, unknown>, onProgress?: (p: any) => void, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let task = await submitCloudTask(kind, resource, input);
  const cancel = () => { void cloudRequest(`/tasks/${task.id}/cancel`, { method: 'POST' }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  let awaitingOwnerSince = 0;
  try {
    if (signal?.aborted) cancel();
    for (;;) {
      signal?.throwIfAborted();
      const ready = await syncTaskWidgets(task.progress);
      if (task.progress && ready) onProgress?.(task.progress);
      if (task.status === 'completed') {
        if (ready) { await flushCloud(); return task.result as T; }
        awaitingOwnerSince ||= Date.now();
        if (Date.now() - awaitingOwnerSince > 15_000) throw new Error('作品消息尚未同步到本机，请刷新后重试预览');
      }
      if (['failed', 'cancelled', 'interrupted'].includes(task.status)) throw new Error(task.error || `任务${task.status}`);
      await new Promise(resolve => setTimeout(resolve, 750));
      task = await cloudRequest(`/tasks/${task.id}`);
    }
  } finally { signal?.removeEventListener('abort', cancel); }
}

/** A server receipt is durable remotely, but an iframe's owner must also exist
 * in this browser's cache before its state/session bridge can be opened. */
export async function syncTaskWidgets(progress: CloudTask['progress']): Promise<boolean> {
  const widgets = progress?.widgets as WidgetPayload[] | undefined;
  const rowId = progress?.rowId;
  if (!Array.isArray(widgets) || !widgets.length) return true;
  if (typeof rowId !== 'number') return false;
  const matches = async () => {
    const row = await db.chats.get(rowId);
    const cached = row ? messageWidgets(row) : [];
    return widgets.every(widget => cached.some(item => item.id === widget.id && item.html === widget.html));
  };
  if (await matches()) return true;
  await flushCloud();
  return matches();
}
export async function cancelResourceTasks(resource: string) {
  const { tasks } = await cloudRequest<{ tasks: CloudTask[] }>('/tasks');
  await Promise.all(tasks.filter(t => t.resource === resource && ['queued','running','waiting_user'].includes(t.status)).map(t => cloudRequest(`/tasks/${t.id}/cancel`, { method: 'POST' })));
}
export async function commandChatTask(sessionId: number | null, action: string, value?: unknown): Promise<boolean> {
  const { tasks } = await cloudRequest<{ tasks: CloudTask[] }>('/tasks');
  const task = tasks.find(t => t.resource === `session:${sessionId}` && ['running','waiting_user'].includes(t.status));
  if (!task) return false;
  await cloudRequest(`/tasks/${task.id}/commands`, { method: 'POST', body: JSON.stringify({ action, value, nonce: crypto.randomUUID() }) });
  return true;
}
