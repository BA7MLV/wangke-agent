/** Shared cloud protocol. Table names are an allowlist, never SQL identifiers. */
export const CLOUD_TABLES: Record<string, string> = {
  videos: 'id', files: 'id', segments: 'id', frames: 'id', handouts: 'id',
  chats: 'id', chatSessions: 'id', skills: 'id', skillRefs: 'id', danmakus: 'id',
  folders: 'id', cards: 'id', subtitleTracks: 'id', materialBlocks: 'id',
  materialInk: 'id', covers: 'videoId', studyDays: 'date', courseFiles: 'id', comments: 'id',
  preferences: 'id',
};
export interface CloudMutation {
  id: string;
  table: string;
  key: string | number;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Server-issued execution permit; only internal task workers may use it. */
  permissionId?: string;
  /** Last server revision observed for this key; required to recreate a tombstone. */
  baseRevision?: number;
}
export interface CloudRecord {
  table: string;
  key: string | number;
  value: Record<string, unknown> | null;
  revision: number;
}
export type Permission = 'allow' | 'ask' | 'deny';

/** Shared wording for new pauses and older persisted progress messages. */
export function botPauseMessage(code: string, language = 'zh-CN'): string {
  const en = language.startsWith('en');
  if (code === 'context_capacity_exceeded') return en
    ? 'There was more here than I could process at once, so I couldn’t finish this time. The work already done is saved.'
    : '这次的内容有点多，我没能全部处理完。已经完成的部分都保留着。';
  if (code === 'run_step_budget') return en
    ? 'I haven’t finished everything yet. The work completed so far is saved.'
    : '这件事还没全部处理完，已经完成的部分都保留着。';
  if (code === 'tool_timeout') return en
    ? 'That last operation hasn’t returned, so I can’t confirm whether it finished. The results already received are saved.'
    : '刚才那一步一直没有返回，我还不能确认它是否完成。已经收到的结果都保留着。';
  if (code === 'model_usage_exceeded_reservation') return en
    ? 'I couldn’t finish this time because the model returned an unexpected result. The work already done is saved.'
    : '模型这次返回的情况有些异常，我没能接着处理完。已经完成的部分都保留着。';
  return en
    ? 'I couldn’t finish this time. The work already done is saved.'
    : '这次暂时没能处理完，已经完成的部分都保留着。';
}

export function botProgressText(text: string, language = 'zh-CN'): string {
  const legacy = /^预算已暂停任务：([a-z_]+)。请调整预算后显式继续。$/.exec(text);
  return legacy ? botPauseMessage(legacy[1], language) : text;
}
export interface AgentPolicy {
  read: Permission;
  write: Permission;
  remove: Permission;
  shell: Permission;
  network: 'allow' | 'deny';
  maxSteps: number;
}
export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  read: 'allow', write: 'ask', remove: 'ask', shell: 'ask', network: 'allow', maxSteps: 100,
};
export interface CloudProvider {
  id: string;
  name: string;
  baseUrl: string;
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
  apiKey?: string;
  configured?: boolean;
  catalogId: string;
  serves: Array<'chat' | 'vision' | 'asr' | 'decision'>;
}
export interface CloudConfig {
  /** Opaque version of provider/model settings, independent of account policy. */
  modelRevision?: string;
  botBudget?: {
    runTokens?: number; dayTokens?: number; activeMs?: number; contextTokens: number; runCost?: number;
    prices: Array<{ provider: string; model: string; inputPerMillion: number; outputPerMillion: number; source: string }>;
  };
  providers: CloudProvider[];
  llmModel: { providerId: string; model: string };
  visionModel: { providerId: string; model: string };
  asrModel: { providerId: string; model: string };
  /** Optional TypeSafe /systemone decision model; features using it stay off until enabled. */
  decisionModel?: { providerId: string; model: string };
  policy: AgentPolicy;
  trustedAgentIds?: string[];
}
export type CloudTaskKind = 'chat' | 'qa' | 'transcribe' | 'handout' | 'cards' | 'comments' | 'danmaku' | 'material' | 'cover' | 'artifactEdit' | 'handoutEdit' | 'modelOnce';
export interface CloudTask {
  /** Persisted execution backend; absent for jobs created before executor routing. */
  executor?: 'node' | 'media' | 'browser';
  id: string;
  kind: CloudTaskKind;
  resource: string;
  status: 'queued' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  input: Record<string, unknown>;
  progress: Record<string, unknown> | null;
  result: unknown;
  error: string | null;
  createdAt: string;
}
