export type SandboxRequest = { threadId: string; projectId?: string; executionId: string; command: string; network?: boolean };
export type SandboxResult = { stdout: string; stderr: string; exitCode: number };
export type SandboxExecutor = (request: SandboxRequest, signal: AbortSignal) => Promise<SandboxResult>;
export type SandboxCleanup = (executionId: string) => Promise<void>;

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
  const url = process.env.SANDBOX_URL;
  const token = process.env.SANDBOX_TOKEN;
  if (!url || !token) throw new Error('sandbox_not_configured');
  const response = await fetch(`${url}/execute`, {
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(150_000)]),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error('sandbox_unavailable');
  return await response.json() as SandboxResult;
};
