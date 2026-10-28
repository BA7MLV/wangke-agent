import type { CloudTask } from '@wangke/contracts/cloud';
import { cloud, cloudRequest } from './state';
import { apiUrl } from '../api/base';

/** Dedicated authenticated browser worker. The API owns scheduling; this page only leases and runs browser tasks. */
export async function startBrowserWorker(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(apiUrl('/api/v1/cloud/worker/claim'), { method: 'POST', credentials: 'include' });
      if (response.status === 204) { await new Promise(r => setTimeout(r, 1000)); continue; }
      if (!response.ok) throw new Error(`worker_claim_${response.status}`);
      const claimed = await response.json() as { token: string; task: CloudTask };
      cloud.workerToken = claimed.token;
      try {
        const result = await window.__runCloudTask(claimed.task);
        await cloudRequest(`/tasks/${claimed.task.id}/complete`, { method: 'POST', body: JSON.stringify({ result }) });
      } catch (error) {
        await cloudRequest(`/tasks/${claimed.task.id}/complete`, { method: 'POST', body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }).catch(() => {});
      } finally {
        cloud.workerToken = '';
        cloud.taskId = '';
      }
    } catch {
      cloud.workerToken = '';
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}
