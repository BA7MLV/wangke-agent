import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import { executeSandbox, type SandboxExecutor } from './sandbox.js';
import type { CloudConfiguration } from '../cloud/config.js';
import { DEFAULT_AGENT_POLICY } from '../../../../packages/contracts/src/cloud.js';
import { botRequest, botCalls, type ModelMessage as Message, type ModelCall as Call } from './model.js';
import { McpManager, mcpError } from '../mcp/manager.js';
import { mcpToolDefinition } from '../../../../packages/contracts/src/mcp.js';

type Run = { id: string; thread_id: string; context_json: string | null; step_count: number; trigger_message_id: string | null };
const now = () => new Date().toISOString();
const tool = (name: string, description: string, properties: object, required: string[]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', additionalProperties: false, properties, required } } });
const tools = [
  tool('send_message', 'Send a user-visible message. text completes the task; progress continues; approval waits for user approval.', { kind: { type: 'string', enum: ['text', 'progress', 'question', 'approval', 'attachment'] }, text: { type: 'string' } }, ['kind', 'text']),
  tool('shell', 'Execute bash in your isolated Linux workspace. Read/write files, run Python/Node, test programs. Files in /workspace persist across commands. Each command starts a fresh container; keep dependencies in /workspace (venv, node_modules). No host access. Maximum 120 seconds per command.', { command: { type: 'string' } }, ['command']),
  tool('wait', 'Persist this task and wake it later, without keeping a model request or browser open.', { seconds: { type: 'integer', minimum: 1, maximum: 86400 }, reason: { type: 'string' } }, ['seconds', 'reason']),
];

export class BotRunner {
  private active = new Map<string, { threadId: string; controller: AbortController }>();
  private tasks = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private draining = false;
  private readonly fetcher: typeof fetch;
  private readonly sandbox: SandboxExecutor;
  private readonly configuration?: CloudConfiguration;
  private readonly mcp?: McpManager;
  constructor(private readonly store: DatabaseStore, options: { fetch?: typeof fetch; sandbox?: SandboxExecutor; configuration?: CloudConfiguration; mcp?: McpManager } = {}) {
    this.mcp = options.mcp;
    this.configuration = options.configuration;
    this.fetcher = options.fetch ?? fetch;
    this.sandbox = options.sandbox ?? executeSandbox;
  }

  start() {
    // One runtime owns this database. Recover all interrupted runs immediately.
    // A command interrupted by process death has uncertain side effects: do not replay it.
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE runs SET status='queued',started_at=NULL WHERE mode='bot' AND status='running'").run();
      this.store.db.prepare("UPDATE run_steps SET status='interrupted',result=?,completed_at=? WHERE status='running'").run('Execution interrupted. Side effects may have happened; inspect the workspace before retrying.', now());
    });
    this.timer = setInterval(() => this.enqueue(), 1000);
    this.timer.unref();
    this.enqueue();
  }

  enqueue(_runId?: string) { if (!this.stopped) queueMicrotask(() => void this.drain()); }
  cancel(id: string) { this.active.get(id)?.controller.abort(); }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled([...this.tasks]);
  }

  private async drain() {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      const concurrency = Math.max(1, Math.min(8, Number(process.env.BOT_CONCURRENCY) || 1));
      const rows = this.store.db.prepare("SELECT * FROM runs WHERE mode='bot' AND status='queued' AND (wake_at IS NULL OR wake_at<=?) ORDER BY created_at").all(now()) as Run[];
      for (const run of rows) {
        if (this.active.size >= concurrency) break;
        if ([...this.active.values()].some((task) => task.threadId === run.thread_id)) continue;
        const claimed = this.store.db.prepare("UPDATE runs SET status='running',started_at=?,wake_at=NULL WHERE id=? AND status='queued'").run(now(), run.id);
        if (!claimed.changes) continue;
        const controller = new AbortController();
        this.active.set(run.id, { threadId: run.thread_id, controller });
        const task = this.execute(run, controller.signal).finally(() => {
          this.active.delete(run.id); this.tasks.delete(task); this.enqueue();
        });
        this.tasks.add(task);
      }
    } finally { this.draining = false; }
  }

  private initialContext(run: Run): Message[] {
    const history = this.store.db.prepare(`SELECT role,content FROM messages WHERE thread_id=? AND kind='text' AND role IN ('user','assistant')
      AND seq <= COALESCE((SELECT seq FROM messages WHERE id=?),9223372036854775807) ORDER BY seq DESC LIMIT 40`).all(run.thread_id, run.trigger_message_id) as Message[];
    const profiles = this.store.db.prepare('SELECT a.name,a.role,a.system_prompt FROM agent_profiles a JOIN thread_participants p ON p.agent_id=a.id WHERE p.thread_id=? AND a.enabled=1').all(run.thread_id);
    return [{ role: 'system', content: `You are an autonomous agent. Work toward the user's goal using multiple tool steps. You have broad autonomy inside your own /workspace sandbox. Do not claim work succeeded without checking tool results. Do not seek access outside your sandbox. Network access depends on deployment configuration. Use wait for scheduled follow-up. Use send_message(kind="text") only when finished; progress continues. Ask the user when essential information is missing. Available tools are the only capabilities you have. Agent profiles: ${JSON.stringify(profiles)}` }, ...history.reverse().map((m) => ({ ...m, content: m.content?.slice(0, 12000) ?? '' }))];
  }

  private async execute(run: Run, signal: AbortSignal) {
    let context: Message[] = [];
    try {
      const owner = (this.store.db.prepare('SELECT owner_id FROM threads WHERE id=?').get(run.thread_id) as { owner_id: string }).owner_id;
      const config = this.configuration?.get(owner, true);
      const provider = config?.providers.find(p => p.id === config.llmModel.providerId);
      const model = config?.llmModel.model ?? process.env.MODEL_NAME ?? 'gpt-4o-mini';
      if (!(provider?.baseUrl || process.env.MODEL_API_KEY) || !model) throw new Error('model_not_configured');
      context = run.context_json ? JSON.parse(run.context_json) : this.initialContext(run);
      // Complete a persisted tool-call envelope after a crash, without re-executing the command.
      const last = context.at(-1);
      if (last?.tool_calls?.length) {
        for (const call of last.tool_calls) {
          const step = this.store.db.prepare('SELECT * FROM run_steps WHERE id=? AND run_id=?').get(call.id, run.id) as any;
          if (step?.status === 'waiting_approval') {
            const approval = this.store.db.prepare('SELECT status FROM approvals WHERE step_id=? AND run_id=?').get(step.id, run.id) as { status: string } | undefined;
            if (!approval || approval.status === 'pending') { this.store.db.prepare("UPDATE runs SET status='waiting_user' WHERE id=?").run(run.id); return; }
            const args = JSON.parse(step.arguments);
            const policy = this.configuration?.policy(owner, run.thread_id) ?? DEFAULT_AGENT_POLICY;
            const allowed = approval.status === 'approved' && policy.shell !== 'deny' && (!args.network || policy.network === 'allow');
            if (allowed) {
              this.store.db.prepare("UPDATE run_steps SET status='running' WHERE id=? AND status='waiting_approval'").run(step.id);
              step.result = JSON.stringify(await this.sandbox({ threadId: run.thread_id, executionId: step.id, command: args.command, network: args.network }, signal));
            } else step.result = 'Command denied by user or current policy.';
            this.store.db.prepare("UPDATE run_steps SET status='completed',result=?,completed_at=? WHERE id=?").run(step.result, now(), step.id);
            this.configuration?.audit(owner, 'shell.resolved', { step: step.id, allowed });
          }
          context.push({ role: 'tool', tool_call_id: call.id, content: step?.result ?? 'Interrupted before result was saved. Inspect workspace before retrying.' });
        }
        this.save(run, context);
      }
      const approvals = this.store.db.prepare("SELECT status,resolution FROM approvals WHERE run_id=? AND status!='pending'").all(run.id);
      if (approvals.length) context.push({ role: 'user', content: `Approval decisions: ${JSON.stringify(approvals)}` });
      const maxSteps = config?.policy.maxSteps ?? Math.max(1, Math.min(1000, Number(process.env.BOT_MAX_STEPS) || 100));
      while (!signal.aborted) {
        // Keep tool envelopes intact while bounding old command output in long tasks.
        for (let i = 1; i < context.length - 8; i++) {
          if (context[i].role === 'tool' && (context[i].content?.length ?? 0) > 2000) {
            context[i].content = `${context[i].content!.slice(0, 2000)}\n[Older output truncated; inspect workspace for full artifacts.]`;
          }
        }
        if (run.step_count >= maxSteps) {
          this.append(run.thread_id, 'text', `本次任务已达到 ${maxSteps} 步执行预算。工作区已保存，可以发送消息继续。`);
          this.finish(run.id, 'completed'); return;
        }
        const selected = provider ?? { protocol: 'openai-chat' as const, apiKey: process.env.MODEL_API_KEY };
        const scopeRow = this.store.db.prepare('SELECT mcp_server_ids FROM threads WHERE id=? AND owner_id=?').get(run.thread_id, owner) as { mcp_server_ids: string | null };
        const mcpScope = scopeRow.mcp_server_ids === null ? undefined : JSON.parse(scopeRow.mcp_server_ids) as string[];
        const catalog = await this.mcp?.catalog(owner, mcpScope);
        if (catalog?.warnings.length) this.append(run.thread_id, 'progress', `MCP: ${catalog.warnings.join('; ')}`);
        const request = botRequest(selected, model, context, [...tools, ...(catalog?.tools.map(mcpToolDefinition) ?? [])]);
        const response = await this.fetcher(`${provider?.baseUrl ?? process.env.MODEL_BASE_URL ?? 'https://api.openai.com/v1'}/${request.path}`, {
          method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1000, Number(process.env.MODEL_TIMEOUT_MS) || 30000))]),
          headers: request.headers,
          redirect: 'error',
          body: JSON.stringify(request.body),
        });
        if (!response.ok) throw new Error('model_request_failed');
        const body = await response.json() as any;
        const calls = botCalls(selected.protocol, body);
        if (!Array.isArray(calls) || calls.length !== 1 || !calls[0]?.function) throw new Error('invalid_structured_response');
        const call: Call = { id: crypto.randomUUID(), type: 'function', function: { name: calls[0].function.name, arguments: calls[0].function.arguments } };
        if (typeof call.function.arguments !== 'string' || call.function.arguments.length > 20000) throw new Error('invalid_structured_response');
        let args: any;
        try { args = JSON.parse(call.function.arguments); } catch { throw new Error('invalid_structured_response'); }
        if (!args || typeof args !== 'object') throw new Error('invalid_structured_response');
        signal.throwIfAborted();
        context.push({ role: 'assistant', content: null, tool_calls: [call] });
        run.step_count++;
        this.store.transaction(() => {
          this.save(run, context);
          this.store.db.prepare('INSERT INTO run_steps(id,run_id,tool,arguments,status,created_at) VALUES(?,?,?,?,?,?)').run(call.id, run.id, call.function.name, call.function.arguments, 'running', now());
        });
        let result = 'Unknown tool or invalid arguments.';
        let state: 'completed' | 'waiting_user' | 'queued' | undefined;
        let wake: string | null = null;
        if (call.function.name.startsWith('mcp_') && this.mcp) {
          const meta = catalog?.tools.find(t => t.name === call.function.name);
          this.append(run.thread_id, 'progress', `MCP · ${meta?.serverName ?? ''} / ${meta?.originalName ?? call.function.name}`);
          try {
            const latest = this.store.db.prepare('SELECT mcp_server_ids FROM threads WHERE id=? AND owner_id=?').get(run.thread_id, owner) as { mcp_server_ids: string | null };
            const response = await this.mcp.call(owner, call.function.name, args, latest.mcp_server_ids === null ? undefined : JSON.parse(latest.mcp_server_ids), signal);
            result = response.text;
            this.append(run.thread_id, 'progress', `MCP · ${response.serverName} / ${response.toolName} · ${response.isError ? 'Error' : 'OK'} · ${response.durationMs}ms`);
          } catch (error) { if (signal.aborted) throw error; result = `Error: ${mcpError(error)}`; }
        } else if (call.function.name === 'shell' && typeof args.command === 'string' && args.command.trim() && args.command.length <= 16000) {
          const policy = this.configuration?.policy(owner, run.thread_id) ?? DEFAULT_AGENT_POLICY;
          const network = policy.network === 'allow';
          if (policy.shell === 'ask') {
            this.store.transaction(() => {
              this.store.db.prepare("UPDATE run_steps SET status='waiting_approval',arguments=? WHERE id=?").run(JSON.stringify({ command: args.command, network }), call.id);
              const message = this.append(run.thread_id, 'approval', `请求执行命令（联网：${network ? '允许' : '禁止'}）：\n${args.command}`);
              this.store.db.prepare('INSERT INTO approvals(id,thread_id,message_id,run_id,step_id,status,created_at) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), run.thread_id, message.id, run.id, call.id, 'pending', now());
              this.store.db.prepare("UPDATE runs SET status='waiting_user' WHERE id=?").run(run.id);
            });
            this.configuration?.audit(owner, 'shell.requested', { step: call.id, command: args.command, network });
            return;
          }
          if (policy.shell === 'deny') result = 'Command denied by policy.';
          else {
          this.append(run.thread_id, 'progress', `执行第 ${run.step_count} 步：\n${args.command.slice(0, 2000)}`);
          try { result = JSON.stringify(await this.sandbox({ threadId: run.thread_id, executionId: call.id, command: args.command, network }, signal)); }
          catch { if (signal.aborted) throw new Error('cancelled'); throw new Error('sandbox_unavailable'); }
          }
        } else if (call.function.name === 'wait' && Number.isInteger(args.seconds) && args.seconds >= 1 && args.seconds <= 86400 && typeof args.reason === 'string') {
          wake = new Date(Date.now() + args.seconds * 1000).toISOString();
          result = `Scheduled wake: ${wake}`; state = 'queued';
          this.append(run.thread_id, 'progress', `${args.reason.slice(0, 2000)}（下次运行：${wake}）`);
        } else if (call.function.name === 'send_message' && ['text', 'progress', 'question', 'approval', 'attachment'].includes(args.kind) && typeof args.text === 'string' && args.text.length > 0 && args.text.length <= 12000) {
          const message = this.append(run.thread_id, args.kind, args.text);
          result = 'Message delivered.';
          if (args.kind === 'approval') {
            this.store.db.prepare('INSERT INTO approvals(id,thread_id,message_id,run_id,status,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), run.thread_id, message.id, run.id, 'pending', now());
            state = 'waiting_user';
          } else if (args.kind !== 'progress') state = 'completed';
        }
        signal.throwIfAborted();
        context.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, 16000) });
        this.store.transaction(() => {
          this.store.db.prepare("UPDATE run_steps SET result=?,status='completed',completed_at=? WHERE id=?").run(result.slice(0, 16000), now(), call.id);
          this.save(run, context);
          if (state) this.store.db.prepare("UPDATE runs SET status=?,wake_at=?,completed_at=? WHERE id=? AND status='running'").run(state, wake, state === 'completed' ? now() : null, run.id);
        });
        if (state) return;
      }
    } catch (error) {
      if (signal.aborted) {
        this.store.db.prepare("UPDATE run_steps SET status='interrupted',result=?,completed_at=? WHERE run_id=? AND status='running'").run('Interrupted. Inspect workspace before retrying; side effects may have occurred.', now(), run.id);
        if (this.stopped) this.store.db.prepare("UPDATE runs SET status='queued' WHERE id=? AND status='running'").run(run.id);
        return;
      }
      const code = error instanceof Error && ['model_not_configured', 'sandbox_unavailable', 'invalid_structured_response'].includes(error.message) ? error.message : 'model_request_failed';
      this.store.db.prepare("UPDATE run_steps SET status='failed',result=?,completed_at=? WHERE run_id=? AND status='running'").run(code, now(), run.id);
      this.append(run.thread_id, 'progress', code === 'sandbox_unavailable' ? '沙盒服务不可用，任务已停止。请检查后端沙盒配置。' : '模型暂时不可用，请稍后重试。');
      this.store.db.prepare("UPDATE runs SET status='failed',completed_at=?,error_code=? WHERE id=? AND status='running'").run(now(), code, run.id);
    }
  }

  private save(run: Run, context: Message[]) {
    this.store.db.prepare('UPDATE runs SET context_json=?,step_count=? WHERE id=?').run(JSON.stringify(context), run.step_count, run.id);
  }
  private finish(id: string, status: string) {
    this.store.db.prepare("UPDATE runs SET status=?,completed_at=? WHERE id=? AND status='running'").run(status, now(), id);
  }
  private append(threadId: string, kind: string, content: string) {
    return this.store.transaction(() => {
      const seq = (this.store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages WHERE thread_id=?').get(threadId) as { seq: number }).seq;
      const timestamp = now(); const id = crypto.randomUUID();
      const dto = { id, threadId, clientNonce: null, seq, role: 'assistant', kind, content, replyTo: null, createdAt: timestamp };
      this.store.db.prepare('INSERT INTO messages(id,thread_id,seq,role,kind,content,created_at) VALUES(?,?,?,?,?,?,?)').run(id, threadId, seq, 'assistant', kind, content, timestamp);
      this.store.db.prepare('INSERT INTO message_events(id,thread_id,seq,type,payload,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), threadId, seq, 'message.accepted', JSON.stringify(dto), timestamp);
      this.store.db.prepare('UPDATE threads SET updated_at=? WHERE id=?').run(timestamp, threadId);
      return dto;
    });
  }
}
