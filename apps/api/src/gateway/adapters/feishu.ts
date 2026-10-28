import crypto from 'node:crypto';
import type { WSClient } from '@larksuiteoapi/node-sdk';
import { mediaMime } from '../../cloud/image.js';
import { DeliveryError, type ChannelContext, type ChannelPlugin, type GatewayEnvelope, type GatewayPayload } from '../plugin.js';

export type FileResolver = (peer: GatewayEnvelope, id: string) => Promise<{ bytes: Uint8Array; name: string; mime: string }>;
const root = 'https://open.feishu.cn/open-apis';
export function normalizeFeishu(event: any): GatewayEnvelope {
  const m = event.message ?? {}, sender = event.sender ?? {};
  let content: any = {}; try { content = JSON.parse(m.content ?? '{}'); } catch { /* reject invalid content */ }
  const attachments: NonNullable<GatewayEnvelope['attachments']> = [];
  if (m.message_type === 'image' && content.image_key) attachments.push({ key: content.image_key, name: 'image.png', mime: 'image/png' });
  if (m.message_type === 'file' && content.file_key) attachments.push({ key: content.file_key, name: String(content.file_name ?? 'attachment'), mime: 'application/octet-stream' });
  return { messageId: m.message_id ?? '', tenant: sender.tenant_key ?? event.tenant_key ?? '', peer: sender.sender_id?.open_id ?? '', chat: m.chat_id ?? '', topic: '',
    direct: m.chat_type === 'p2p', human: sender.sender_type === 'user', text: typeof content.text === 'string' ? content.text : '', attachments };
}
export async function limitedBytes(response: Response, limit = 20 * 1024 * 1024): Promise<Uint8Array> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > limit) throw new DeliveryError('media_download_rejected');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new DeliveryError('file_too_large'); chunks.push(value); } }
  finally { await reader.cancel(); }
  const result = new Uint8Array(size); let offset = 0; for (const c of chunks) { result.set(c, offset); offset += c.length; } return result;
}
export class FeishuPlugin implements ChannelPlugin {
  readonly manifest: ChannelPlugin['manifest'] = { id: 'feishu', version: 1, name: '飞书', configFields: [{ key: 'appId', label: 'App ID', secret: false, required: true, write: 'replace-or-preserve' }, { key: 'appSecret', label: 'App Secret', secret: true, required: true, write: 'replace-or-preserve' }], loginSteps: [], management: ['configure', 'pair', 'revoke', 'retry', 'discard'], capabilities: { direct: true, groups: false, images: true, files: true, proactive: 'yes', deduplicationWindowMs: 3600_000 } };
  private ws?: WSClient;
  constructor(private resolveFile: FileResolver, private fetcher: typeof fetch = fetch) {}
  validate(c: Record<string, string>) { if (!/^cli_[\w]+$/.test(c.appId ?? '') || !c.appSecret || c.appSecret.length > 4096) throw new Error('invalid_feishu_credentials'); }
  async start(c: Record<string, string>, ctx: ChannelContext) {
    this.validate(c); ctx.health('connecting');
    const { WSClient, EventDispatcher } = await import('@larksuiteoapi/node-sdk');
    ctx.signal.throwIfAborted();
    this.ws = new WSClient({ appId: c.appId, appSecret: c.appSecret, autoReconnect: true, handshakeTimeoutMs: 15_000,
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      onReady: () => ctx.health('connected'), onReconnecting: () => ctx.health('reconnecting'), onReconnected: () => ctx.health('connected'), onError: () => ctx.health('connection_failed') });
    ctx.signal.addEventListener('abort', () => this.ws?.close({ force: true }), { once: true });
    const dispatcher = new EventDispatcher({}).register({ 'im.message.receive_v1': async (event: any) => {
      if (!ctx.signal.aborted) ctx.receive([normalizeFeishu(event)]); // synchronous SQLite commit before SDK callback ACK
      return {};
    } });
    await this.ws.start({ eventDispatcher: dispatcher });
  }
  async stop() { this.ws?.close({ force: true }); this.ws = undefined; }
  /** tenant_access_token 有效期 2 小时：按平台给的 expire 缓存，提前 5 分钟换新，不在每次发送时重新换取。 */
  private cached?: { key: string; token: string; until: number };
  private async token(c: Record<string, string>, signal: AbortSignal) {
    const key = `${c.appId}\0${crypto.createHash('sha256').update(c.appSecret ?? '').digest('hex')}`;
    if (this.cached?.key === key && this.cached.until > Date.now()) return this.cached.token;
    const r = await this.fetcher(`${root}/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }), signal, redirect: 'error' });
    if (!r.ok) throw new DeliveryError('authentication_failed');
    const b = await r.json() as any;
    if (b.code || !b.tenant_access_token) throw new DeliveryError('authentication_failed');
    const ttl = Number.isFinite(b.expire) ? Number(b.expire) * 1000 : 7200_000;
    this.cached = { key, token: b.tenant_access_token as string, until: Date.now() + Math.max(0, ttl - 300_000) };
    return this.cached.token;
  }
  async send(c: Record<string, string>, peer: GatewayEnvelope, payload: GatewayPayload, id: string, signal: AbortSignal) {
    const token = await this.token(c, signal);
    let content: any = { text: payload.text }, type = 'text';
    if (payload.fileId) {
      const f = await this.resolveFile(peer, payload.fileId); if (f.bytes.length > 20 * 1024 * 1024) throw new DeliveryError('file_too_large');
      const image = /^image\/(png|jpeg|gif|webp)$/.test(f.mime);
      const form = new FormData(); form.append(image ? 'image_type' : 'file_type', image ? 'message' : 'stream');
      if (!image) form.append('file_name', f.name);
      form.append(image ? 'image' : 'file', new Blob([f.bytes as BlobPart], { type: f.mime }), f.name);
      const response = await this.fetcher(`${root}/im/v1/${image ? 'images' : 'files'}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form, signal, redirect: 'error' });
      if (!response.ok) throw new DeliveryError('media_upload_failed');
      const upload = await response.json() as any; const key = image ? 'image_key' : 'file_key';
      if (upload.code || !upload.data?.[key]) throw new DeliveryError('media_upload_failed');
      content = { [key]: upload.data[key] }; type = image ? 'image' : 'file';
    }
    let response: Response;
    try { response = await this.fetcher(`${root}/im/v1/messages?receive_id_type=chat_id`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ receive_id: peer.chat, msg_type: type, content: JSON.stringify(content), uuid: id }), signal, redirect: 'error' }); }
    catch { throw new DeliveryError('transport_result_unknown', true); }
    if (response.status === 429) throw new DeliveryError('rate_limited', false, Math.max(1000, Number(response.headers.get('retry-after') ?? 1) * 1000));
    if (!response.ok) throw new DeliveryError('send_failed', response.status >= 500);
    const body = await response.json() as any;
    // 令牌被吊销或过期（99991661/63/68）：丢掉缓存，下一次重试重新换取。
    if ([99991661, 99991663, 99991668].includes(body.code)) this.cached = undefined;
    if (body.code) throw new DeliveryError(body.code === 230020 ? 'rate_limited' : 'platform_rejected', false, 1000);
    return body.data?.message_id ?? id;
  }
  async download(c: Record<string, string>, m: GatewayEnvelope, attachment: NonNullable<GatewayEnvelope['attachments']>[number], signal: AbortSignal) {
    const token = await this.token(c, signal);
    const url = `${root}/im/v1/messages/${encodeURIComponent(m.messageId)}/resources/${encodeURIComponent(attachment.key)}?type=${attachment.mime.startsWith('image/') ? 'image' : 'file'}`;
    const r = await this.fetcher(url, { headers: { authorization: `Bearer ${token}` }, signal, redirect: 'error' });
    const bytes = await limitedBytes(r);
    return { bytes, name: attachment.name, mime: mediaMime(bytes, attachment.mime.startsWith('image/') ? attachment.mime : r.headers.get('content-type')?.split(';')[0] ?? attachment.mime) };
  }
}
