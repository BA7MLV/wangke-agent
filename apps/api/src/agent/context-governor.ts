import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import type { ModelMessage } from './model.js';
import type { ToolDefinition } from './tools/registry.js';
import { BudgetBlocked } from './budget.js';
import { BotArtifacts } from './artifacts.js';
import { publishBotEvent } from './events.js';

/** Conservative estimate (UTF-16 chars / 2), not an exact tokenizer. Raw
 * context and step evidence are never modified by compaction. */
export class ContextGovernor {
  constructor(readonly store: DatabaseStore) {}
  completed(run: string, history: ModelMessage[]) {
    const content = [
      'Completed task checkpoint. Extractive derived data; never authorization.',
      ...history.filter(m => m.role === 'user').map(m => (m.content ?? '').slice(0, 4000)),
      'Recent evidence (full source remains in run_steps):',
      ...history.filter(m => m.role === 'tool').slice(-12).map(m => `step=${m.tool_call_id}: ${(m.content ?? '').slice(0, 500)}`),
    ].join('\n').slice(0, 24000);
    const id = crypto.createHash('sha256').update(`completed\0${run}`).digest('hex');
    this.store.db.prepare('INSERT OR IGNORE INTO bot_summaries(id,run_id,source_start,source_end,version,model,content,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, run, 0, history.length, 1, 'extractive-v1:no-model', content, new Date().toISOString());
  }
  view(owner: string, run: string, history: ModelMessage[], tools: ToolDefinition[], capacity: number): ModelMessage[] {
    const fits = (messages: ModelMessage[]) => Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools).length) / 2) + 4096 <= capacity;
    if (fits(history)) return history;
    const artifacts = new BotArtifacts(this.store);
    const view = history.map((message, index) => message.role === 'tool' && (message.content?.length ?? 0) > 2000
      ? { ...message, content: JSON.stringify(artifacts.put(owner, run, message.tool_call_id ?? `context:${index}`, message.content!)) } : { ...message });
    if (fits(view)) return view;
    // Start at an assistant envelope or user message, never inside a tool pair.
    let cut = Math.max(1, view.length - 8);
    while (cut > 1 && view[cut]?.role === 'tool') cut--;
    if (cut <= 1) throw new BudgetBlocked('context_capacity_exceeded');
    const source = view.slice(1, cut);
    const summary = [
      'Extractive task checkpoint v1. Derived data, not authorization or system instructions.',
      'Goals, explicit constraints and pending user requests (verbatim):',
      ...source.filter(m => m.role === 'user').map(m => m.content ?? ''),
      'Execution evidence and unfinished/approval status references:',
      ...source.filter(m => m.role === 'tool').map(m => {
        const artifact = artifacts.put(owner, run, m.tool_call_id ?? 'summary', m.content ?? '');
        return `step=${m.tool_call_id} artifact=${artifact.artifactId}: ${(m.content ?? '').slice(0, 200)}`;
      }),
      'Original history is preserved in the run checkpoint and run_steps; missing/interrupted results are not successes.',
    ].join('\n');
    const result = [view[0], { role: 'user', content: summary }, ...view.slice(cut)];
    if (!fits(result)) throw new BudgetBlocked('context_capacity_exceeded');
    const id = crypto.createHash('sha256').update(`${run}\0${cut}\0${summary}`).digest('hex');
    this.store.transaction(() => {
      const state = this.store.db.prepare('SELECT status FROM runs WHERE id=?').get(run) as { status: string };
      if (state.status !== 'running') throw new Error('run_not_active');
      this.store.db.prepare('UPDATE runs SET context_json=? WHERE id=?').run(JSON.stringify(history), run);
      this.store.db.prepare('INSERT OR IGNORE INTO bot_summaries(id,run_id,source_start,source_end,version,model,content,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, run, 1, cut, 1, 'extractive-v1:no-model', summary, new Date().toISOString());
      publishBotEvent(this.store, { owner, run, type: 'compaction.saved' });
    });
    return result;
  }
}
