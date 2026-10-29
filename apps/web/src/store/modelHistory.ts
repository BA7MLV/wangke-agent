import { db } from './db';
import { historyFingerprint, messageTokens, replayTrace } from '@wangke/study-core/model/transcript';

export async function sessionCacheKey(sessionId: number): Promise<string> {
  return db.transaction('rw', db.chatSessions, async () => {
    const session = await db.chatSessions.get(sessionId);
    if (session?.promptCacheKey) return session.promptCacheKey;
    const key = crypto.randomUUID();
    await db.chatSessions.update(sessionId, { promptCacheKey: key });
    return key;
  });
}

/** Whole turns, durable cut, 20% headroom. A short new question cannot resurrect
 * a previously omitted prefix; edits/deletes invalidate the saved boundary. */
export async function fitModelHistory<T extends { id?: number; rowId?: number; role: string; content: string; originalContent?: string }>(sessionId: number, rows: T[], budget: number): Promise<T[]> {
  const checkpoint = (await db.chatSessions.get(sessionId))?.contextCheckpoint;
  let start = checkpoint ? rows.findIndex(r => (r.id ?? r.rowId) === checkpoint.fromId && (r.originalContent ?? r.content) === checkpoint.source) : 0;
  if (start > 0 && checkpoint?.prefixHash && await historyFingerprint(rows.slice(0, start)) !== checkpoint.prefixHash) start = 0;
  const effective = rows.slice(Math.max(0, start));
  const costs = effective.map(r => historyRowTokens(r));
  let total = costs.reduce((a, b) => a + b, 0);
  if (total <= budget) return effective;
  let cut = 0;
  while (cut < effective.length && total > budget * 0.8) {
    let next = cut + 1;
    while (next < effective.length && (effective[next].role !== 'user' || replayTrace(effective[next])?.length === 0)) next++;
    if (next === effective.length) break;
    while (cut < next) total -= costs[cut++];
  }
  const first = effective[cut];
  const id = first?.id ?? first?.rowId;
  if (cut > 0 && id != null) await db.chatSessions.update(sessionId, { contextCheckpoint: { fromId: id, source: first.originalContent ?? first.content, prefixHash: await historyFingerprint(rows.slice(0, Math.max(0, start) + cut)) } });
  return effective.slice(cut);
}

export function historyRowTokens(row: { role: string; content: string }) {
  return messageTokens(replayTrace(row) ?? [{ role: row.role as 'user' | 'assistant', content: row.content }]);
}
