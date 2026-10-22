/** Browser task routing; protocol serialization itself is runtime-neutral. */
export * from './modelClient';
import { chatOnce as localChatOnce, type ChatOptions, type ChatMessage } from './modelClient';
import type { ModelTarget } from '../store/settings';

export async function chatOnce(target: ModelTarget, options: ChatOptions): Promise<ChatMessage> {
  const { remoteTasks } = await import('../cloud/state');
  if (remoteTasks()) {
    const { runCloudTask } = await import('../cloud/tasks');
    const { signal, ...input } = options;
    const providerId = target.baseUrl.split('/').filter(Boolean).pop();
    return runCloudTask('modelOnce', crypto.randomUUID(), { providerId, model: target.model, options: input }, undefined, signal);
  }
  return localChatOnce(target, options);
}
