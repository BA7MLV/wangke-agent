import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import { modelUsage, usageCollector, type ModelUsage } from '@wangke/study-core/model/usage';
import type { ModelUsageCounts, ModelUsageReport, ModelUsageSource } from '@wangke/contracts/cloud';

/** Ordinary traffic is measured without applying Bot admission/billing quotas.
 * No prompt, response text, URL, credential or cache key is retained here. */
export async function observeModelFetch(store: DatabaseStore, owner: string, provider: string, model: string, fetcher: typeof fetch, url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const id = crypto.randomUUID(), collector = usageCollector();
  store.db.prepare('INSERT INTO model_observations(id,owner_id,provider,model,started_at,status) VALUES(?,?,?,?,?,?)').run(id, owner, provider, model, new Date().toISOString(), 'inflight');
  let settled = false;
  const settle = (status: string, usage: ModelUsage | undefined = collector.value) => {
    if (settled) return;
    settled = true;
    init?.signal?.removeEventListener('abort', abort);
    store.db.prepare(`UPDATE model_observations SET ended_at=?,status=?,input_tokens=?,output_tokens=?,cache_tokens=?,cache_creation_tokens=?,reasoning_tokens=? WHERE id=?`)
      .run(new Date().toISOString(), status, usage?.input ?? null, usage?.output ?? null, usage?.cache ?? null, usage?.cacheCreation ?? null, usage?.reasoning ?? null, id);
  };
  const abort = () => settle('cancelled');
  init?.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetcher(url, init);
    if (!response.ok) { settle(`http_${response.status}`); return response; }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      let usage: ModelUsage | undefined;
      try { usage = modelUsage(await response.clone().json()); } catch { /* unknown, never zero */ }
      settle('completed', usage);
      return response;
    }
    if (!response.body) { settle('failed'); return response; }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    const observe = (line: string) => {
      if (!line.startsWith('data:')) return;
      try { collector.observe(JSON.parse(line.slice(5).trim())); } catch { /* [DONE] */ }
    };
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { observe(pending + decoder.decode()); settle('completed'); reader.releaseLock(); controller.close(); return; }
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split('\n'); pending = lines.pop()!;
          for (const line of lines) observe(line);
          controller.enqueue(value);
        } catch (error) { settle('failed'); controller.error(error); }
      },
      async cancel(reason) { settle('cancelled'); await reader.cancel(reason); },
    }), { status: response.status, headers: response.headers });
  } catch (error) { settle(init?.signal?.aborted ? 'cancelled' : 'failed'); throw error; }
}

export function modelUsageReport(store: DatabaseStore, owner: string, since: string,
  options: { until?: string; source?: ModelUsageSource | 'all' } = {}): ModelUsageReport {
  const generatedAt = new Date().toISOString();
  // Timestamps have millisecond precision: include requests started in this tick.
  const until = options.until ?? new Date(Date.parse(generatedAt) + 1).toISOString(), selected = options.source ?? 'all';
  // The table is the source of truth, including Bot child tasks. Never join runs
  // or add reservations: deleted conversations and unknown usage keep their meaning.
  const columns = 'provider,model,started_at,input_tokens,output_tokens,cache_tokens,cache_creation_tokens,reasoning_tokens,status';
  const source = `SELECT 'bot' AS source,${columns} FROM bot_requests WHERE owner_id=? AND started_at>=? AND started_at<? AND ? IN ('all','bot')
    UNION ALL SELECT 'chat' AS source,${columns} FROM model_observations WHERE owner_id=? AND started_at>=? AND started_at<? AND ? IN ('all','chat')`;
  const fields = `COUNT(*) AS requests,COUNT(CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN 1 END) AS measuredRequests,
    COUNT(input_tokens) AS inputMeasuredRequests,COUNT(output_tokens) AS outputMeasuredRequests,
    COUNT(cache_tokens) AS cacheMeasuredRequests,COUNT(cache_creation_tokens) AS cacheWriteMeasuredRequests,COUNT(reasoning_tokens) AS reasoningMeasuredRequests,
    COUNT(CASE WHEN status='inflight' THEN 1 END) AS inflightRequests,
    COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,
    COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) AS totalTokens,
    COALESCE(SUM(cache_tokens),0) AS cacheReadTokens,COALESCE(SUM(cache_creation_tokens),0) AS cacheWriteTokens,
    COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens,
    COALESCE(SUM(CASE WHEN cache_tokens IS NOT NULL THEN input_tokens ELSE 0 END),0) AS cacheMeasuredInputTokens,
    1.0*SUM(CASE WHEN input_tokens IS NOT NULL THEN cache_tokens END)/NULLIF(SUM(CASE WHEN cache_tokens IS NOT NULL THEN input_tokens END),0) AS cacheHitRate`;
  const params = [owner, since, until, selected, owner, since, until, selected];
  const groups = <T>(dimensions: string, group: string) => store.db.prepare(`SELECT ${dimensions},${fields} FROM (${source}) GROUP BY ${group} ORDER BY ${group}`).all(...params) as T[];
  // A read transaction also keeps the independent groupings on one snapshot.
  return store.db.transaction(() => ({ since, until, generatedAt, timeZone: 'UTC' as const, source: selected,
    total: store.db.prepare(`SELECT ${fields} FROM (${source})`).get(...params) as ModelUsageCounts,
    byModel: groups<ModelUsageReport['byModel'][number]>('provider,model', 'provider,model'),
    bySource: groups<ModelUsageReport['bySource'][number]>('source', 'source'),
    bySourceModel: groups<ModelUsageReport['bySourceModel'][number]>('source,provider,model', 'source,provider,model'),
    byDay: groups<ModelUsageReport['byDay'][number]>("date(started_at) AS date,source", 'date,source'),
    byDayModel: groups<ModelUsageReport['byDayModel'][number]>("date(started_at) AS date,source,provider,model", 'date,source,provider,model'),
  }))();
}
