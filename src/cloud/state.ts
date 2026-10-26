/** No React/store imports: storage and API entrypoints can consult this without cycles. */
import { apiUrl } from '../api/base';
export const cloud = {
  enabled: false,
  userId: '',
  worker: false,
  taskId: '',
  workerToken: '' as string,
  permissionId: undefined as string | undefined,
  maxSteps: 100,
};
export const remoteTasks = () => cloud.enabled && !cloud.worker;

export async function cloudRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(`/api/v1/cloud${path}`), {
    credentials: 'include', ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(cloud.workerToken ? { authorization: `Bearer ${cloud.workerToken}` } : {}), ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !cloud.worker) window.dispatchEvent(new Event('cloud-session-expired'));
    throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status, detail: body });
  }
  return body as T;
}

export async function requestToolPermission(capability: 'read' | 'write' | 'remove' | 'shell', args: unknown) {
  if (!cloud.worker) return;
  let permissionId: string | undefined;
  for (;;) {
    const result = await cloudRequest<{ id?: string; status: string }>(`/tasks/${cloud.taskId}/authorize`, {
      method: 'POST', body: JSON.stringify({ capability, arguments: args, permissionId }),
    });
    if (result.status === 'approved') return result.id;
    if (result.status !== 'pending') throw new Error('该操作未获授权');
    permissionId = result.id;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

export async function withToolPermission<T>(capability: 'read' | 'write' | 'remove', args: unknown, execute: () => Promise<T>): Promise<T> {
  if (!cloud.worker) return execute();
  const id = await requestToolPermission(capability, args);
  const previous = cloud.permissionId;
  cloud.permissionId = id;
  try { return await execute(); }
  finally {
    // Commit all writes bearing this permit before closing it. A later tool invocation
    // needs a fresh approval, even when it happens to have the same arguments.
    try { await (await import('./sync')).flushCloud(); }
    finally {
      cloud.permissionId = previous;
      if (id) await cloudRequest(`/tasks/${cloud.taskId}/authorize/finish`, { method: 'POST', body: JSON.stringify({ permissionId: id }) });
    }
  }
}
