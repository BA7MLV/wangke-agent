import { db } from './db';
import { summarizeUsage, type ModelRequestRecord } from '@wangke/study-core/model/usage';

/** Direct-browser baseline. Cloud requests have their authoritative report at
 * /api/v1/cloud/model-usage; do not add both reports together. */
export async function readModelUsageReport(since = Date.now() - 86400000) {
  const requests = new Map<string, ModelRequestRecord>();
  await db.chats.each(row => {
    for (const request of row.modelRequests ?? []) if (request.startedAt >= since) requests.set(request.id, request);
  });
  const groups = new Map<string, ModelRequestRecord[]>();
  const ordered = [...requests.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const request of ordered) {
    const key = JSON.stringify([request.providerId, request.model]);
    const group = groups.get(key) ?? [];
    group.push(request); groups.set(key, group);
  }
  return { since, generatedAt: Date.now(), total: summarizeUsage(ordered),
    byModel: [...groups.values()].map(group => ({ providerId: group[0].providerId, model: group[0].model, ...summarizeUsage(group) })) };
}
