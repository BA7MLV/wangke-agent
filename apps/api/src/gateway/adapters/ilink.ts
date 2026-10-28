import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import type { GatewayConnectionError } from '@wangke/contracts/gateway';
import { mediaMime } from '../../cloud/image.js';
import { DeliveryError, type ChannelPlugin, type ChannelContext, type GatewayEnvelope, type GatewayPayload } from '../plugin.js';
import { limitedBytes, type FileResolver } from './feishu.js';
import { ilinkBackoffMs, parseIlinkJson, retryAfterMs } from './ilink-protocol.js';

const DEFAULT = 'https://ilinkai.weixin.qq.com';
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
const API_RESPONSE_LIMIT = 4 * 1024 * 1024;
const object = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value: any) => value === undefined || typeof value === 'string';

class IlinkRequestError extends DeliveryError {
  constructor(code: GatewayConnectionError['code'] | 'poll_timeout', uncertain = false, retryAfter = 0, retryable = true,
    readonly details: Omit<GatewayConnectionError, 'code'> = {}) { super(code, uncertain, retryAfter, retryable); }
}
interface IlinkRuntime {
  pollTimeoutMs: number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
  now(): number;
}
const runtime: IlinkRuntime = {
  pollTimeoutMs: 40_000, sleep: (ms, signal) => delay(ms, undefined, { signal }), random: Math.random, now: Date.now,
};
/** Credentials are only ever sent to Tencent's HTTPS API domain; CDN never gets bot headers. */
export function tencentUrl(value: string, cdn = false) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || (!cdn && (u.pathname !== '/' || u.search)) || !(cdn ? (u.hostname === 'cdn.weixin.qq.com' || u.hostname.endsWith('.cdn.weixin.qq.com')) : (u.hostname === 'ilinkai.weixin.qq.com' || u.hostname.endsWith('.ilinkai.weixin.qq.com')))) throw new Error('untrusted_platform_url');
  return u.href.replace(/\/$/, '');
}
export function normalizeIlink(m: any): GatewayEnvelope {
  if (!object(m)) throw new Error('invalid_platform_message');
  // The wire parser preserves uint64 IDs. Keep this guard for already-lossy callers.
  if (typeof m.message_id === 'number' && !Number.isSafeInteger(m.message_id)) throw new Error('unsafe_platform_message_id');
  if (!(m.message_id === undefined || typeof m.message_id === 'string' || typeof m.message_id === 'number') ||
      !optionalString(m.from_user_id) || !optionalString(m.context_token) || (m.item_list !== undefined && !Array.isArray(m.item_list))) throw new Error('invalid_platform_message');
  const attachments: NonNullable<GatewayEnvelope['attachments']> = [], texts: string[] = [];
  for (const item of m.item_list ?? []) {
    if (!object(item) || (item.text_item !== undefined && (!object(item.text_item) || !optionalString(item.text_item.text))) ||
        (item.voice_item !== undefined && (!object(item.voice_item) || !optionalString(item.voice_item.text)))) throw new Error('invalid_platform_message');
    if (item.text_item?.text) texts.push(String(item.text_item.text));
    if (item.voice_item?.text) texts.push(String(item.voice_item.text));
    const part = item.image_item ?? item.file_item;
    if (part !== undefined && (!object(part) || (part.media !== undefined && (!object(part.media) ||
        ![part.media.encrypt_query_param, part.media.full_url, part.media.aes_key, part.aeskey, part.file_name].every(optionalString))))) throw new Error('invalid_platform_message');
    if (part?.media) attachments.push({ key: part.media.encrypt_query_param ?? '', name: part.file_name ?? 'image.jpg', mime: item.image_item ? 'image/jpeg' : 'application/octet-stream', metadata: { fullUrl: part.media.full_url ?? '', aesKey: part.aeskey ?? '', mediaKey: part.media.aes_key ?? '' } });
  }
  return { messageId: m.message_id === undefined ? '' : String(m.message_id), tenant: '', peer: m.from_user_id ?? '', chat: m.from_user_id ?? '', topic: '', direct: !m.group_id, human: m.message_type === 1, text: texts.join('\n'), context: m.context_token, attachments };
}
export class IlinkPlugin implements ChannelPlugin {
  readonly manifest: ChannelPlugin['manifest'] = {
    id: 'ilink', version: 1, name: '微信 iLink',
    configFields: [
      { key: 'baseUrl', label: 'Base URL', secret: false, required: false, write: 'replace-or-preserve' },
      { key: 'botToken', label: 'Bot Token', secret: true, required: false, write: 'replace-or-preserve' },
      { key: 'botId', label: 'Bot ID', secret: false, required: false, write: 'replace-or-preserve' },
    ],
    loginSteps: [{ action: 'qr', label: 'QR', fields: [] }, { action: 'poll', label: 'Check login', fields: ['qrcode', 'redirectHost', 'verifyCode'] }],
    loginPublicFields: ['status', 'qrcode', 'qrDataUrl', 'redirectHost'],
    loginConfigFields: ['botToken', 'botId', 'baseUrl'],
    management: ['configure', 'pair', 'revoke', 'login', 'retry', 'discard'],
    capabilities: { direct: true, groups: false, images: true, files: true, proactive: 'context-dependent', deduplicationWindowMs: 0 },
  };
  private expired = false;
  private readonly runtime: IlinkRuntime;
  constructor(private resolveFile: FileResolver, private fetcher: typeof fetch = fetch, timing: Partial<IlinkRuntime> = {}) { this.runtime = { ...runtime, ...timing }; }
  validate(c: Record<string, string>) { if (c.baseUrl) tencentUrl(c.baseUrl); }
  private async request(c: Record<string, string>, path: string, body: any, signal: AbortSignal, authenticated = true, timeoutMs = 15_000): Promise<any> {
    signal.throwIfAborted();
    const url = `${tencentUrl(c.baseUrl || DEFAULT)}${path}`;
    const sending = path.endsWith('/sendmessage');
    const headers: Record<string, string> = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x02040a) };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers.AuthorizationType = 'ilink_bot_token'; headers['X-WECHAT-UIN'] = Buffer.from(String(crypto.randomInt(0, 2 ** 32))).toString('base64'); }
    if (authenticated) { if (!c.botToken || this.expired) throw new IlinkRequestError('login_required', false, 0, false); headers.Authorization = `Bearer ${c.botToken}`; }
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), timeoutMs);
    timer.unref();
    let response: Response | undefined;
    try {
      response = await this.fetcher(url, { method: body === undefined ? 'GET' : 'POST', headers,
        ...(body !== undefined ? { body: JSON.stringify(authenticated ? { ...body, base_info: { channel_version: '2.4.10', bot_agent: 'Wangke/1.0' } } : body) } : {}),
        signal: AbortSignal.any([signal, deadline.signal]), redirect: 'error' });
      const details = { httpStatus: response.status };
      if (response.status === 401 && authenticated) { this.expired = true; throw new IlinkRequestError('login_required', false, 0, false, details); }
      if (response.status === 429) throw new IlinkRequestError('rate_limited', false, retryAfterMs(response.headers.get('retry-after'), this.runtime.now()), true, details);
      if (!response.ok) throw new IlinkRequestError('platform_http_error', sending && (response.status >= 500 || response.status === 408), 0, response.status >= 500 || response.status === 408, details);
      let raw: Uint8Array;
      try { raw = await limitedBytes(response, API_RESPONSE_LIMIT); }
      catch (error) {
        if (error instanceof DeliveryError) throw new IlinkRequestError(error.code === 'file_too_large' || Number(response.headers.get('content-length')) > API_RESPONSE_LIMIT ? 'response_too_large' : 'invalid_platform_response', sending, 0, true, details);
        throw error;
      }
      let value: any;
      try { value = parseIlinkJson(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
      catch { throw new IlinkRequestError('invalid_platform_response', sending, 0, true, details); }
      if (!object(value) || ![value.ret, value.errcode].every(v => v === undefined || Number.isSafeInteger(v))) throw new IlinkRequestError('invalid_platform_response', sending, 0, true, details);
      if (value.ret === -14 || value.errcode === -14) {
        if (authenticated) this.expired = true;
        throw new IlinkRequestError('login_required', false, 0, false, { ...details, platformCode: -14 });
      }
      if (value.ret || value.errcode) throw new IlinkRequestError('platform_rejected', false, 0, true, { ...details, platformCode: value.errcode || value.ret });
      if (authenticated && this.expired) throw new IlinkRequestError('login_required', false, 0, false);
      signal.throwIfAborted();
      return value;
    } catch (error) {
      if (signal.aborted) throw new IlinkRequestError('request_timeout', sending);
      if (error instanceof IlinkRequestError) throw error;
      if (deadline.signal.aborted) {
        const idle = !response && (path.endsWith('/getupdates') || path.startsWith('/ilink/bot/get_qrcode_status?'));
        throw new IlinkRequestError(idle ? 'poll_timeout' : 'request_timeout', sending);
      }
      const code = (error as any)?.cause?.code;
      throw new IlinkRequestError(['ENOTFOUND', 'EAI_AGAIN'].includes(code) ? 'dns_error'
        : typeof code === 'string' && /CERT|TLS|SSL/.test(code) ? 'tls_error' : 'network_error', sending);
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
  async login(c: Record<string, string>, action: Record<string, string>, signal: AbortSignal) {
    if (action.action === 'qr') {
      const value = await this.request({ ...c, baseUrl: DEFAULT }, '/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: c.botToken && !this.expired ? [c.botToken] : [] }, signal, false);
      if (typeof value.qrcode !== 'string' || !value.qrcode || value.qrcode.length > 4096 || typeof value.qrcode_img_content !== 'string' || !value.qrcode_img_content) throw new Error('invalid_qrcode');
      return { status: 'wait', qrcode: String(value.qrcode), qrDataUrl: await QRCode.toDataURL(String(value.qrcode_img_content), { width: 300, errorCorrectionLevel: 'M' }) };
    }
    if (action.action !== 'poll' || !action.qrcode || action.qrcode.length > 4096) throw new Error('invalid_login_action');
    const base = action.redirectHost ? tencentUrl(action.redirectHost.includes('://') ? action.redirectHost : `https://${action.redirectHost}`) : DEFAULT;
    /*
     * get_qrcode_status 是长轮询：扫码 / 确认 / 过期前服务端一直挂着。客户端用 30 秒上限
     * 自己收线，到点当作「还在等」返回，网页立即发起下一轮 —— 而不是把超时当错误抛给用户，
     * 也不需要用户手动点「检查状态」。调用方自己取消（关掉弹窗）时照常中断。
     */
    let value: any;
    try {
      value = await this.request({ ...c, baseUrl: base }, `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(action.qrcode)}${action.verifyCode ? `&verify_code=${encodeURIComponent(action.verifyCode)}` : ''}`, undefined, signal, false, 30_000);
    } catch (error) {
      if (signal.aborted || !(error instanceof IlinkRequestError) || error.code !== 'poll_timeout') throw error;
      return { status: 'wait', ...(action.redirectHost ? { redirectHost: base } : {}) };
    }
    if (!['wait', 'scaned', 'confirmed', 'expired', 'need_verifycode', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect'].includes(value.status)) throw new IlinkRequestError('invalid_platform_response');
    const result: Record<string, string> = { status: value.status };
    if (value.redirect_host) result.redirectHost = tencentUrl(value.redirect_host.includes('://') ? value.redirect_host : `https://${value.redirect_host}`);
    if (value.status === 'confirmed') {
      if (typeof value.bot_token !== 'string' || !value.bot_token || typeof value.ilink_bot_id !== 'string' || !value.ilink_bot_id) throw new Error('invalid_login_response');
      result.botToken = value.bot_token; result.botId = value.ilink_bot_id; result.baseUrl = tencentUrl(value.baseurl || DEFAULT);
    }
    return result;
  }
  async start(c: Record<string, string>, ctx: ChannelContext) {
    this.validate(c); if (!c.botToken) { ctx.health('login_required'); return; }
    ctx.health('connecting');
    let failures = 0, pollTimeout = this.runtime.pollTimeoutMs;
    while (!ctx.signal.aborted) {
      let receiving = false;
      try {
        const result = await this.request(c, '/ilink/bot/getupdates', { get_updates_buf: ctx.cursor() ?? '' }, ctx.signal, true, pollTimeout);
        if ((result.msgs !== undefined && !Array.isArray(result.msgs)) || !optionalString(result.get_updates_buf)) throw new IlinkRequestError('invalid_platform_response');
        // 服务端可以下发建议的长轮询时长；客户端超时总比它多留 5 秒余量，免得把正常挂起当成断线。
        if (Number.isFinite(result.longpolling_timeout_ms) && result.longpolling_timeout_ms > 0) pollTimeout = Math.min(120_000, Math.max(10_000, Number(result.longpolling_timeout_ms) + 5_000));
        const batch = (result.msgs ?? []).map(normalizeIlink);
        ctx.signal.throwIfAborted();
        receiving = true;
        // Empty/missing cursors do not reset durable progress. Commit only after the entire batch is accepted.
        ctx.receive(batch, result.get_updates_buf || undefined);
        receiving = false;
        ctx.health('connected', { consecutiveFailures: 0 }); failures = 0;
        if (!result.msgs?.length) await this.runtime.sleep(100, ctx.signal);
      } catch (e) {
        if (ctx.signal.aborted) return;
        // An idle long poll is normal; it proves neither a failed nor a successful connection.
        if (e instanceof IlinkRequestError && e.code === 'poll_timeout') continue;
        const error: GatewayConnectionError = e instanceof IlinkRequestError
          ? { code: e.code as GatewayConnectionError['code'], ...e.details }
          : { code: receiving ? (e instanceof Error && e.message === 'gateway_inbox_capacity' ? 'inbox_capacity' : 'receive_failed')
            : e instanceof Error && e.message === 'unsafe_platform_message_id' ? 'unsafe_platform_message_id' : 'invalid_platform_message' };
        const retryable = !(e instanceof DeliveryError) || e.retryable;
        const wait = ilinkBackoffMs(++failures, e instanceof DeliveryError ? e.retryAfterMs : 0, this.runtime.random);
        const state = error.code === 'login_required' ? 'login_required' : receiving ? 'inbound_failed'
          : !retryable || ['invalid_platform_response', 'invalid_platform_message', 'unsafe_platform_message_id', 'response_too_large'].includes(error.code) ? 'connection_failed' : 'reconnecting';
        ctx.health(state, { error, consecutiveFailures: failures, ...(retryable ? { retryAt: this.runtime.now() + wait } : {}) });
        if (!retryable) return;
        try { await this.runtime.sleep(wait, ctx.signal); } catch { return; }
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
      if (!(typeof upload.upload_full_url === 'string' && upload.upload_full_url) && !(typeof upload.upload_param === 'string' && upload.upload_param)) throw new DeliveryError('invalid_platform_response');
      const url = tencentUrl(upload.upload_full_url || `${CDN}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${fileKey}`, true);
      let r: Response | undefined, param: string;
      const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 15_000); timer.unref();
      try {
        r = await this.fetcher(url, { method: 'POST', body: encrypted, headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.any([signal, deadline.signal]), redirect: 'error' });
        if (r.status === 429) throw new DeliveryError('rate_limited', false, retryAfterMs(r.headers.get('retry-after'), this.runtime.now()));
        param = r.headers.get('x-encrypted-param') ?? '';
        if (r.status !== 200 || !param) throw new DeliveryError('media_upload_failed');
      } catch (error) {
        // No sendmessage request has started: retrying an upload cannot duplicate a chat message.
        throw error instanceof DeliveryError ? error : new DeliveryError('media_upload_failed');
      } finally { clearTimeout(timer); await r?.body?.cancel().catch(() => {}); }
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
