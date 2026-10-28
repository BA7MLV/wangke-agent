import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import { appendAudit } from '../storage/audit.js';

export type BotLifecycleEvent = {
  id: string; at: string; owner: string; thread?: string; run?: string; step?: string; requestId?: string;
  type: 'run.started' | 'run.paused' | 'run.finished' | 'model.started' | 'model.finished' | 'tool.started' | 'tool.finished' | 'approval.waiting' | 'compaction.saved' | 'memory.saved' | 'memory.deleted' | 'delivery.finished';
  status?: string;
};
export type BotEventHook = (event: Readonly<BotLifecycleEvent>) => void | Promise<void>;
/** Observers cannot turn a successful commit into an unknown side effect.
 * Authorization and budget checks must never go through this best-effort API. */
export function publishBotEvent(store: DatabaseStore, input: Omit<BotLifecycleEvent, 'id' | 'at'>, hook?: BotEventHook) {
  const event = Object.freeze({ ...input, id: crypto.randomUUID(), at: new Date().toISOString() });
  appendAudit(store, event.owner, `bot.${event.type}`, event, event.at);
  if (hook) void Promise.resolve().then(() => hook(event)).catch(() => console.error('bot_event_observer_failed'));
}
