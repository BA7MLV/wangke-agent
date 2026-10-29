import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfiguration } from '../cloud/config.js';
import type { BotApplicationService } from '../agent/service.js';
import { fileOperationId, receiveFile } from '../cloud/files.js';
import { DeliveryError, type ChannelPlugin, type GatewayEnvelope, type GatewayPayload } from './plugin.js';
import { cleanupGateway, gatewayLimits } from './retention.js';
import { publishBotEvent } from '../agent/events.js';
import { GATEWAY_CONNECTION_ERRORS, type GatewayConnectionDiagnostics, type GatewayReadiness } from '@wangke/contracts/gateway';

const stamp = () => new Date().toISOString();
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
/**
 * 绑定码：8 位 Crockford Base32（不含 I/L/O/U，约 40 bit）。
 * 码要在手机上读一眼就能输入或粘贴，32 位十六进制做不到；同一账号同时只有一个码、
 * 10 分钟过期、只能从该渠道的本人私聊提交，这个熵足够。比较时忽略大小写与空白。
 */
const PAIR_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const pairCode = () => Array.from(crypto.randomBytes(8), byte => PAIR_ALPHABET[byte % 32]).join('');
const pairHash = (code: string) => hash(code.replace(/[\s-]/g, '').toUpperCase());
type ApprovalReply = { id?: string; approved: boolean };
type InboundEnvelope = GatewayEnvelope & { approvalReply?: ApprovalReply };
const approvalPrompt = (content: string, number: number) => {
  // Old shell approval records contain source code; only show their purpose.
  const text = content.startsWith('请求执行命令') ? '需要你的确认：在工作区运行程序，处理当前任务。是否允许这次操作？' : content;
  return `待确认 ${number}\n${text}\n只有这一项时，回复“同意”或“拒绝”即可。也可回复“同意 ${number}”或“拒绝 ${number}”。`;
};
export type PluginFactory = (account?: { id: string; owner_id: string }) => ChannelPlugin;
/** Single-instance durable gateway. ACK only includes the synchronous receive transaction. */
export class GatewayCore {
  private live = new Map<string, { plugin: ChannelPlugin; controller: AbortController }>();
  private connections = new Map<string, GatewayConnectionDiagnostics>();
  private work = new Set<Promise<unknown>>();
  private inbound = new Map<number, { binding: string; controller: AbortController }>();
  private logins = new Map<string, AbortController>();
  private restartAfter = new Map<string, number>();
  private changing = new Set<string>();
  // A pass owns only scheduling/projection/delivery, not attachment workers.
  // Identity prevents an older tick's finally from releasing a newer pass.
  private busy?: symbol;
  private processingAccounts = new Set<string>();
  private cleanupAt = 0;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(readonly store: DatabaseStore, readonly secrets: CloudConfiguration, readonly bot: BotApplicationService,
    readonly factories: Record<string, PluginFactory>, readonly filesDir: string) {}
  account(owner: string, id: string): any {
    const row = this.store.db.prepare('SELECT * FROM gateway_accounts WHERE id=? AND owner_id=?').get(id, owner);
    if (!row) throw new Error('account_not_found'); return row;
  }
  config(account: any): Record<string, string> { return JSON.parse(this.secrets.open(account.config)); }
  list(owner: string) {
    const model = this.secrets.get(owner);
    const modelConfigured = Boolean(model.llmModel.model && model.providers.some(p => p.id === model.llmModel.providerId && p.baseUrl && p.serves.includes('chat')));
    return (this.store.db.prepare('SELECT id,channel,agent_id AS agentId,enabled,preset,health,created_at AS createdAt FROM gateway_accounts WHERE owner_id=? ORDER BY created_at,id').all(owner) as any[]).map(a => ({ ...a,
      readiness: this.readiness(a, modelConfigured),
      connection: this.connections.get(a.id),
      manifest: this.factories[a.channel]?.().manifest,
      configuration: Object.fromEntries((this.factories[a.channel]?.().manifest.configFields ?? []).map(field => { const config = this.config(this.account(owner, a.id)); return [field.key, field.secret ? { configured: Boolean(config[field.key]) } : { value: config[field.key] ?? '' }]; })),
      pressure: this.store.db.prepare("SELECT (SELECT COUNT(*) FROM gateway_inbox WHERE account_id=? AND status='pending') AS inbox,(SELECT COUNT(*) FROM gateway_outbox o JOIN gateway_bindings b ON b.id=o.binding_id WHERE b.account_id=? AND o.status IN ('pending','sending','failed','uncertain')) AS outbox").get(a.id, a.id),
      bindings: this.store.db.prepare('SELECT id,tenant,peer,chat,thread_id AS threadId,revoked FROM gateway_bindings WHERE account_id=?').all(a.id),
    }));
  }
  private readiness(a: any, modelConfigured: boolean): GatewayReadiness {
    const agent = this.store.db.prepare('SELECT name,enabled FROM agent_profiles WHERE id=?').get(a.agentId) as any;
    const bound = Boolean(this.store.db.prepare('SELECT 1 FROM gateway_bindings WHERE account_id=? AND revoked=0').get(a.id));
    const inbox = this.store.db.prepare("SELECT MAX(received_at) lastInboundAt,COUNT(CASE WHEN status='failed' THEN 1 END) failures FROM gateway_inbox WHERE account_id=?").get(a.id) as any;
    const outbox = this.store.db.prepare("SELECT COUNT(*) failures FROM gateway_outbox o JOIN gateway_bindings b ON b.id=o.binding_id WHERE b.account_id=? AND b.revoked=0 AND o.status IN ('failed','uncertain')").get(a.id) as any;
    const projection = this.store.db.prepare('SELECT COUNT(*) n FROM gateway_projection_failures f JOIN gateway_bindings b ON b.id=f.binding_id WHERE b.account_id=? AND b.revoked=0').get(a.id) as any;
    const latestRun = this.store.db.prepare('SELECT r.status,r.error_code AS errorCode FROM runs r JOIN gateway_bindings b ON b.thread_id=r.thread_id WHERE b.account_id=? AND b.revoked=0 ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1').get(a.id) as GatewayReadiness['latestRun'] | undefined;
    const connected = a.health === 'connected', botEnabled = Boolean(agent?.enabled);
    const state: GatewayReadiness['state'] = !a.enabled ? 'disabled' : a.health === 'login_required' ? 'login_required' : !connected ? 'connection_required'
      : !bound ? 'binding_required' : !botEnabled ? 'bot_required' : !modelConfigured ? 'model_required'
      : outbox.failures || inbox.failures || projection.n || latestRun && ['failed', 'waiting_user', 'paused'].includes(latestRun.status) ? 'attention' : 'ready';
    return { state, connected, bound, botEnabled, modelConfigured, botName: agent?.name ?? '', lastInboundAt: inbox.lastInboundAt,
      deliveryFailures: outbox.failures, inboxFailures: inbox.failures, projectionFailures: projection.n, latestRun: latestRun ?? null };
  }
  /** One platform identity, one consumer; checking all owners also avoids cross-owner event theft. */
  private assertUnique(channel: string, config: Record<string, string>, except?: string) {
    for (const account of this.store.db.prepare('SELECT * FROM gateway_accounts WHERE channel=? AND id<>?').all(channel, except ?? '') as any[]) {
      const other = this.config(account);
      const duplicate = channel === 'ilink'
        ? config.botId && config.botId === other.botId || config.botToken && config.botToken === other.botToken
        : channel === 'feishu' && config.appId && config.appId === other.appId;
      if (duplicate) throw new Error('duplicate_channel_account');
    }
  }
  async save(owner: string, value: { id?: string; channel: string; agentId: string; enabled: boolean; preset?: string; config?: Record<string, string> }) {
    if (!this.factories[value.channel] || !['inherit', 'autonomous'].includes(value.preset ?? 'inherit') || typeof value.enabled !== 'boolean') throw new Error('invalid_account');
    if (!this.store.db.prepare('SELECT 1 FROM agent_profiles WHERE id=? AND owner_id=? AND (enabled=1 OR ?=0)').get(value.agentId, owner, Number(value.enabled))) throw new Error('agent_not_found');
    const old = value.id ? this.account(owner, value.id) : null;
    if (old && old.channel !== value.channel) throw new Error('channel_immutable');
    const fields = this.factories[value.channel]().manifest.configFields;
    if (value.config !== undefined && (!value.config || typeof value.config !== 'object' || Array.isArray(value.config))) throw new Error('invalid_config');
    const supplied = Object.fromEntries(Object.entries(value.config ?? {}).filter(([key, value]) => value !== '' || !fields?.some(field => field.key === key && field.secret)));
    const config = { ...(old ? this.config(old) : {}), ...supplied };
    if (old && value.channel === 'ilink' && this.config(old).botId && config.botId !== this.config(old).botId) throw new Error('channel_identity_changed');
    if (fields && Object.keys(config).some(key => !fields.some(field => field.key === key))) throw new Error('unknown_channel_config_field');
    if (Object.values(config).some(v => typeof v !== 'string' || v.length > 16384)) throw new Error('invalid_config');
    this.factories[value.channel]().validate(config);
    const id = old?.id ?? crypto.randomUUID();
    this.assertUnique(value.channel, config, id);
    if (this.changing.has(id)) throw new Error('channel_busy');
    this.changing.add(id);
    try {
      await this.stop(id);
      // stop awaits plugin cleanup. Recheck identity and existence after that yield.
      if (old) this.account(owner, id);
      this.assertUnique(value.channel, config, id);
      this.store.transaction(() => {
        this.store.db.prepare(`INSERT INTO gateway_accounts(id,owner_id,channel,agent_id,enabled,preset,config,created_at) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET agent_id=excluded.agent_id,enabled=excluded.enabled,preset=excluded.preset,config=excluded.config`)
          .run(id, owner, value.channel, value.agentId, Number(value.enabled), value.preset ?? 'inherit', this.secrets.seal(JSON.stringify(config)), stamp());
        if (old && (!value.enabled || old.agent_id !== value.agentId || old.preset !== (value.preset ?? 'inherit'))) {
          for (const b of this.store.db.prepare('SELECT thread_id FROM gateway_bindings WHERE account_id=? AND revoked=0').all(id) as any[]) {
            this.bot.stop(owner, b.thread_id);
            this.store.db.prepare('DELETE FROM thread_participants WHERE thread_id=?').run(b.thread_id);
            this.store.db.prepare('INSERT INTO thread_participants(thread_id,agent_id,joined_at) VALUES(?,?,?)').run(b.thread_id, value.agentId, stamp());
          }
        }
        this.secrets.audit(owner, 'gateway.configured', { id, channel: value.channel, enabled: value.enabled, preset: value.preset });
      });
    } finally { this.changing.delete(id); }
    if (value.enabled) this.launch(id);
    return { id };
  }
  pair(owner: string, id: string) {
    this.account(owner, id);
    const code = pairCode(), expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.store.db.prepare('INSERT INTO gateway_pairings(account_id,code_hash,expires_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at').run(id, pairHash(code), expiresAt);
    return { command: `/pair ${code}`, code, expiresAt };
  }
  revoke(owner: string, id: string, binding: string) {
    this.account(owner, id);
    const b = this.store.db.prepare('SELECT * FROM gateway_bindings WHERE id=? AND account_id=?').get(binding, id) as any;
    if (!b) throw new Error('binding_not_found');
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM gateway_pairings WHERE account_id=?').run(id);
      for (const pending of this.store.db.prepare("SELECT id,envelope FROM gateway_inbox WHERE account_id=? AND status='pending'").all(id) as any[]) {
        try {
          const m: GatewayEnvelope = JSON.parse(this.secrets.open(pending.envelope));
          if (m.text.trimStart().startsWith('/pair ')) this.store.db.prepare("UPDATE gateway_inbox SET status='cancelled',error='pairing_revoked' WHERE id=?").run(pending.id);
        } catch { this.store.db.prepare("UPDATE gateway_inbox SET status='failed',error='invalid_inbound_envelope' WHERE id=?").run(pending.id); }
      }
      this.store.db.prepare('UPDATE gateway_bindings SET revoked=1,context=NULL WHERE id=?').run(binding);
      this.store.db.prepare("UPDATE gateway_outbox SET status='uncertain',error='revoked_during_send' WHERE binding_id=? AND status='sending'").run(binding);
      this.store.db.prepare("UPDATE gateway_outbox SET status='cancelled' WHERE binding_id=? AND status='pending'").run(binding);
      this.store.db.prepare("UPDATE bot_reminders SET status='cancelled' WHERE thread_id=?").run(b.thread_id);
      this.bot.stop(owner, b.thread_id);
    });
    for (const active of this.inbound.values()) if (active.binding === binding) active.controller.abort();
    // An in-flight send/download must not continue using a revoked authority.
    this.track(this.stop(id).then(() => { if (!this.stopped) this.launch(id); }));
    this.secrets.audit(owner, 'gateway.revoked', { id, binding });
  }
  async remove(owner: string, id: string) {
    const account = this.account(owner, id);
    if (this.changing.has(id)) throw new Error('channel_busy');
    this.changing.add(id);
    try {
      // Delete atomically before yielding: no scheduler, pairing or late login can revive it.
      this.store.transaction(() => {
        for (const binding of this.store.db.prepare('SELECT thread_id FROM gateway_bindings WHERE account_id=?').all(id) as any[]) {
          this.bot.stop(owner, binding.thread_id);
          this.store.db.prepare("UPDATE bot_reminders SET status='cancelled' WHERE thread_id=? AND status='active'").run(binding.thread_id);
        }
        this.store.db.prepare('DELETE FROM gateway_accounts WHERE id=? AND owner_id=?').run(id, owner);
        this.secrets.audit(owner, 'gateway.removed', { id, channel: account.channel });
      });
      await this.stop(id);
      this.connections.delete(id); this.restartAfter.delete(id);
      return { removed: true };
    } finally { this.changing.delete(id); }
  }
  start(automatic = true) {
    this.stopped = false;
    // A process can die after remote acceptance. Never blindly replay an uncertain send.
    this.store.db.prepare("UPDATE gateway_outbox SET status='uncertain',error='process_interrupted_after_send_started' WHERE status='sending'").run();
    for (const a of this.store.db.prepare('SELECT id FROM gateway_accounts WHERE enabled=1').all() as any[]) this.launch(a.id);
    if (automatic) { this.timer = setInterval(() => this.scheduleTick(), 500); this.timer.unref(); this.scheduleTick(); }
  }
  private scheduleTick() { void this.tick().catch(() => this.runtimeFailure()); }
  private runtimeFailure() {
    // Do not persist exception messages: SDK errors may contain credentials or incoming data.
    try { this.store.db.prepare("UPDATE gateway_accounts SET health='runtime_failed' WHERE enabled=1").run(); }
    catch { console.error('gateway_runtime_failed'); }
  }
  private inboxFailure(account: string) {
    // Attach this boundary when starting the worker, before awaiting any send.
    // Even failure reporting must be non-rejecting and must not poison peers.
    try { this.store.db.prepare("UPDATE gateway_accounts SET health='inbound_failed' WHERE id=?").run(account); }
    catch { console.error('gateway_inbox_worker_failed'); }
  }
  private connectionHealth(id: string, state: string, detail?: Pick<GatewayConnectionDiagnostics, 'error' | 'consecutiveFailures' | 'retryAt'>) {
    const previous = this.connections.get(id), now = Date.now();
    const number = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
    const supplied = detail?.error;
    // Whitelist values again at the plugin boundary. No exception text or platform errmsg.
    const error = supplied && GATEWAY_CONNECTION_ERRORS.includes(supplied.code) ? {
      code: supplied.code,
      ...(number(supplied.httpStatus) && supplied.httpStatus >= 100 && supplied.httpStatus <= 599 ? { httpStatus: supplied.httpStatus } : {}),
      ...(number(supplied.platformCode) ? { platformCode: supplied.platformCode } : {}),
    } : undefined;
    const value: GatewayConnectionDiagnostics = {
      updatedAt: now,
      ...(state === 'connected' ? { lastSuccessAt: now } : previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
      consecutiveFailures: number(detail?.consecutiveFailures) ? Math.max(0, detail.consecutiveFailures) : 0,
      ...(number(detail?.retryAt) && detail.retryAt > now ? { retryAt: detail.retryAt } : {}),
      ...(error ? { error } : {}),
    };
    if (!this.store.db.prepare('UPDATE gateway_accounts SET health=? WHERE id=?').run(state, id).changes) return;
    this.connections.set(id, value);
    if (error && (JSON.stringify(error) !== JSON.stringify(previous?.error) || value.consecutiveFailures > 0 && Number.isInteger(Math.log2(value.consecutiveFailures)))) {
      console.warn('gateway_connection', JSON.stringify({ accountId: id, state, ...value }));
    }
  }
  private launch(id: string) {
    if (this.stopped || this.live.has(id) || this.changing.has(id)) return;
    const a = this.store.db.prepare('SELECT * FROM gateway_accounts WHERE id=?').get(id) as any;
    if (!a?.enabled) return;
    try { this.assertUnique(a.channel, this.config(a), id); }
    catch {
      this.restartAfter.set(id, Date.now() + 30_000);
      this.connectionHealth(id, 'connection_failed', { error: { code: 'duplicate_channel_account' }, consecutiveFailures: 1 }); return;
    }
    let plugin: ChannelPlugin;
    try { plugin = this.factories[a.channel](a); }
    catch {
      this.restartAfter.set(id, Date.now() + 30_000);
      this.store.db.prepare("UPDATE gateway_accounts SET health='connection_failed' WHERE id=?").run(id); return;
    }
    const controller = new AbortController();
    this.live.set(id, { plugin, controller });
    const task = Promise.resolve().then(() => plugin.start(this.config(a), {
      signal: controller.signal,
      receive: (batch, cursor) => { controller.signal.throwIfAborted(); this.receive(id, batch, cursor); },
      cursor: () => (this.store.db.prepare('SELECT cursor FROM gateway_accounts WHERE id=?').get(id) as any)?.cursor ?? undefined,
      updateConfig: patch => {
        if (controller.signal.aborted) return;
        const current = this.store.db.prepare('SELECT * FROM gateway_accounts WHERE id=?').get(id);
        this.store.db.prepare('UPDATE gateway_accounts SET config=? WHERE id=?').run(this.secrets.seal(JSON.stringify({ ...this.config(current), ...patch })), id);
      },
      health: (state, detail) => { if (!controller.signal.aborted) this.connectionHealth(id, state, detail); },
    })).catch(async () => {
      if (controller.signal.aborted) return;
      controller.abort();
      if (this.live.get(id)?.controller === controller) {
        this.live.delete(id); this.restartAfter.set(id, Date.now() + 30_000);
        try { this.store.db.prepare("UPDATE gateway_accounts SET health='connection_failed' WHERE id=?").run(id); } catch { this.runtimeFailure(); }
      }
      await Promise.race([Promise.resolve().then(() => plugin.stop()).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]);
    });
    this.track(task);
  }
  private track(task: Promise<unknown>) { this.work.add(task); void task.then(() => this.work.delete(task), () => this.work.delete(task)); }
  async stop(id: string) {
    this.logins.get(id)?.abort(); this.logins.delete(id);
    const live = this.live.get(id); this.live.delete(id);
    live?.controller.abort();
    if (live) await Promise.race([Promise.resolve().then(() => live.plugin.stop()).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]);
    if (!this.live.has(id)) this.connectionHealth(id, 'stopped');
  }
  async close() {
    this.stopped = true; clearInterval(this.timer);
    for (const controller of this.logins.values()) controller.abort();
    for (const active of this.inbound.values()) active.controller.abort();
    await Promise.allSettled([...this.live.keys()].map(id => this.stop(id)));
    // Workers are tracked independently of the pass that launched them, even
    // when projection/delivery fails before that pass can await its workers.
    while (this.work.size) await Promise.allSettled([...this.work]);
  }
  async login(owner: string, id: string, action: Record<string, string>, externalSignal?: AbortSignal) {
    if (this.changing.has(id)) throw new Error('channel_busy');
    const a = this.account(owner, id), live = this.live.get(id);
    const plugin = live?.plugin ?? this.factories[a.channel](a);
    if (!plugin.login) throw new Error('login_not_supported');
    if (!action || typeof action !== 'object' || Object.values(action).some(value => typeof value !== 'string' || value.length > 16384)) throw new Error('invalid_channel_login_action');
    const step = plugin.manifest.loginSteps?.find(step => step.action === action.action);
    if (plugin.manifest.loginSteps && (!step || Object.keys(action).some(key => key !== 'action' && !step.fields.includes(key)))) throw new Error('invalid_channel_login_action');
    this.logins.get(id)?.abort();
    const controller = new AbortController(); this.logins.set(id, controller);
    const signal = AbortSignal.any([controller.signal, live?.controller.signal ?? controller.signal, externalSignal ?? controller.signal, AbortSignal.timeout(40_000)]);
    let result: Record<string, string>;
    try {
      signal.throwIfAborted();
      result = await plugin.login(this.config(a), action, signal);
      signal.throwIfAborted();
    } finally { if (this.logins.get(id) === controller) this.logins.delete(id); }
    if (!result || Object.keys(result).length > 20 || Object.values(result).some(value => typeof value !== 'string' || value.length > 128000)) throw new Error('invalid_channel_login_result');
    const loginConfig = Object.fromEntries(Object.entries(result).filter(([key]) => plugin.manifest.loginConfigFields?.includes(key)));
    if (Object.keys(loginConfig).length) {
      const config = { ...this.config(a), ...loginConfig }; plugin.validate(config);
      if (a.channel === 'ilink' && this.config(a).botId && config.botId !== this.config(a).botId) throw new Error('channel_identity_changed');
      this.account(owner, id);
      this.assertUnique(a.channel, config, id);
      this.changing.add(id);
      try {
        this.store.db.prepare('UPDATE gateway_accounts SET config=? WHERE id=?').run(this.secrets.seal(JSON.stringify(config)), id);
        await this.stop(id);
      } finally { this.changing.delete(id); }
      if (a.enabled) this.launch(id);
    }
    return Object.fromEntries(Object.entries(result).filter(([key]) => plugin.manifest.loginPublicFields?.includes(key) && !plugin.manifest.loginConfigFields?.includes(key)));
  }
  receive(id: string, batch: GatewayEnvelope[], cursor?: string) {
    const a = this.store.db.prepare('SELECT * FROM gateway_accounts WHERE id=?').get(id) as any;
    if (!a?.enabled || this.stopped) throw new Error('gateway_account_disabled');
    this.store.transaction(() => {
      for (const message of batch) {
        if (!message.direct || !message.human || !message.messageId || !message.peer) continue;
        if (typeof message.text !== 'string' || message.text.length > 100000) throw new Error('gateway_envelope_too_large');
        const external = JSON.stringify([message.tenant, message.messageId]);
        if (this.store.db.prepare('SELECT 1 FROM gateway_inbox WHERE account_id=? AND external_id=?').get(id, external)) continue;
        const capacity = this.store.db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending FROM gateway_inbox WHERE account_id=?").get(id) as { total: number; pending: number };
        if (capacity.total >= gatewayLimits().dedupe || capacity.pending >= gatewayLimits().pending && message.text.trim() !== '/stop') throw new Error('gateway_inbox_capacity');
        if (JSON.stringify(message).length > 128000) throw new Error('gateway_envelope_too_large');
        const b = this.binding(id, message);
        // Capture the exact approval when the reply arrives, not after queued
        // downloads/model work. A delayed "同意" must never approve a newer ask.
        const envelope: InboundEnvelope = { ...message, approvalReply: b && !b.revoked && !message.attachments?.length ? this.approvalReply(b, message.text) : undefined };
        const inserted = this.store.db.prepare('INSERT OR IGNORE INTO gateway_inbox(account_id,external_id,envelope,received_at) VALUES(?,?,?,?)').run(id, external, this.secrets.seal(JSON.stringify(envelope)), Date.now());
        if (!inserted.changes) continue;
        // Control path never waits behind media, model, or another inbox item.
        if (b && !b.revoked && message.text.trim() === '/stop') {
          if (message.context) this.store.db.prepare('UPDATE gateway_bindings SET context=? WHERE id=?').run(this.secrets.seal(message.context), b.id);
          this.bot.stop(a.owner_id, b.thread_id);
          for (const pending of this.store.db.prepare("SELECT id,envelope FROM gateway_inbox WHERE account_id=? AND status='pending' AND id<?").all(id, inserted.lastInsertRowid) as any[]) {
            const envelope: GatewayEnvelope = JSON.parse(this.secrets.open(pending.envelope));
            if (envelope.tenant === message.tenant && envelope.peer === message.peer && envelope.chat === message.chat && envelope.topic === message.topic) this.store.db.prepare("UPDATE gateway_inbox SET status='cancelled' WHERE id=?").run(pending.id);
          }
          for (const active of this.inbound.values()) if (active.binding === b.id) active.controller.abort();
          this.store.db.prepare("UPDATE gateway_inbox SET status='done' WHERE id=?").run(inserted.lastInsertRowid);
        }
      }
      if (cursor !== undefined) this.store.db.prepare('UPDATE gateway_accounts SET cursor=? WHERE id=?').run(cursor, id);
    });
  }
  private binding(id: string, m: GatewayEnvelope): any {
    return this.store.db.prepare('SELECT * FROM gateway_bindings WHERE account_id=? AND tenant=? AND peer=? AND chat=? AND topic=?').get(id, m.tenant, m.peer, m.chat, m.topic);
  }
  private approvalReply(binding: any, text: string): ApprovalReply | undefined {
    const exact = /^(\/?approve|\/?reject|批准|同意|拒绝)\s+([\w-]{1,100})$/i.exec(text.trim().replace(/[。！!]+$/, ''));
    if (exact) {
      const approved = !/reject|拒绝/i.test(exact[1]);
      if (!/^\d+$/.test(exact[2])) return { id: exact[2], approved }; // Legacy full IDs remain supported.
      // Message sequence numbers are stable within a thread, never a changing list index.
      const a = this.store.db.prepare(`SELECT a.id FROM approvals a JOIN messages m ON m.id=a.message_id
        WHERE a.thread_id=? AND m.seq=?`).get(binding.thread_id, exact[2]) as { id: string } | undefined;
      return { id: a?.id ?? 'unknown-approval-number', approved };
    }
    const word = text.trim().replace(/[。！!]+$/, '').toLowerCase();
    const yes = ['同意', '批准', '允许', '确认', 'approve', '/approve'];
    const no = ['拒绝', '不同意', '不允许', 'reject', '/reject'];
    if (!yes.includes(word) && !no.includes(word)) return undefined;
    const pending = this.store.db.prepare(`SELECT a.id,m.content,m.seq,e.event_id FROM approvals a JOIN messages m ON m.id=a.message_id
      JOIN message_events e ON e.thread_id=m.thread_id AND e.seq=m.seq AND e.type='message.accepted'
       WHERE a.thread_id=? AND a.status='pending' ORDER BY m.seq LIMIT 2`).all(binding.thread_id) as { id: string; content: string; seq: number; event_id: number }[];
    if (!pending.length && !word.startsWith('/')) return undefined;
    const approved = yes.includes(word);
    if (pending.length !== 1) return { approved };
    const lastPart = Math.ceil(Array.from(approvalPrompt(pending[0].content, pending[0].seq)).length / 1500) - 1;
    const promptId = hash(`${binding.id}:event:${pending[0].event_id}:${lastPart}`).slice(0, 32);
    const delivered = this.store.db.prepare("SELECT 1 FROM gateway_outbox WHERE id=? AND status='sent'").get(promptId);
    return { approved, ...(delivered ? { id: pending[0].id } : {}) };
  }
  async tick() {
    if (this.stopped || this.busy) return;
    const gate = Symbol('gateway-pass'); this.busy = gate;
    const task = this.process(gate).catch(() => this.runtimeFailure()).finally(() => { if (this.busy === gate) this.busy = undefined; }); this.track(task); await task;
  }
  private async process(gate: symbol) {
    if (Date.now() >= this.cleanupAt) { cleanupGateway(this.store); this.cleanupAt = Date.now() + 60000; }
    for (const a of this.store.db.prepare('SELECT id FROM gateway_accounts WHERE enabled=1').all() as any[]) {
      if (!this.live.has(a.id) && (this.restartAfter.get(a.id) ?? 0) <= Date.now()) this.launch(a.id);
    }
    this.reminders();
    // Small bounded batch; network has a timeout and stop/revoke aborts it.
    const rows = this.store.db.prepare("SELECT * FROM (SELECT i.*,a.owner_id,a.agent_id,a.enabled,ROW_NUMBER() OVER(PARTITION BY i.account_id ORDER BY i.id) AS position FROM gateway_inbox i JOIN gateway_accounts a ON a.id=i.account_id WHERE i.status='pending' AND a.enabled=1 AND i.account_id NOT IN (SELECT value FROM json_each(?))) WHERE position<=10 ORDER BY id LIMIT 40").all(JSON.stringify([...this.processingAccounts])) as any[];
    const groups = new Map<string, any[]>();
    for (const row of rows) { const group = groups.get(row.account_id) ?? []; group.push(row); groups.set(row.account_id, group); }
    const tasks: Promise<void>[] = [];
    for (const [account, group] of groups) {
      if (this.processingAccounts.size >= 4) break;
      this.processingAccounts.add(account);
      const worker = this.processInbox(group).catch(() => this.inboxFailure(account)).finally(() => this.processingAccounts.delete(account));
      this.track(worker);
      tasks.push(worker);
    }
    this.project();
    await this.deliver();
    // Network attachment I/O owns only its account, not the scheduler. Another
    // tick may admit other accounts while these bounded workers are awaiting.
    if (this.busy === gate) this.busy = undefined;
    await Promise.all(tasks);
    // Reacquire the pass gate for the post-worker flush. Another tick may own
    // it now; that pass (or the next timer pass) projects our durable messages.
    if (this.stopped || this.busy) return;
    this.busy = gate;
    this.project();
    await this.deliver();
  }
  private async processInbox(rows: any[]) {
    for (const row of rows) {
      if (this.stopped) return;
      const live = this.live.get(row.account_id); if (!live) continue;
      const controller = new AbortController();
      try {
        const m: InboundEnvelope = JSON.parse(this.secrets.open(row.envelope));
        let b = this.binding(row.account_id, m);
        if ((this.store.db.prepare('SELECT status FROM gateway_inbox WHERE id=?').get(row.id) as any)?.status !== 'pending') continue;
        if (b) this.inbound.set(row.id, { binding: b.id, controller });
        if (m.text.startsWith('/pair ')) {
          this.store.transaction(() => {
            const pair = this.store.db.prepare('SELECT * FROM gateway_pairings WHERE account_id=? AND code_hash=? AND expires_at>?').get(row.account_id, pairHash(m.text.trim().slice(6)), stamp());
            if (!pair) return;
            // One owner identity per account. Rebinding requires explicit revocation first.
            if (this.store.db.prepare('SELECT 1 FROM gateway_bindings WHERE account_id=? AND revoked=0').get(row.account_id) && (!b || b.revoked)) return;
            const thread = b ? { id: b.thread_id } : this.bot.create(row.owner_id, 'bot', `IM · ${m.peer.slice(0, 60)}`, row.agent_id);
            this.store.db.prepare('DELETE FROM thread_participants WHERE thread_id=?').run(thread.id);
            this.store.db.prepare('INSERT INTO thread_participants(thread_id,agent_id,joined_at) VALUES(?,?,?)').run(thread.id, row.agent_id, stamp());
            this.store.db.prepare(`INSERT INTO gateway_bindings(id,account_id,tenant,peer,chat,topic,thread_id,context) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id,tenant,peer,chat,topic) DO UPDATE SET revoked=0,context=excluded.context`).run(crypto.randomUUID(), row.account_id, m.tenant, m.peer, m.chat, m.topic, thread.id, m.context ? this.secrets.seal(m.context) : null);
            this.store.db.prepare('DELETE FROM gateway_pairings WHERE account_id=?').run(row.account_id);
            this.bot.append(thread.id, 'assistant', 'text', '绑定成功，可以直接发消息了。需要确认时回复“同意”或“拒绝”即可；多项待确认时回复“同意 编号”或“拒绝 编号”。/stop 停止；/status 查看状态。');
            this.secrets.audit(row.owner_id, 'gateway.paired', { account: row.account_id, peer: m.peer });
          });
        } else if (b && !b.revoked) {
          if (m.context) this.store.db.prepare('UPDATE gateway_bindings SET context=? WHERE id=?').run(this.secrets.seal(m.context), b.id);
          const legacyApproval = /^\/(approve|reject) ([\w-]{1,100})$/.exec(m.text.trim());
          const approval = m.approvalReply ?? (legacyApproval ? { id: legacyApproval[2], approved: legacyApproval[1] === 'approve' } : undefined);
          if (approval) {
            this.store.transaction(() => {
              const result = approval.id ? this.bot.resolve(row.owner_id, approval.id, approval.approved, m.text.trim(), b.thread_id) : { error: 'approval_selection_required' };
              const text = result.error === 'approval_selection_required' ? '请查看待确认消息中的编号，回复“同意 编号”或“拒绝 编号”。发送 /status 可查看待确认项。'
                : result.error ? '这项确认已失效或已处理，请以最新的确认消息为准。'
                : result.status === 'approved' ? '已同意，将继续处理。' : '已拒绝这次操作。';
              this.bot.append(b.thread_id, 'assistant', 'text', text, `im:${row.id}:approval`);
              this.store.db.prepare("UPDATE gateway_inbox SET status='done' WHERE id=?").run(row.id);
            });
           } else if (m.text.trim() === '/status') {
            const latest = (this.bot.status(row.owner_id, b.thread_id) as { status: string }[])[0];
            const labels: Record<string, string> = { queued: '等待处理', running: '正在处理', waiting_user: '等待你的确认', completed: '已完成', failed: '未能完成', cancelled: '已停止', paused: '已暂停' };
             this.bot.append(b.thread_id, 'assistant', 'text', latest ? `最近的任务：${labels[latest.status] ?? latest.status}。` : '当前没有任务。');
             const pending = this.store.db.prepare(`SELECT m.seq,m.content FROM approvals a JOIN messages m ON m.id=a.message_id
               WHERE a.thread_id=? AND a.status='pending' ORDER BY m.seq LIMIT 10`).all(b.thread_id) as { seq: number; content: string }[];
             if (pending.length) this.bot.append(b.thread_id, 'assistant', 'text', `待确认（最多显示 10 项）：\n${pending.map(a => `${a.seq}：${a.content.startsWith('请求执行命令') ? '在工作区运行程序' : a.content.split('\n')[0].slice(0, 160)}`).join('\n')}\n回复“同意 编号”或“拒绝 编号”。`);
          } else {
            const attachments: { fileId: string; originalName: string; mimeType: string; sizeBytes: number }[] = [];
            for (const [index, attachment] of (m.attachments ?? []).entries()) {
              if (!live.plugin.download) throw new Error('media_not_supported');
              const a = this.account(row.owner_id, row.account_id);
              const id = fileOperationId(row.owner_id, `${row.account_id}:${row.id}`, `gateway:${index}`);
              const saved = this.store.db.prepare('SELECT id,original_name AS originalName,mime_type AS mimeType,size_bytes AS sizeBytes FROM files WHERE id=? AND owner_id=?').get(id, row.owner_id) as { id: string; originalName: string; mimeType: string; sizeBytes: number } | undefined;
              if (saved) { attachments.push({ fileId: saved.id, originalName: saved.originalName, mimeType: saved.mimeType, sizeBytes: saved.sizeBytes }); continue; }
              const media = await live.plugin.download(this.config(a), m, attachment, AbortSignal.any([controller.signal, live.controller.signal, AbortSignal.timeout(30_000)]));
              const checkActive = () => {
                controller.signal.throwIfAborted(); live.controller.signal.throwIfAborted();
                if (!this.binding(row.account_id, m) || this.binding(row.account_id, m).revoked) throw new Error('binding_revoked');
                if ((this.store.db.prepare('SELECT status FROM gateway_inbox WHERE id=?').get(row.id) as any)?.status !== 'pending') throw new Error('inbound_cancelled');
              };
              checkActive();
              const date = new Date(row.received_at).toISOString().slice(0, 10).replace(/-/g, '');
              const fallback = `${a.channel === 'ilink' ? '微信' : '飞书'}${media.mime.startsWith('image/') ? '图片' : '附件'}_${date}_${id.slice(0, 8)}`;
              const f = await receiveFile(this.store, this.filesDir, row.owner_id, Readable.from([media.bytes]), media.name || fallback, media.mime, 20 * 1024 * 1024, undefined, checkActive, id);
              attachments.push({ fileId: f.id, originalName: f.originalName, mimeType: f.mimeType, sizeBytes: f.sizeBytes });
            }
            this.store.transaction(() => {
              controller.signal.throwIfAborted();
              live.controller.signal.throwIfAborted();
              const current = this.binding(row.account_id, m); if (!current || current.revoked) throw new Error('binding_revoked');
              if ((this.store.db.prepare('SELECT status FROM gateway_inbox WHERE id=?').get(row.id) as any)?.status !== 'pending') throw new Error('inbound_cancelled');
              this.bot.send(row.owner_id, b.thread_id, { clientNonce: `im:${row.id}`, ...(attachments.length ? { kind: 'attachment' } : {}), content: attachments.length ? JSON.stringify({ ...attachments[0], attachments, caption: m.text }) : m.text });
              this.store.db.prepare("UPDATE gateway_inbox SET status='done' WHERE id=?").run(row.id);
            });
          }
        }
        if ((!b || b.revoked) && !m.text.startsWith('/pair ')) {
          this.store.db.prepare("UPDATE gateway_inbox SET status='done',error='binding_required' WHERE id=?").run(row.id);
        } else this.store.db.prepare("UPDATE gateway_inbox SET status='done' WHERE id=?").run(row.id);
      } catch {
        this.store.db.prepare("UPDATE gateway_inbox SET status='failed',error='inbound_processing_failed' WHERE id=? AND status='pending'").run(row.id);
      } finally { this.inbound.delete(row.id); }
    }
  }
  project() {
      for (const b of this.store.db.prepare('SELECT * FROM gateway_bindings WHERE revoked=0').all() as any[]) {
        const events = this.store.db.prepare('SELECT * FROM message_events WHERE thread_id=? AND event_id>? ORDER BY event_id LIMIT 200').all(b.thread_id, b.checkpoint) as any[];
        for (const event of events) {
          const failed = this.store.db.prepare('SELECT next_at FROM gateway_projection_failures WHERE binding_id=? AND event_id=?').get(b.id, event.event_id) as any;
          if (failed?.next_at > Date.now()) break;
          try { this.store.transaction(() => {
          const m = JSON.parse(event.payload);
          if (!m || typeof m !== 'object' || (event.type === 'message.accepted' && (typeof m.content !== 'string' || typeof m.role !== 'string'))) throw new Error('invalid_projection');
          if (event.type === 'message.accepted' && m.role === 'assistant' && ['text', 'question', 'approval', 'attachment'].includes(m.kind)) {
            let text = m.content;
            let fileId: string | undefined;
            if (m.kind === 'attachment') { try { const f = JSON.parse(text); if (f.fileId) { fileId = f.fileId; text = f.caption ?? f.name ?? '文件'; } } catch { /* legacy plain text */ } }
            if (m.kind === 'approval') {
              const a = this.store.db.prepare('SELECT a.id,a.status,m.seq FROM approvals a JOIN messages m ON m.id=a.message_id WHERE a.message_id=?').get(m.id) as any;
              if (!a || a.status !== 'pending') {
                this.store.db.prepare('UPDATE gateway_bindings SET checkpoint=? WHERE id=?').run(event.event_id, b.id);
                this.store.db.prepare('DELETE FROM gateway_projection_failures WHERE binding_id=? AND event_id=?').run(b.id, event.event_id);
                return;
              }
              text = approvalPrompt(text, a.seq);
            }
            const chars = Array.from(String(text));
            for (let i = 0; i < Math.max(1, Math.ceil(chars.length / 1500)); i++) this.enqueue(b.id, `event:${event.event_id}:${i}`, { text: chars.slice(i * 1500, (i + 1) * 1500).join(''), ...(i === 0 && fileId ? { fileId } : {}) });
          }
          this.store.db.prepare('UPDATE gateway_bindings SET checkpoint=? WHERE id=?').run(event.event_id, b.id);
          this.store.db.prepare('DELETE FROM gateway_projection_failures WHERE binding_id=? AND event_id=?').run(b.id, event.event_id);
          }); } catch {
            this.store.db.prepare("INSERT INTO gateway_projection_failures(binding_id,event_id,error,next_at) VALUES(?,?,'projection_failed',?) ON CONFLICT(binding_id,event_id) DO UPDATE SET next_at=excluded.next_at").run(b.id, event.event_id, Date.now() + 30_000);
            break; // Keep this checkpoint; other conversations and their deliveries still progress.
          }
        }
      }
  }
  enqueue(binding: string, source: string, payload: GatewayPayload) {
    const id = hash(`${binding}:${source}`).slice(0, 32);
    if (this.store.db.prepare('SELECT 1 FROM gateway_outbox WHERE id=?').get(id)) return;
    if (JSON.stringify(payload).length > 128000) throw new Error('gateway_payload_too_large');
    const capacity = this.store.db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN o.status IN ('pending','sending','uncertain','failed') THEN 1 ELSE 0 END) AS pending FROM gateway_outbox o JOIN gateway_bindings b ON b.id=o.binding_id WHERE b.account_id=(SELECT account_id FROM gateway_bindings WHERE id=?)").get(binding) as { total: number; pending: number };
    if (capacity.pending >= gatewayLimits().pending || capacity.total >= gatewayLimits().dedupe) throw new Error('gateway_outbox_capacity');
    this.store.db.prepare('INSERT OR IGNORE INTO gateway_outbox(id,binding_id,payload,created_at) VALUES(?,?,?,?)').run(hash(`${binding}:${source}`).slice(0, 32), binding, JSON.stringify(payload), Date.now());
  }
  private async deliver() {
    const rows = this.store.db.prepare(`SELECT o.*,b.account_id,b.tenant,b.peer,b.chat,b.topic,b.context,a.owner_id,a.channel,a.config
      FROM gateway_outbox o JOIN gateway_bindings b ON b.id=o.binding_id JOIN gateway_accounts a ON a.id=b.account_id
      WHERE o.status='pending' AND o.next_at<=? AND b.revoked=0 AND a.enabled=1
      AND NOT EXISTS(SELECT 1 FROM gateway_outbox p WHERE p.binding_id=o.binding_id AND p.seq<o.seq AND p.status IN ('pending','sending','uncertain','failed')) ORDER BY o.seq LIMIT 10`).all(Date.now()) as any[];
    for (const row of rows) {
      const live = this.live.get(row.account_id); if (!live || live.controller.signal.aborted) continue;
      if (!this.store.db.prepare("UPDATE gateway_outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'").run(row.id).changes) continue;
      try {
        const platformId = await live.plugin.send(this.config(row), { messageId: '', tenant: row.tenant, peer: row.peer, chat: row.chat, topic: row.topic, direct: true, human: true, text: '', context: row.context ? this.secrets.open(row.context) : undefined }, JSON.parse(row.payload), row.id, AbortSignal.any([live.controller.signal, AbortSignal.timeout(30_000)]));
        this.store.db.prepare("UPDATE gateway_outbox SET status='sent',platform_id=?,error=NULL WHERE id=? AND status='sending'").run(platformId, row.id);
        publishBotEvent(this.store, { owner: row.owner_id, type: 'delivery.finished', status: 'sent' });
      } catch (e) {
        const error = e instanceof DeliveryError ? e : new DeliveryError('transport_result_unknown', true);
        if (error.code === 'login_required') this.store.db.prepare("UPDATE gateway_accounts SET health='login_required' WHERE id=?").run(row.account_id);
        const window = live.plugin.manifest.capabilities.deduplicationWindowMs;
        const retrySafe = !error.uncertain || (window > 0 && Date.now() - row.created_at < window - 60_000);
        const state = error.code === 'context_required' || error.code === 'login_required' ? 'failed' : !retrySafe ? 'uncertain' : !error.retryable || row.attempts >= 7 ? 'failed' : 'pending';
        this.store.db.prepare("UPDATE gateway_outbox SET status=?,error=?,next_at=? WHERE id=? AND status='sending'").run(state, error.code, Date.now() + Math.max(error.retryAfterMs, Math.min(300_000, 1000 * 2 ** row.attempts)), row.id);
      }
    }
  }
  retry(owner: string, id: string, acknowledgeUncertain: boolean) {
    const row = this.store.db.prepare('SELECT o.* FROM gateway_outbox o JOIN gateway_bindings b ON b.id=o.binding_id JOIN gateway_accounts a ON a.id=b.account_id WHERE o.id=? AND a.owner_id=? AND b.revoked=0').get(id, owner) as any;
    if (!row || !['failed','uncertain'].includes(row.status)) throw new Error('delivery_not_retryable');
    if (row.status === 'uncertain' && !acknowledgeUncertain) throw new Error('duplicate_risk_confirmation_required');
    this.store.db.prepare("UPDATE gateway_outbox SET status='pending',next_at=0,attempts=0 WHERE id=?").run(id);
    this.secrets.audit(owner, 'gateway.delivery_retry', { id, acknowledgeUncertain });
  }
  discard(owner: string, id: string) {
    const row = this.store.db.prepare('SELECT o.* FROM gateway_outbox o JOIN gateway_bindings b ON b.id=o.binding_id JOIN gateway_accounts a ON a.id=b.account_id WHERE o.id=? AND a.owner_id=?').get(id, owner) as any;
    if (!row || !['pending','failed','uncertain'].includes(row.status)) throw new Error('delivery_not_discardable');
    this.store.db.prepare("UPDATE gateway_outbox SET status='cancelled',error='discarded_by_owner' WHERE id=?").run(id);
    this.secrets.audit(owner, 'gateway.delivery_discarded', { id, previousStatus: row.status });
  }
  reminders() {
    this.store.transaction(() => {
      for (const r of this.store.db.prepare("SELECT * FROM bot_reminders WHERE status='active' AND next_at<=?").all(Date.now()) as any[]) {
        this.bot.append(r.thread_id, 'assistant', 'text', `提醒（${r.timezone}；计划时间 ${new Date(r.next_at).toISOString()}）：${r.text}`);
        // Missed repeating reminders coalesce once after restart, not a flood of stale notifications.
        const next = r.interval_seconds ? r.next_at + (Math.floor((Date.now() - r.next_at) / (r.interval_seconds * 1000)) + 1) * r.interval_seconds * 1000 : r.next_at;
        this.store.db.prepare('UPDATE bot_reminders SET next_at=?,status=? WHERE id=?').run(next, r.interval_seconds ? 'active' : 'fired', r.id);
      }
    });
  }
}
