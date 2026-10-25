import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfiguration } from '../cloud/config.js';
import type { BotApplicationService } from '../agent/service.js';
import { receiveFile } from '../cloud/files.js';
import { DeliveryError, type ChannelPlugin, type GatewayEnvelope, type GatewayPayload } from './plugin.js';

const stamp = () => new Date().toISOString();
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export type PluginFactory = (account?: { id: string; owner_id: string }) => ChannelPlugin;
/** Single-instance durable gateway. ACK only includes the synchronous receive transaction. */
export class GatewayCore {
  private live = new Map<string, { plugin: ChannelPlugin; controller: AbortController }>();
  private work = new Set<Promise<unknown>>();
  private inbound = new Map<number, { binding: string; controller: AbortController }>();
  private logins = new Map<string, AbortController>();
  private restartAfter = new Map<string, number>();
  private busy = false;
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
    return (this.store.db.prepare('SELECT id,channel,agent_id AS agentId,enabled,preset,health,created_at AS createdAt FROM gateway_accounts WHERE owner_id=?').all(owner) as any[]).map(a => ({ ...a,
      manifest: this.factories[a.channel]?.().manifest,
      bindings: this.store.db.prepare('SELECT id,tenant,peer,chat,thread_id AS threadId,revoked FROM gateway_bindings WHERE account_id=?').all(a.id),
    }));
  }
  async save(owner: string, value: { id?: string; channel: string; agentId: string; enabled: boolean; preset?: string; config?: Record<string, string> }) {
    if (!this.factories[value.channel] || !['inherit', 'autonomous'].includes(value.preset ?? 'inherit') || typeof value.enabled !== 'boolean') throw new Error('invalid_account');
    if (!this.store.db.prepare('SELECT 1 FROM agent_profiles WHERE id=? AND owner_id=? AND enabled=1').get(value.agentId, owner)) throw new Error('agent_not_found');
    const old = value.id ? this.account(owner, value.id) : null;
    if (old && old.channel !== value.channel) throw new Error('channel_immutable');
    const config = { ...(old ? this.config(old) : {}), ...value.config };
    if (Object.values(config).some(v => typeof v !== 'string' || v.length > 16384)) throw new Error('invalid_config');
    this.factories[value.channel]().validate(config);
    const id = old?.id ?? crypto.randomUUID();
    await this.stop(id);
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
    if (value.enabled) this.launch(id);
    return { id };
  }
  pair(owner: string, id: string) {
    this.account(owner, id);
    const code = crypto.randomBytes(16).toString('hex'), expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.store.db.prepare('INSERT INTO gateway_pairings(account_id,code_hash,expires_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at').run(id, hash(code), expiresAt);
    return { command: `/pair ${code}`, expiresAt };
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
    this.track(this.stop(id).then(() => { if (!this.stopped) { const a = this.account(owner, id); if (a.enabled) this.launch(id); } }));
    this.secrets.audit(owner, 'gateway.revoked', { id, binding });
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
  private launch(id: string) {
    if (this.stopped || this.live.has(id)) return;
    const a = this.store.db.prepare('SELECT * FROM gateway_accounts WHERE id=?').get(id) as any;
    if (!a?.enabled) return;
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
      receive: (batch, cursor) => this.receive(id, batch, cursor),
      cursor: () => (this.store.db.prepare('SELECT cursor FROM gateway_accounts WHERE id=?').get(id) as any)?.cursor ?? undefined,
      updateConfig: patch => {
        if (controller.signal.aborted) return;
        const current = this.store.db.prepare('SELECT * FROM gateway_accounts WHERE id=?').get(id);
        this.store.db.prepare('UPDATE gateway_accounts SET config=? WHERE id=?').run(this.secrets.seal(JSON.stringify({ ...this.config(current), ...patch })), id);
      },
      health: state => { if (!controller.signal.aborted) this.store.db.prepare('UPDATE gateway_accounts SET health=? WHERE id=?').run(state, id); },
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
    this.store.db.prepare("UPDATE gateway_accounts SET health='stopped' WHERE id=?").run(id);
  }
  async close() {
    this.stopped = true; clearInterval(this.timer);
    for (const controller of this.logins.values()) controller.abort();
    await Promise.all([...this.live.keys()].map(id => this.stop(id)));
    await Promise.allSettled([...this.work]);
  }
  async login(owner: string, id: string, action: Record<string, string>) {
    const a = this.account(owner, id), live = this.live.get(id);
    const plugin = live?.plugin ?? this.factories[a.channel](a);
    if (!plugin.login) throw new Error('login_not_supported');
    this.logins.get(id)?.abort();
    const controller = new AbortController(); this.logins.set(id, controller);
    let result: Record<string, string>;
    try {
      result = await plugin.login(this.config(a), action, AbortSignal.any([controller.signal, live?.controller.signal ?? controller.signal, AbortSignal.timeout(40_000)]));
      controller.signal.throwIfAborted();
    } finally { if (this.logins.get(id) === controller) this.logins.delete(id); }
    const { botToken, botId, baseUrl, ...publicResult } = result;
    if (botToken) {
      this.store.db.prepare('UPDATE gateway_accounts SET config=? WHERE id=?').run(this.secrets.seal(JSON.stringify({ ...this.config(a), botToken, botId, baseUrl })), id);
      await this.stop(id); if (a.enabled) this.launch(id);
    }
    return publicResult;
  }
  receive(id: string, batch: GatewayEnvelope[], cursor?: string) {
    const a = this.store.db.prepare('SELECT * FROM gateway_accounts WHERE id=?').get(id) as any;
    if (!a?.enabled || this.stopped) return;
    this.store.transaction(() => {
      for (const message of batch) {
        if (!message.direct || !message.human || !message.messageId || !message.peer || message.text.length > 100000) continue;
        const inserted = this.store.db.prepare('INSERT OR IGNORE INTO gateway_inbox(account_id,external_id,envelope) VALUES(?,?,?)').run(id, JSON.stringify([message.tenant, message.messageId]), this.secrets.seal(JSON.stringify(message)));
        if (!inserted.changes) continue;
        const b = this.binding(id, message);
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
  async tick() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    const task = this.process().catch(() => this.runtimeFailure()).finally(() => { this.busy = false; }); this.track(task); await task;
  }
  private async process() {
    for (const a of this.store.db.prepare('SELECT id FROM gateway_accounts WHERE enabled=1').all() as any[]) {
      if (!this.live.has(a.id) && (this.restartAfter.get(a.id) ?? 0) <= Date.now()) this.launch(a.id);
    }
    this.reminders();
    // Small bounded batch; network has a timeout and stop/revoke aborts it.
    const rows = this.store.db.prepare("SELECT i.*,a.owner_id,a.agent_id,a.enabled FROM gateway_inbox i JOIN gateway_accounts a ON a.id=i.account_id WHERE i.status='pending' AND a.enabled=1 ORDER BY i.id LIMIT 10").all() as any[];
    for (const row of rows) {
      if (this.stopped) return;
      const live = this.live.get(row.account_id); if (!live) continue;
      const controller = new AbortController();
      try {
        const m: GatewayEnvelope = JSON.parse(this.secrets.open(row.envelope));
        let b = this.binding(row.account_id, m);
        if ((this.store.db.prepare('SELECT status FROM gateway_inbox WHERE id=?').get(row.id) as any)?.status !== 'pending') continue;
        if (b) this.inbound.set(row.id, { binding: b.id, controller });
        if (m.text.startsWith('/pair ')) {
          this.store.transaction(() => {
            const pair = this.store.db.prepare('SELECT * FROM gateway_pairings WHERE account_id=? AND code_hash=? AND expires_at>?').get(row.account_id, hash(m.text.trim().slice(6)), stamp());
            if (!pair) return;
            // One owner identity per account. Rebinding requires explicit revocation first.
            if (this.store.db.prepare('SELECT 1 FROM gateway_bindings WHERE account_id=? AND revoked=0').get(row.account_id) && (!b || b.revoked)) return;
            const thread = b ? { id: b.thread_id } : this.bot.create(row.owner_id, 'bot', `IM · ${m.peer.slice(0, 60)}`, row.agent_id);
            this.store.db.prepare('DELETE FROM thread_participants WHERE thread_id=?').run(thread.id);
            this.store.db.prepare('INSERT INTO thread_participants(thread_id,agent_id,joined_at) VALUES(?,?,?)').run(thread.id, row.agent_id, stamp());
            this.store.db.prepare(`INSERT INTO gateway_bindings(id,account_id,tenant,peer,chat,topic,thread_id,context) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id,tenant,peer,chat,topic) DO UPDATE SET revoked=0,context=excluded.context`).run(crypto.randomUUID(), row.account_id, m.tenant, m.peer, m.chat, m.topic, thread.id, m.context ? this.secrets.seal(m.context) : null);
            this.store.db.prepare('DELETE FROM gateway_pairings WHERE account_id=?').run(row.account_id);
            this.bot.append(thread.id, 'assistant', 'text', '本人绑定成功。可直接提出学习任务。/stop 停止；/status 状态；/approve <精确ID> 或 /reject <精确ID> 审批。');
            this.secrets.audit(row.owner_id, 'gateway.paired', { account: row.account_id, peer: m.peer });
          });
        } else if (b && !b.revoked) {
          if (m.context) this.store.db.prepare('UPDATE gateway_bindings SET context=? WHERE id=?').run(this.secrets.seal(m.context), b.id);
          const approval = /^\/(approve|reject) ([\w-]{1,100})$/.exec(m.text.trim());
          if (approval) {
            const result = this.bot.resolve(row.owner_id, approval[2], approval[1] === 'approve', 'IM exact approval', b.thread_id);
            this.bot.append(b.thread_id, 'assistant', 'progress', result.error ?? `审批 ${result.status}`);
          } else if (m.text.trim() === '/status') {
            this.bot.append(b.thread_id, 'assistant', 'progress', JSON.stringify(this.bot.status(row.owner_id, b.thread_id)));
          } else {
            const descriptions: string[] = [];
            for (const attachment of m.attachments ?? []) {
              if (!live.plugin.download) throw new Error('media_not_supported');
              const a = this.account(row.owner_id, row.account_id);
              const media = await live.plugin.download(this.config(a), m, attachment, AbortSignal.any([controller.signal, live.controller.signal, AbortSignal.timeout(30_000)]));
              controller.signal.throwIfAborted();
              live.controller.signal.throwIfAborted();
              if (!this.binding(row.account_id, m) || this.binding(row.account_id, m).revoked) throw new Error('binding_revoked');
              const f = await receiveFile(this.store, this.filesDir, row.owner_id, Readable.from([media.bytes]), media.name.slice(0, 255), media.mime, 20 * 1024 * 1024);
              descriptions.push(`Attachment fileId=${f.id}, name=${f.originalName}, mime=${f.mimeType}. Use study_file to read/understand it.`);
            }
            this.store.transaction(() => {
              controller.signal.throwIfAborted();
              live.controller.signal.throwIfAborted();
              const current = this.binding(row.account_id, m); if (!current || current.revoked) throw new Error('binding_revoked');
              if ((this.store.db.prepare('SELECT status FROM gateway_inbox WHERE id=?').get(row.id) as any)?.status !== 'pending') throw new Error('inbound_cancelled');
              this.bot.send(row.owner_id, b.thread_id, { clientNonce: `im:${row.id}`, content: [m.text, ...descriptions].filter(Boolean).join('\n') });
              this.store.db.prepare("UPDATE gateway_inbox SET status='done' WHERE id=?").run(row.id);
            });
          }
        }
        this.store.db.prepare("UPDATE gateway_inbox SET status='done' WHERE id=?").run(row.id);
      } catch {
        this.store.db.prepare("UPDATE gateway_inbox SET status='failed',error='inbound_processing_failed' WHERE id=? AND status='pending'").run(row.id);
      } finally { this.inbound.delete(row.id); }
    }
    this.project();
    await this.deliver();
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
          if (event.type === 'message.accepted' && m.role === 'assistant') {
            let text = m.content;
            let fileId: string | undefined;
            if (m.kind === 'attachment') { try { const f = JSON.parse(text); if (f.fileId) { fileId = f.fileId; text = f.caption ?? f.name ?? '文件'; } } catch { /* legacy plain text */ } }
            if (m.kind === 'approval') {
              const a = this.store.db.prepare('SELECT id FROM approvals WHERE message_id=?').get(m.id) as any;
              if (a) text += `\n/approve ${a.id}\n/reject ${a.id}`;
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
    this.store.db.prepare('INSERT OR IGNORE INTO gateway_outbox(id,binding_id,payload,created_at) VALUES(?,?,?,?)').run(hash(`${binding}:${source}`).slice(0, 32), binding, JSON.stringify(payload), Date.now());
  }
  private async deliver() {
    const rows = this.store.db.prepare(`SELECT o.*,b.account_id,b.tenant,b.peer,b.chat,b.topic,b.context,a.owner_id,a.channel,a.config
      FROM gateway_outbox o JOIN gateway_bindings b ON b.id=o.binding_id JOIN gateway_accounts a ON a.id=b.account_id
      WHERE o.status='pending' AND o.next_at<=? AND b.revoked=0 AND a.enabled=1
      AND NOT EXISTS(SELECT 1 FROM gateway_outbox p WHERE p.binding_id=o.binding_id AND p.seq<o.seq AND p.status IN ('pending','sending','uncertain','failed')) ORDER BY o.seq LIMIT 10`).all(Date.now()) as any[];
    for (const row of rows) {
      const live = this.live.get(row.account_id); if (!live || live.controller.signal.aborted) continue;
      this.store.db.prepare("UPDATE gateway_outbox SET status='sending',attempts=attempts+1 WHERE id=?").run(row.id);
      try {
        const platformId = await live.plugin.send(this.config(row), { messageId: '', tenant: row.tenant, peer: row.peer, chat: row.chat, topic: row.topic, direct: true, human: true, text: '', context: row.context ? this.secrets.open(row.context) : undefined }, JSON.parse(row.payload), row.id, AbortSignal.any([live.controller.signal, AbortSignal.timeout(30_000)]));
        this.store.db.prepare("UPDATE gateway_outbox SET status='sent',platform_id=?,error=NULL WHERE id=? AND status='sending'").run(platformId, row.id);
      } catch (e) {
        const error = e instanceof DeliveryError ? e : new DeliveryError('transport_result_unknown', true);
        if (error.code === 'login_required') this.store.db.prepare("UPDATE gateway_accounts SET health='login_required' WHERE id=?").run(row.account_id);
        const window = live.plugin.manifest.capabilities.deduplicationWindowMs;
        const retrySafe = !error.uncertain || (window > 0 && Date.now() - row.created_at < window - 60_000);
        const state = error.code === 'context_required' || error.code === 'login_required' ? 'failed' : !retrySafe ? 'uncertain' : row.attempts >= 7 ? 'failed' : 'pending';
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
