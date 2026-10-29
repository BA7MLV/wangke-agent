import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseBotAttachments } from '@wangke/contracts';
import type { DatabaseStore } from '../storage/database.js';
import type { BotRunner } from './runner.js';
import type { ProjectRepository } from '../projects/repository.js';
const now = () => new Date().toISOString();
type AppendedMessage = { id: string; threadId: string; clientNonce: string | null; seq: number; role: string; kind: string; content: string; replyTo: string | null; createdAt: string };
/** Shared, owner-scoped entry point for Web and IM. No synthetic HTTP credentials. */
export class BotApplicationService {
  constructor(readonly store: DatabaseStore, readonly runner: BotRunner, private readonly projects?: ProjectRepository) {}
  thread(owner: string, id: string): any {
    const row = this.store.db.prepare('SELECT * FROM threads WHERE id=? AND owner_id=?').get(id, owner);
    if (!row) throw new Error('thread_not_found');
    return row;
  }
  create(owner: string, mode: 'bot' | 'chat', title: string | null, agent?: string) {
    return this.store.transaction(() => {
      if (agent && !this.store.db.prepare('SELECT 1 FROM agent_profiles WHERE id=? AND owner_id=? AND enabled=1').get(agent, owner)) throw new Error('agent_not_found');
      const id = crypto.randomUUID(), timestamp = now();
      this.store.db.prepare('INSERT INTO threads(id,owner_id,mode,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, owner, mode, title, timestamp, timestamp);
      if (agent) this.store.db.prepare('INSERT INTO thread_participants(thread_id,agent_id,joined_at) VALUES(?,?,?)').run(id, agent, timestamp);
      return { id, mode, title, createdAt: timestamp, updatedAt: timestamp };
    });
  }
  append(threadId: string, role: string, kind: string, content: string, nonce: string | null = null, replyTo: string | null = null) {
    return this.store.transaction(() => {
    if (nonce) {
      const saved = this.store.db.prepare('SELECT id,thread_id AS threadId,client_nonce AS clientNonce,seq,role,kind,content,reply_to AS replyTo,created_at AS createdAt FROM messages WHERE thread_id=? AND client_nonce=?').get(threadId, nonce) as AppendedMessage | undefined;
      if (saved) return saved;
    }
    const seq = (this.store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages WHERE thread_id=?').get(threadId) as any).seq;
    const id = crypto.randomUUID(), timestamp = now();
    const dto = { id, threadId, clientNonce: nonce, seq, role, kind, content, replyTo, createdAt: timestamp };
    this.store.db.prepare('INSERT INTO messages(id,thread_id,client_nonce,seq,role,kind,content,reply_to,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, threadId, nonce, seq, role, kind, content, replyTo, timestamp);
    this.store.db.prepare('INSERT INTO message_events(id,thread_id,seq,type,payload,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), threadId, seq, 'message.accepted', JSON.stringify(dto), timestamp);
    this.store.db.prepare('UPDATE threads SET updated_at=? WHERE id=?').run(timestamp, threadId);
    return dto;
    });
  }
  send(owner: string, threadId: string, input: { clientNonce: string; kind?: string; content: string; replyTo?: string }) {
    const thread = this.thread(owner, threadId);
    if (thread.archived) throw new Error('thread_archived');
    if (thread.project_id) {
      if (!this.projects) throw new Error('project_access_denied');
      this.projects.authorize(owner, thread.project_id, thread.agent_id);
    }
    if (!input.clientNonce || input.clientNonce.length > 200 || typeof input.content !== 'string' || input.content.length > 100000) throw new Error('invalid_message');
    if (input.kind === 'attachment') {
      const parsed = parseBotAttachments(input.content);
      if (!parsed) throw new Error('invalid_message');
      for (const attachment of parsed.files) if (thread.project_id) {
        if (attachment.projectId !== thread.project_id || typeof attachment.projectPath !== 'string') throw new Error('invalid_message');
        if (process.platform !== 'linux') this.projects!.assertIdle(thread.project_id);
        const file = this.projects!.files.open(thread.project_id, attachment.projectPath); fs.closeSync(file.fd);
      } else if (!attachment.fileId || !this.store.db.prepare('SELECT 1 FROM files WHERE id=? AND owner_id=?').get(attachment.fileId, owner)) throw new Error('invalid_message');
    }
    const message = this.store.transaction(() => {
      const old = this.store.db.prepare('SELECT * FROM messages WHERE thread_id=? AND client_nonce=?').get(threadId, input.clientNonce) as any;
      if (old) return { id: old.id, threadId, clientNonce: old.client_nonce, seq: old.seq, role: old.role, kind: old.kind, content: old.content, replyTo: old.reply_to, createdAt: old.created_at, deduplicated: true };
      const dto = this.append(threadId, 'user', input.kind ?? 'text', input.content, input.clientNonce, input.replyTo ?? null);
      if (thread.mode === 'bot') {
        const requested = new Set(Array.from(input.content.matchAll(/@([^\s@,，。！？!?]{1,64})/g), m => m[1].toLocaleLowerCase()));
        const agents = this.store.db.prepare('SELECT a.id,a.name FROM agent_profiles a JOIN thread_participants p ON p.agent_id=a.id WHERE p.thread_id=? AND a.enabled=1').all(threadId) as any[];
        for (const a of agents) if (requested.has(a.name.toLocaleLowerCase())) this.store.db.prepare('INSERT OR IGNORE INTO message_mentions(message_id,agent_id,created_at) VALUES(?,?,?)').run(dto.id, a.id, dto.createdAt);
        this.store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at,trigger_message_id) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), threadId, 'bot', 'queued', dto.createdAt, dto.id);
      }
      return { ...dto, deduplicated: false };
    });
    this.runner.enqueue(); return message;
  }
  stop(owner: string, threadId: string) {
    this.thread(owner, threadId);
    const runs = this.store.db.prepare("SELECT id FROM runs WHERE thread_id=? AND (status IN ('queued','running','waiting_user','paused') OR id IN (SELECT parent_run_id FROM cloud_tasks WHERE status IN ('queued','running','waiting_user')))").all(threadId) as any[];
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE runs SET status='cancelled',completed_at=?,wake_at=NULL WHERE thread_id=? AND status IN ('queued','running','waiting_user','paused')").run(now(), threadId);
      if (runs.length) this.append(threadId, 'assistant', 'text', '任务已停止。');
    });
    for (const run of runs) this.runner.cancel(run.id);
    return { stopped: runs.length };
  }
  resolve(owner: string, id: string, approved: boolean, resolution = '', exactThread?: string): any {
    const result = this.store.transaction(() => {
      const a = this.store.db.prepare('SELECT a.* FROM approvals a JOIN threads t ON t.id=a.thread_id WHERE a.id=? AND t.owner_id=?').get(id, owner) as any;
      if (!a || (exactThread && a.thread_id !== exactThread)) return { error: 'approval_not_found' };
      if (a.status !== 'pending') {
        // Project/grant revocation cancels pending Bot work defensively. A
        // racing UI approval may arrive after that cancellation; acknowledge
        // this specific terminal state without reviving or approving it.
        if (a.status === 'rejected' && a.resolution === 'Run cancelled') return { id, messageId: a.message_id, threadId: a.thread_id, runId: a.run_id ?? null, status: a.status, createdAt: a.created_at, resolvedAt: a.resolved_at, resolution: a.resolution };
        return { error: 'approval_already_resolved' };
      }
      const status = approved ? 'approved' : 'rejected', timestamp = now();
      this.store.db.prepare('UPDATE approvals SET status=?,resolved_at=?,resolution=? WHERE id=? AND status=\'pending\'').run(status, timestamp, resolution || null, id);
      if (a.cloud_permission_id) this.store.db.prepare("UPDATE cloud_permissions SET status=?,resolved_at=? WHERE id=? AND owner_id=? AND status='pending'").run(status, timestamp, a.cloud_permission_id, owner);
      const run = (a.cloud_permission_id ? null : a.run_id ? this.store.db.prepare("SELECT id FROM runs WHERE id=? AND status='waiting_user'").get(a.run_id) : this.store.db.prepare("SELECT id FROM runs WHERE thread_id=? AND status='waiting_user' ORDER BY created_at DESC LIMIT 1").get(a.thread_id)) as any;
      if (run) {
        this.append(a.thread_id, 'user', 'text', `Approval ${status}: ${resolution || status}`, `approval:${id}:${status}`, a.message_id);
        this.store.db.prepare("UPDATE runs SET status='queued',completed_at=NULL,error_code=NULL WHERE id=? AND status='waiting_user'").run(run.id);
      }
      return { id, messageId: a.message_id, threadId: a.thread_id, runId: a.run_id ?? run?.id ?? null, status, createdAt: a.created_at, resolvedAt: timestamp, resolution: resolution || null };
    });
    this.runner.enqueue(); return result;
  }
  status(owner: string, threadId: string) {
    this.thread(owner, threadId);
    return this.store.db.prepare('SELECT id,status,step_count AS stepCount,wake_at AS wakeAt,error_code AS errorCode FROM runs WHERE thread_id=? ORDER BY created_at DESC LIMIT 50').all(threadId);
  }
  cancelRun(owner: string, id: string): any {
    const row = this.store.db.prepare('SELECT r.* FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=?').get(id, owner) as any;
    if (!row) return null;
    this.store.transaction(() => {
      const changed = this.store.db.prepare("UPDATE runs SET status='cancelled',completed_at=?,wake_at=NULL WHERE id=? AND status NOT IN ('completed','failed','cancelled')").run(now(), id);
       if (changed.changes) this.append(row.thread_id, 'assistant', 'text', '任务已取消。');
    });
    this.runner.cancel(id);
    const updated = this.store.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as any;
    return { id, threadId: updated.thread_id, mode: updated.mode, status: updated.status, createdAt: updated.created_at, startedAt: updated.started_at ?? null, completedAt: updated.completed_at ?? null, errorCode: updated.error_code ?? null };
  }
}
