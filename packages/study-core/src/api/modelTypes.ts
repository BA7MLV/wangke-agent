import type { ModelOverrides } from './modelMeta.ts';

export type ApiProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

/** Request-scoped connection; never persisted or logged by shared logic. */
export interface ModelTarget {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  catalogId: string;
  protocol: ApiProtocol;
  capabilities?: ModelOverrides;
}

export interface ModelListConnection {
  baseUrl: string;
  apiKey: string;
  protocol?: ApiProtocol;
  credentials?: RequestCredentials;
  cacheScope?: string;
}
