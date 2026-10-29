/** Browser task routing; protocol serialization itself is runtime-neutral. */
export * from './modelClient';
import { chatOnce as localChatOnce, type ChatOptions, type ChatMessage } from './modelClient';
import type { ModelTarget } from '../store/settings';

export async function chatOnce(target: ModelTarget, options: ChatOptions): Promise<ChatMessage> {
  const { remoteTasks } = await import('../cloud/state');
  if (remoteTasks()) {
    const { runCloudTask } = await import('../cloud/tasks');
    const { signal, onRequest, ...input } = options;
    const providerId = target.baseUrl.split('/').filter(Boolean).pop();
    const startedAt = Date.now(), id = crypto.randomUUID();
    let message: ChatMessage | undefined;
    try { message = await runCloudTask('modelOnce', id, { providerId, model: target.model, options: input }, undefined, signal); return message!; }
    finally { await onRequest?.({ id, providerId: target.providerId, model: target.model, protocol: target.protocol,
      startedAt, endedAt: Date.now(), status: message ? 'completed' : signal?.aborted ? 'cancelled' : 'failed', usage: message?.usage }); }
  }
  return localChatOnce(target, options);
}
