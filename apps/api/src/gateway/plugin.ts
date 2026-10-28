import type { GatewayEnvelope, GatewayManifest, GatewayPayload } from '@wangke/contracts/gateway';
export type { GatewayEnvelope, GatewayManifest, GatewayPayload };
export interface ChannelContext {
  signal: AbortSignal;
  receive(batch: GatewayEnvelope[], cursor?: string): void;
  cursor(): string | undefined;
  updateConfig(patch: Record<string, string>): void;
  health(state: string): void;
}
export interface ChannelPlugin {
  manifest: GatewayManifest;
  validate(config: Record<string, string>): void;
  start(config: Record<string, string>, context: ChannelContext): Promise<void>;
  stop(): Promise<void>;
  login?(config: Record<string, string>, action: Record<string, string>, signal: AbortSignal): Promise<Record<string, string>>;
  send(config: Record<string, string>, destination: GatewayEnvelope, payload: GatewayPayload, deliveryId: string, signal: AbortSignal): Promise<string>;
  download?(config: Record<string, string>, message: GatewayEnvelope, attachment: NonNullable<GatewayEnvelope['attachments']>[number], signal: AbortSignal): Promise<{ bytes: Uint8Array; name: string; mime: string }>;
}
export class DeliveryError extends Error {
  constructor(readonly code: string, readonly uncertain = false, readonly retryAfterMs = 0) { super(code); }
}
