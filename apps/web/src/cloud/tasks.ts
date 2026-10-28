import { cloudRequest } from './state';
import { flushCloud } from './sync';
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
  try {
    if (signal?.aborted) cancel();
    for (;;) {
      signal?.throwIfAborted();
      if (task.progress) onProgress?.(task.progress);
      if (task.status === 'completed') { await flushCloud(); return task.result as T; }
      if (['failed', 'cancelled', 'interrupted'].includes(task.status)) throw new Error(task.error || `任务${task.status}`);
      await new Promise(resolve => setTimeout(resolve, 750));
      task = await cloudRequest(`/tasks/${task.id}`);
    }
  } finally { signal?.removeEventListener('abort', cancel); }
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
