import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { mediaMime } from '../../cloud/image.js';
import { DeliveryError, type ChannelPlugin, type ChannelContext, type GatewayEnvelope, type GatewayPayload } from '../plugin.js';
import { limitedBytes, type FileResolver } from './feishu.js';

const DEFAULT = 'https://ilinkai.weixin.qq.com';
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
/** Credentials are only ever sent to Tencent's HTTPS API domain; CDN never gets bot headers. */
export function tencentUrl(value: string, cdn = false) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !(cdn ? (u.hostname === 'cdn.weixin.qq.com' || u.hostname.endsWith('.cdn.weixin.qq.com')) : (u.hostname === 'ilinkai.weixin.qq.com' || u.hostname.endsWith('.ilinkai.weixin.qq.com')))) throw new Error('untrusted_platform_url');
  return u.href.replace(/\/$/, '');
}
export function normalizeIlink(m: any): GatewayEnvelope {
  // Official v2.4.10 declares number, not int64/string. Refuse lossy dedupe IDs.
  if (typeof m.message_id === 'number' && !Number.isSafeInteger(m.message_id)) throw new Error('unsafe_platform_message_id');
  const attachments: NonNullable<GatewayEnvelope['attachments']> = [], texts: string[] = [];
  for (const item of m.item_list ?? []) {
    if (item.text_item?.text) texts.push(String(item.text_item.text));
    if (item.voice_item?.text) texts.push(String(item.voice_item.text));
    const part = item.image_item ?? item.file_item;
    if (part?.media) attachments.push({ key: part.media.encrypt_query_param ?? '', name: part.file_name ?? 'image.jpg', mime: item.image_item ? 'image/jpeg' : 'application/octet-stream', metadata: { fullUrl: part.media.full_url ?? '', aesKey: part.aeskey ?? '', mediaKey: part.media.aes_key ?? '' } });
  }
  return { messageId: m.message_id === undefined ? '' : String(m.message_id), tenant: '', peer: m.from_user_id ?? '', chat: m.from_user_id ?? '', topic: '', direct: !m.group_id, human: m.message_type === 1, text: texts.join('\n'), context: m.context_token, attachments };
}
export class IlinkPlugin implements ChannelPlugin {
  readonly manifest = { id: 'ilink', version: 1 as const, name: '微信 iLink', capabilities: { direct: true as const, groups: false as const, images: true, files: true, proactive: 'context-dependent' as const, deduplicationWindowMs: 0 } };
  constructor(private resolveFile: FileResolver, private fetcher: typeof fetch = fetch) {}
  validate(c: Record<string, string>) { if (c.baseUrl) tencentUrl(c.baseUrl); }
  private async request(c: Record<string, string>, path: string, body: any, signal: AbortSignal, authenticated = true): Promise<any> {
    const headers: Record<string, string> = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x02040a) };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers.AuthorizationType = 'ilink_bot_token'; headers['X-WECHAT-UIN'] = Buffer.from(String(crypto.randomInt(0, 2 ** 32))).toString('base64'); }
    if (authenticated) { if (!c.botToken) throw new DeliveryError('login_required'); headers.Authorization = `Bearer ${c.botToken}`; }
    let r: Response;
    try { r = await this.fetcher(`${tencentUrl(c.baseUrl || DEFAULT)}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body !== undefined ? { body: JSON.stringify(authenticated ? { ...body, base_info: { channel_version: '2.4.10', bot_agent: 'Wangke/1.0' } } : body) } : {}), signal, redirect: 'error' }); }
    catch { throw new DeliveryError('transport_result_unknown', path.endsWith('/sendmessage')); }
    if (r.status === 429) throw new DeliveryError('rate_limited', false, Number(r.headers.get('retry-after') ?? 2) * 1000);
    if (!r.ok) throw new DeliveryError('platform_http_error', path.endsWith('/sendmessage') && r.status >= 500);
    const value = await r.json() as any;
    if (value.ret === -14 || value.errcode === -14) throw new DeliveryError('login_required');
    if (value.ret || value.errcode) throw new DeliveryError('platform_rejected'); return value;
  }
  async login(c: Record<string, string>, action: Record<string, string>, signal: AbortSignal) {
    if (action.action === 'qr') {
      const value = await this.request({ ...c, baseUrl: DEFAULT }, '/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: c.botToken ? [c.botToken] : [] }, signal, false);
      if (!value.qrcode || !value.qrcode_img_content) throw new Error('invalid_qrcode');
      return { status: 'wait', qrcode: String(value.qrcode), qrDataUrl: await QRCode.toDataURL(String(value.qrcode_img_content), { width: 300, errorCorrectionLevel: 'M' }) };
    }
    if (action.action !== 'poll' || !action.qrcode || action.qrcode.length > 4096) throw new Error('invalid_login_action');
    const base = action.redirectHost ? tencentUrl(action.redirectHost.includes('://') ? action.redirectHost : `https://${action.redirectHost}`) : DEFAULT;
    const value = await this.request({ ...c, baseUrl: base }, `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(action.qrcode)}${action.verifyCode ? `&verify_code=${encodeURIComponent(action.verifyCode)}` : ''}`, undefined, signal, false);
    const result: Record<string, string> = { status: String(value.status ?? 'wait') };
    if (value.redirect_host) result.redirectHost = tencentUrl(value.redirect_host.includes('://') ? value.redirect_host : `https://${value.redirect_host}`);
    if (value.status === 'confirmed') {
      if (!value.bot_token || !value.ilink_bot_id) throw new Error('invalid_login_response');
      result.botToken = value.bot_token; result.botId = value.ilink_bot_id; result.baseUrl = tencentUrl(value.baseurl || DEFAULT);
    }
    return result;
  }
  async start(c: Record<string, string>, ctx: ChannelContext) {
    this.validate(c); if (!c.botToken) { ctx.health('login_required'); return; }
    let failures = 0;
    while (!ctx.signal.aborted) {
      try {
        const result = await this.request(c, '/ilink/bot/getupdates', { get_updates_buf: ctx.cursor() ?? '' }, AbortSignal.any([ctx.signal, AbortSignal.timeout(40_000)]));
        ctx.receive((result.msgs ?? []).map(normalizeIlink), typeof result.get_updates_buf === 'string' ? result.get_updates_buf : undefined);
        ctx.health('connected'); failures = 0;
        if (!result.msgs?.length) await delay(100, undefined, { signal: ctx.signal });
      } catch (e) {
        if (ctx.signal.aborted) return;
        if (e instanceof DeliveryError && e.code === 'login_required') { ctx.health('login_required'); return; }
        ctx.health('reconnecting');
        try { await delay(Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6)), undefined, { signal: ctx.signal }); } catch { return; }
      }
    }
  }
  async stop() { /* all I/O is scoped to ChannelContext.signal */ }
  async send(c: Record<string, string>, peer: GatewayEnvelope, payload: GatewayPayload, id: string, signal: AbortSignal) {
    if (!peer.context) throw new DeliveryError('context_required');
    let items: any[] = [{ type: 1, text_item: { text: payload.text } }];
    if (payload.fileId) {
      const f = await this.resolveFile(peer, payload.fileId);
      if (!f.bytes.length || f.bytes.length > 20 * 1024 * 1024) throw new DeliveryError('file_too_large');
      const key = crypto.randomBytes(16), cipher = crypto.createCipheriv('aes-128-ecb', key, null);
      const encrypted = Buffer.concat([cipher.update(f.bytes), cipher.final()]), fileKey = crypto.randomBytes(16).toString('hex');
      const image = /^image\/(png|jpeg|gif|webp)$/.test(f.mime);
      const upload = await this.request(c, '/ilink/bot/getuploadurl', { filekey: fileKey, media_type: image ? 1 : 3, to_user_id: peer.peer, rawsize: f.bytes.length, rawfilemd5: crypto.createHash('md5').update(f.bytes).digest('hex'), filesize: encrypted.length, no_need_thumb: true, aeskey: key.toString('hex') }, signal);
      const url = tencentUrl(upload.upload_full_url || `${CDN}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${fileKey}`, true);
      const r = await this.fetcher(url, { method: 'POST', body: encrypted, headers: { 'content-type': 'application/octet-stream' }, signal, redirect: 'error' });
      const param = r.headers.get('x-encrypted-param'); if (r.status !== 200 || !param) throw new DeliveryError('media_upload_failed');
      const media = { encrypt_query_param: param, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 };
      items = [image ? { type: 2, image_item: { media, mid_size: encrypted.length } } : { type: 4, file_item: { media, file_name: f.name, len: String(f.bytes.length) } }];
    }
    await this.request(c, '/ilink/bot/sendmessage', { msg: { from_user_id: '', to_user_id: peer.peer, client_id: id, message_type: 2, message_state: 2, context_token: peer.context, item_list: items } }, signal);
    return id;
  }
  async download(_c: Record<string, string>, _m: GatewayEnvelope, attachment: NonNullable<GatewayEnvelope['attachments']>[number], signal: AbortSignal) {
    const meta = attachment.metadata ?? {};
    const url = tencentUrl(meta.fullUrl || `${CDN}/download?encrypted_query_param=${encodeURIComponent(attachment.key)}`, true);
    const r = await this.fetcher(url, { signal, redirect: 'error' });
    const raw = await limitedBytes(r, 20 * 1024 * 1024 + 16);
    let bytes: Uint8Array = raw;
    if (meta.aesKey || meta.mediaKey) {
      let key = meta.aesKey ? Buffer.from(meta.aesKey, 'hex') : Buffer.from(meta.mediaKey, 'base64');
      if (key.length === 32 && /^[0-9a-f]+$/i.test(key.toString())) key = Buffer.from(key.toString(), 'hex');
      if (key.length !== 16) throw new Error('invalid_media_key');
      const cipher = crypto.createDecipheriv('aes-128-ecb', key, null); bytes = Buffer.concat([cipher.update(raw), cipher.final()]);
    } else if (!attachment.mime.startsWith('image/')) throw new Error('missing_media_key');
    if (bytes.length > 20 * 1024 * 1024) throw new Error('file_too_large');
    return { bytes, name: attachment.name, mime: mediaMime(bytes, attachment.mime) };
  }
}
