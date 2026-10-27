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
export interface AgentPolicy {
  read: Permission;
  write: Permission;
  remove: Permission;
  shell: Permission;
  network: 'allow' | 'deny';
  maxSteps: number;
}
export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  read: 'allow', write: 'ask', remove: 'ask', shell: 'ask', network: 'deny', maxSteps: 100,
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
