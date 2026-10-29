export type ConversationMode = 'chat' | 'bot';
export { parseBotAttachments, parseLegacyBotAttachments, MAX_BOT_ATTACHMENTS, type BotAttachment } from './bot-attachments.js';
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ThreadDto {
  id: string;
  mode: ConversationMode;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  projectId?: string | null;
  agentId?: string | null;
  archived?: boolean;
  /** 列表接口附带：最近一条文本消息（截断到 160 字）。 */
  preview?: string | null;
}

export type { ProjectDto, ProjectDetailDto, ProjectPolicy, ProjectRole, ProjectGrantDto, ProjectFileDto, ProjectTextDto } from './projects.js';

export interface AgentProfileDto {
  id: string;
  name: string;
  avatar: string | null;
  role: string;
  enabled: boolean;
}

export interface MessageDto {
  id: string;
  threadId: string;
  clientNonce: string | null;
  seq: number;
  role: MessageRole;
  kind: 'text' | 'progress' | 'attachment' | 'widget' | 'question' | 'approval';
  content: string;
  createdAt: string;
  replyTo: string | null;
}

export interface RunDto {
  id: string;
  threadId: string;
  mode: ConversationMode;
  status: 'queued' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode?: 'model_not_configured' | 'model_request_failed' | 'invalid_structured_response' | null;
}

export type SseEvent =
  | { type: 'message.pending'; message: MessageDto }
  | { type: 'message.accepted'; message: MessageDto }
  | { type: 'message.updated'; message: MessageDto }
  | { type: 'message.reaction'; messageId: string; reaction: string; active: boolean }
  | { type: 'run.started'; run: RunDto }
  | { type: 'run.progress'; runId: string; text: string }
  | { type: 'run.waiting_user'; run: RunDto }
  | { type: 'run.completed'; run: RunDto }
  | { type: 'run.failed'; run: RunDto; error: string };

export interface BootstrapStatusDto {
  initialized: boolean;
  bootstrapAvailable: boolean;
  expiresAt: string | null;
}

export interface BootstrapInitializeRequest {
  adminPassword: string;
}
