export type GatewayChannel = 'feishu' | 'ilink';
export interface GatewayManifest {
  id: string; version: 1; name: string;
  configFields?: Array<{ key: string; label: string; secret: boolean; required: boolean; write: 'replace-or-preserve' }>;
  loginSteps?: Array<{ action: string; label: string; fields: string[] }>;
  loginPublicFields?: string[];
  /** Login result fields persisted as encrypted config, never public by default. */
  loginConfigFields?: string[];
  management?: Array<'configure' | 'pair' | 'revoke' | 'login' | 'retry' | 'discard'>;
  capabilities: { direct: true; groups: false; images: boolean; files: boolean; proactive: 'yes' | 'context-dependent'; deduplicationWindowMs: number };
}
export interface GatewayEnvelope {
  messageId: string; tenant: string; peer: string; chat: string; topic: string;
  direct: boolean; human: boolean; text: string; context?: string;
  attachments?: Array<{ key: string; name: string; mime: string; metadata?: Record<string, string> }>;
}
export interface GatewayPayload { text: string; fileId?: string }
