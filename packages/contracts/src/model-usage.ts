/** Server SQLite usage only. Cache is included in input; reasoning in output. */
export type ModelUsageSource = 'chat' | 'bot';
export interface ModelUsageCounts {
  requests: number;
  measuredRequests: number;
  inputMeasuredRequests: number;
  outputMeasuredRequests: number;
  inflightRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheMeasuredRequests: number;
  cacheWriteMeasuredRequests: number;
  reasoningMeasuredRequests: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cacheMeasuredInputTokens: number;
  cacheHitRate: number | null;
}
export interface ModelUsageReport {
  since: string;
  /** Exclusive upper bound; daily groups use request started_at in UTC. */
  until: string;
  generatedAt: string;
  timeZone: 'UTC';
  source: ModelUsageSource | 'all';
  total: ModelUsageCounts;
  /** Legacy combined provider/model groups, retained for the cache baseline UI. */
  byModel: Array<ModelUsageCounts & { provider: string; model: string }>;
  bySource: Array<ModelUsageCounts & { source: ModelUsageSource }>;
  bySourceModel: Array<ModelUsageCounts & { source: ModelUsageSource; provider: string; model: string }>;
  byDay: Array<ModelUsageCounts & { date: string; source: ModelUsageSource }>;
  byDayModel: Array<ModelUsageCounts & { date: string; source: ModelUsageSource; provider: string; model: string }>;
}
