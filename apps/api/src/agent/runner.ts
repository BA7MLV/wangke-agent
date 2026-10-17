import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';

type FetchLike = typeof fetch;
type Run = { id: string; thread_id: string; status: string };
const outputKinds = new Set(['text', 'progress', 'attachment', 'question', 'approval']);
const safeErrorText = '模型暂时不可用，请稍后重试。';

const isoNow = () => new Date().toISOString();

export class BotRunner {
  private readonly active = new Map<string, AbortController>();
  private readonly pending = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private stopped = false;
  private draining = false;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly fetcher: FetchLike;

  constructor(private readonly store: DatabaseStore, options: { fetch?: FetchLike } = {}) {
    this.concurrency = Math.max(1, Math.min(8, Number(process.env.BOT_CONCURRENCY ?? 1)));
    this.timeoutMs = Math.max(1000, Number(process.env.MODEL_TIMEOUT_MS ?? 30000));
    this.fetcher = options.fetch ?? fetch;
  }

  start() {
    const stale = new Date(Date.now() - this.timeoutMs).toISOString();
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE runs SET status='queued', started_at=NULL WHERE mode='bot' AND status='running' AND started_at<?").run(stale);
      const rows = this.store.db.prepare("SELECT id FROM runs WHERE mode='bot' AND status='queued' ORDER BY created_at").all() as Array<{ id: string }>;
      for (const row of rows) this.enqueue(row.id);
    });
  }

  enqueue(runId: string) {
    if (this.stopped || this.pending.has(runId) || this.active.has(runId)) return;
    this.pending.add(runId);
    queueMicrotask(() => { this.pending.delete(runId); void this.drain(); });
  }

  cancel(runId: string) { this.active.get(runId)?.abort(); }

  async close() {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.tasks]);
  }

  private async drain() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (!this.stopped && this.active.size < this.concurrency) {
        const run = this.store.db.prepare("SELECT id,thread_id,status FROM runs WHERE mode='bot' AND status='queued' ORDER BY created_at LIMIT 1").get() as Run | undefined;
        if (!run) break;
        const claimed = this.store.transaction(() => this.store.db.prepare("UPDATE runs SET status='running',started_at=? WHERE id=? AND status='queued'").run(isoNow(), run.id));
        if (claimed.changes !== 1) continue;
         const controller = new AbortController();
         this.active.set(run.id, controller);
         const task = this.execute(run.id, run.thread_id, controller);
         this.tasks.add(task);
         task.then(() => {
           this.tasks.delete(task);
           this.active.delete(run.id);
           void this.drain();
         }, () => {
           this.tasks.delete(task);
           this.active.delete(run.id);
           void this.drain();
         });
      }
    } finally { this.draining = false; }
  }

  private async execute(runId: string, threadId: string, controller: AbortController) {
    try {
      if (!process.env.MODEL_API_KEY) throw new RunnerError('model_not_configured');
      const messages = this.store.db.prepare("SELECT role,content FROM messages WHERE thread_id=? AND role IN ('user','assistant') AND kind='text' ORDER BY seq DESC LIMIT 40").all(threadId) as Array<{ role: 'user' | 'assistant'; content: string }>;
      const participants = this.store.db.prepare("SELECT a.name,a.role,a.system_prompt FROM agent_profiles a JOIN thread_participants p ON p.agent_id=a.id WHERE p.thread_id=? AND a.enabled=1 ORDER BY p.joined_at").all(threadId) as Array<{ name: string; role: string; system_prompt: string }>;
      const identity = participants.length ? `Active Agent identities:\n${participants.map((agent) => `- ${agent.name}: ${agent.role}. ${agent.system_prompt.slice(0, 2000)}`).join('\n')}` : 'You are the Wangke Bot learning assistant.';
      const result = await this.callModel(messages.reverse(), controller.signal, identity);
      if (controller.signal.aborted) throw new RunnerError('cancelled');
      if (!result) throw new RunnerError('invalid_structured_response');
      this.store.transaction(() => {
        const current = this.store.db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string } | undefined;
        if (!current || current.status === 'cancelled') return;
        const message = this.appendAssistant(threadId, result.kind, result.text);
        if (result.kind === 'approval') {
          this.store.db.prepare('INSERT INTO approvals(id,thread_id,message_id,run_id,status,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), threadId, message.id, runId, 'pending', message.createdAt);
          this.store.db.prepare("UPDATE runs SET status='waiting_user',completed_at=NULL,error_code=NULL WHERE id=? AND status='running'").run(runId);
        } else {
          this.store.db.prepare("UPDATE runs SET status='completed',completed_at=?,error_code=NULL WHERE id=? AND status='running'").run(isoNow(), runId);
        }
      });
    } catch (error) {
      const code = error instanceof RunnerError ? error.code : 'model_request_failed';
      if (code === 'cancelled') return;
      this.store.transaction(() => {
        const current = this.store.db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string } | undefined;
        if (!current || current.status === 'cancelled') return;
        this.appendAssistant(threadId, 'progress', safeErrorText);
        this.store.db.prepare("UPDATE runs SET status='failed',completed_at=?,error_code=? WHERE id=? AND status='running'").run(isoNow(), code, runId);
      });
    }
  }

  private async callModel(history: Array<{ role: 'user' | 'assistant'; content: string }>, signal: AbortSignal, identity: string) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const response = await this.fetcher(`${process.env.MODEL_BASE_URL ?? 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST', signal: combined, headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.MODEL_API_KEY}` },
      body: JSON.stringify({ model: process.env.MODEL_NAME ?? 'gpt-4o-mini', temperature: 0.2, max_tokens: 1200,
         messages: [{ role: 'system', content: `${identity}\nYou are a safe assistant. Respond only by calling send_message. Never request or emit tools, URLs, files, code execution, or hidden data.` }, ...history.map((m) => ({ role: m.role, content: m.content.slice(0, 12000) }))],
        tools: [{ type: 'function', function: { name: 'send_message', description: 'Send one safe user-visible message.', parameters: { type: 'object', additionalProperties: false, required: ['kind', 'text'], properties: { kind: { type: 'string', enum: ['text', 'progress', 'attachment', 'question', 'approval'] }, text: { type: 'string', maxLength: 12000 } } } } }], tool_choice: { type: 'function', function: { name: 'send_message' } } }),
    });
    if (!response.ok) throw new RunnerError('model_request_failed');
    const body = await response.json() as any;
    const call = body?.choices?.[0]?.message?.tool_calls?.find((x: any) => x?.function?.name === 'send_message');
    if (!call) return null;
    let args: any; try { args = JSON.parse(call.function.arguments); } catch { return null; }
    if (!args || !outputKinds.has(args.kind) || typeof args.text !== 'string' || args.text.length < 1 || args.text.length > 12000) return null;
    return { kind: args.kind, text: args.text };
  }

  private appendAssistant(threadId: string, kind: string, content: string) {
    const seq = (this.store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages WHERE thread_id=?').get(threadId) as any).seq;
    const timestamp = isoNow(); const id = crypto.randomUUID();
    const dto = { id, threadId, clientNonce: null, seq, role: 'assistant', kind, content, replyTo: null, createdAt: timestamp };
    this.store.db.prepare('INSERT INTO messages(id,thread_id,client_nonce,seq,role,kind,content,reply_to,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, threadId, null, seq, 'assistant', kind, content, null, timestamp);
    this.store.db.prepare('INSERT INTO message_events(id,thread_id,seq,type,payload,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), threadId, seq, 'message.accepted', JSON.stringify(dto), timestamp);
    this.store.db.prepare('UPDATE threads SET updated_at=? WHERE id=?').run(timestamp, threadId);
    return dto;
  }
}

class RunnerError extends Error { constructor(readonly code: 'model_not_configured' | 'model_request_failed' | 'invalid_structured_response' | 'cancelled') { super(code); } }
