/** Provider-authoritative counts. Input/output are inclusive; reasoning and cache
 * are subsets, never added twice. Missing cache telemetry is unknown, not zero. */
export interface ModelUsage {
  input: number;
  output: number;
  cache?: number;
  cacheCreation?: number;
  reasoning?: number;
}
export interface ModelRequestRecord {
  id: string;
  providerId: string;
  model: string;
  protocol: string;
  startedAt: number;
  endedAt: number;
  status: 'completed' | 'failed' | 'cancelled';
  usage?: ModelUsage;
}
const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function modelUsage(body: unknown): ModelUsage | undefined {
  const usage = object(object(body)?.usage);
  if (!usage) return;
  let input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const cache = object(usage.prompt_tokens_details)?.cached_tokens ?? object(usage.input_tokens_details)?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens ?? undefined;
  const cacheCreation = usage.cache_creation_input_tokens ?? undefined;
  const reasoning = object(usage.completion_tokens_details)?.reasoning_tokens ?? object(usage.output_tokens_details)?.reasoning_tokens ?? undefined;
  if (!count(input) || !count(output)) return;
  for (const v of [cache, cacheCreation, reasoning]) if (v !== undefined && !count(v)) return;
  // Anthropic excludes reads and writes from input_tokens; OpenAI includes them.
  if (usage.prompt_tokens === undefined && (usage.cache_read_input_tokens !== undefined || cacheCreation !== undefined)) input += (cache as number | undefined ?? 0) + (cacheCreation as number | undefined ?? 0);
  if (!count(input) || (cache as number ?? 0) + (cacheCreation as number ?? 0) > input || (reasoning as number ?? 0) > output) return;
  return { input, output, ...(cache === undefined ? {} : { cache: cache as number }), ...(cacheCreation === undefined ? {} : { cacheCreation: cacheCreation as number }), ...(reasoning === undefined ? {} : { reasoning: reasoning as number }) };
}

/** SSE usage events are cumulative snapshots, not token deltas. */
export function usageCollector() {
  let current: ModelUsage | undefined;
  let anthropic: Record<string, unknown> | undefined;
  return {
    observe(value: unknown) {
      const event = object(value);
      if (!event) return;
      if (event.type === 'message_start') anthropic = object(object(event.message)?.usage);
      if (event.type === 'message_delta' && anthropic) anthropic = { ...anthropic, ...object(event.usage) };
      current = (anthropic ? modelUsage({ usage: anthropic }) : undefined) ?? modelUsage(event) ?? modelUsage(event.response) ?? current;
    },
    get value() { return current; },
  };
}

export function summarizeUsage(requests: readonly { usage?: ModelUsage }[]) {
  const measured = requests.flatMap(r => r.usage ? [r.usage] : []);
  const cacheMeasured = measured.filter(u => u.cache !== undefined);
  const cacheInput = cacheMeasured.reduce((n, u) => n + u.input, 0);
  const cacheRead = cacheMeasured.reduce((n, u) => n + u.cache!, 0);
  return { requests: requests.length, measuredRequests: measured.length, cacheMeasuredRequests: cacheMeasured.length,
    cacheWriteMeasuredRequests: measured.filter(u => u.cacheCreation !== undefined).length,
    input: measured.reduce((n, u) => n + u.input, 0), output: measured.reduce((n, u) => n + u.output, 0),
    cacheRead, cacheWrite: measured.reduce((n, u) => n + (u.cacheCreation ?? 0), 0), cacheInput,
    cacheHitRate: cacheInput > 0 ? cacheRead / cacheInput : null,
    lastRequest: requests.at(-1)?.usage };
}
