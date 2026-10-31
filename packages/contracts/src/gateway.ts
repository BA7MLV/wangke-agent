export type GatewayChannel = 'feishu' | 'ilink';
export interface GatewayManifest {
  id: string; version: 1; name: string;
  configFields?: Array<{ key: string; label: string; secret: boolean; required: boolean; write: 'replace-or-preserve' }>;
  loginSteps?: Array<{ action: string; label: string; fields: string[] }>;
  loginPublicFields?: string[];
  /** Login result fields persisted as encrypted config, never public by default. */
  loginConfigFields?: string[];
  management?: Array<'configure' | 'pair' | 'revoke' | 'login' | 'retry' | 'discard' | 'remove'>;
  capabilities: { direct: true; groups: false; images: boolean; files: boolean; markdown?: boolean; streaming?: boolean; maxMessageLength?: number; proactive: 'yes' | 'context-dependent'; deduplicationWindowMs: number };
}
export interface GatewayEnvelope {
  messageId: string; tenant: string; peer: string; chat: string; topic: string;
  direct: boolean; human: boolean; text: string; context?: string;
  attachments?: Array<{ key: string; name: string; mime: string; metadata?: Record<string, string> }>;
}
export interface GatewayPayload { text: string; fileId?: string }

/** Closed vocabulary: never put platform text, URLs, tokens or envelopes in diagnostics. */
export const GATEWAY_CONNECTION_ERRORS = ['network_error', 'dns_error', 'tls_error', 'request_timeout', 'rate_limited', 'login_required', 'platform_http_error', 'platform_rejected', 'invalid_platform_response', 'invalid_platform_message', 'unsafe_platform_message_id', 'response_too_large', 'inbox_capacity', 'receive_failed', 'duplicate_channel_account'] as const;
export interface GatewayConnectionError {
  code: typeof GATEWAY_CONNECTION_ERRORS[number];
  httpStatus?: number;
  platformCode?: number;
}
export interface GatewayConnectionDiagnostics {
  updatedAt: number;
  lastSuccessAt?: number;
  consecutiveFailures: number;
  retryAt?: number;
  error?: GatewayConnectionError;
}

export interface GatewayReadiness {
  state: 'disabled' | 'login_required' | 'connection_required' | 'binding_required' | 'bot_required' | 'model_required' | 'attention' | 'ready';
  connected: boolean;
  bound: boolean;
  botEnabled: boolean;
  modelConfigured: boolean;
  botName: string;
  lastInboundAt: number | null;
  deliveryFailures: number;
  inboxFailures: number;
  projectionFailures: number;
  latestRun: { status: string; errorCode: string | null } | null;
  /** User-safe phase for the latest multimodal turn, without tool internals. */
  processingStatus: 'collecting' | 'ready' | 'reading' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | null;
}
