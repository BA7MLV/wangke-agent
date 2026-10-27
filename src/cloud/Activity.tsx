import { useEffect } from 'react';
import { cloud, cloudRequest } from './state';
import { useCloudSync } from './sync';
import { reflectCloudTasks } from '../store/courseChat';
import { useLibraryRevision } from '../pipelines/folderPlan';
import type { CloudTask } from '../../packages/contracts/src/cloud';
import { useJobStore } from '../store/jobs';

export default function CloudActivity() {
  const error = useCloudSync(s => s.error);
  useEffect(() => {
    if (!cloud.enabled || cloud.worker) return;
    let busy = false, stopped = false, dirty = true;
    const changed = () => { dirty = true; useLibraryRevision.getState().bump(); };
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const { tasks } = await cloudRequest<{ tasks: CloudTask[] }>('/tasks');
        if (stopped) return;
        const changedData = dirty; dirty = false;
        window.dispatchEvent(new CustomEvent('cloud-tasks-changed', { detail: { tasks, dataChanged: changedData } }));
        await reflectCloudTasks(tasks, changedData);
        const seen = new Set<string>();
        for (const task of tasks) {
          const id = task.input.videoId;
          if (typeof id !== 'string' || seen.has(id) || !['transcribe', 'material'].includes(task.kind)) continue;
          seen.add(id);
          useJobStore.getState().upsert(id, {
            ...(task.progress ?? {}), phase: task.status === 'completed' ? 'done' : task.status === 'failed' || task.status === 'interrupted' ? 'error' : task.status === 'cancelled' ? 'canceled' : (task.progress?.phase as any) ?? 'queued',
            message: task.error ?? String(task.progress?.message ?? task.status), resume: false,
          });
        }
      } catch { /* Session expiry/sync feedback is handled by the shared transport. */ }
      finally { busy = false; }
    };
    window.addEventListener('cloud-data-changed', changed);
    // Server-side course tasks publish throttled token progress. Poll faster
    // than the old one-second cadence so that the durable task stream still
    // feels live without opening a second transport channel.
    const timer = setInterval(() => void refresh(), 250); void refresh();
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('cloud-data-changed', changed); };
  }, []);
  return cloud.enabled && error ? <p role="alert" className="bg-surface p-3 text-danger">{error}</p> : null;
}
