import { agentHttpInit } from './http.js';

export type SandboxRequest = { owner: string; threadId: string; projectId?: string; executionId: string; command: string; network?: boolean; timeoutSeconds?: number };
export function shellTimeoutSeconds(value?: number) {
  if (value === undefined) return 120;
  if (!Number.isInteger(value) || value < 1 || value > 600) throw new Error('invalid_shell_timeout');
  return value;
}
// Container deadline < broker watchdog (+10s) < HTTP deadline (+30s) < tool
// deadline (+40s), leaving room for Docker startup and confirmed cleanup.
export const shellToolTimeoutMs = (args: { timeoutSeconds?: number }) => shellTimeoutSeconds(args.timeoutSeconds) * 1000 + 40_000;
export type SandboxResult = { stdout: string; stderr: string; exitCode: number };
export type SandboxExecutor = (request: SandboxRequest, signal: AbortSignal) => Promise<SandboxResult>;
export type SandboxCleanup = (executionId: string) => Promise<void>;
export type SandboxFileRequest = { threadId: string; projectId?: string; executionId: string; path: string };
export type SandboxFileReader = (request: SandboxFileRequest, signal: AbortSignal) => Promise<Uint8Array>;

/** Binary transfer is independent of shell stdout (which is deliberately truncated). */
export const readSandboxFile: SandboxFileReader = async (request, signal) => {
  const url = process.env.SANDBOX_URL, token = process.env.SANDBOX_TOKEN;
  if (!url || !token) throw new Error('sandbox_unavailable');
  const response = await fetch(`${url}/files/read`, {
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 404 ? 'workspace_file_not_found' : response.status === 413 ? 'workspace_file_too_large_or_empty' : response.status === 409 ? 'workspace_busy' : 'workspace_file_unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('workspace_file_unavailable');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 20 * 1024 * 1024) throw new Error('workspace_file_too_large_or_empty');
      chunks.push(value);
    }
    if (!size) throw new Error('workspace_file_too_large_or_empty');
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); }
};

// A disconnected execute request is not proof that its container has exited.
// The broker acknowledges cancellation only after removing the container.
export const cancelSandbox: SandboxCleanup = async executionId => {
  const url = process.env.SANDBOX_URL;
  const token = process.env.SANDBOX_TOKEN;
  if (!url || !token) throw new Error('sandbox_not_configured');
  const response = await fetch(`${url}/cancel`, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ executionId }),
  });
  if (!response.ok) throw new Error('sandbox_cleanup_pending');
};

// Only the broker has Docker access. Neither the API nor model commands get its socket.
export const executeSandbox: SandboxExecutor = async (request, signal) => {
  const timeoutMs = shellTimeoutSeconds(request.timeoutSeconds) * 1000 + 30_000;
  const url = process.env.SANDBOX_URL;
  const token = process.env.SANDBOX_TOKEN;
  if (!url || !token) throw new Error('sandbox_not_configured');
  const response = await fetch(`${url}/execute`, agentHttpInit({
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(request),
  }));
  if (!response.ok) throw new Error('sandbox_unavailable');
  return await response.json() as SandboxResult;
};
