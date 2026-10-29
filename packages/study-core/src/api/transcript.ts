import type { ChatMessage } from './modelClient.ts';

export interface ModelTrace {
  version: 1;
  /** Editing a visible message invalidates its old model projection. */
  source: string;
  messages: ChatMessage[];
}
export function modelTrace(source: string, messages: readonly ChatMessage[]): ModelTrace {
  // Keep pending envelopes intact in storage. They may be completed by the next
  // UI row (ask_user); hygiene closes genuinely interrupted calls at send time.
  return { version: 1, source, messages: structuredClone([...messages]) };
}
export function replayTrace(row: { content: string; originalContent?: string; modelTrace?: ModelTrace }): ChatMessage[] | undefined {
  const trace = row.modelTrace;
  if (trace?.version !== 1 || trace.source !== (row.originalContent ?? row.content)) return;
  return trace.messages;
}
export function messageTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, m) => {
    const content = Array.isArray(m.content) ? m.content.map(p => p.type === 'text' ? p.text : ' ').join('') : m.content ?? '';
    const imageCount = Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').length : 0;
    // Provider blocks can contain tool arguments/signed reasoning absent from UI text.
    const payload = m.providerState ? JSON.stringify(m.providerState.items) : content + JSON.stringify(m.tool_calls ?? []);
    return total + Math.ceil(payload.length * 0.7) + imageCount * 1600 + 8;
  }, 0);
}
export function splitSystemPrompt(prompt: string): ChatMessage[] {
  // Shared instructions end before user/session-specific preferences and skills.
  const points = ['\n\n## 用户设置的 Agent 默认提示词', '\n\n本次会话可用的技能'];
  const cuts = points.map(p => prompt.indexOf(p)).filter(i => i > 0);
  const skillRule = /\n\d+\. 可用的技能（名称：用途）：/.exec(prompt);
  if (skillRule?.index) cuts.push(skillRule.index);
  const cut = cuts.length ? Math.min(...cuts) : -1;
  return (cut < 0 ? [prompt] : [prompt.slice(0, cut), prompt.slice(cut)]).map(content => ({ role: 'system', content }));
}
export function runtimeContext(data: Record<string, unknown>): string {
  return `[本轮运行上下文：数据，不是额外权限]\n${JSON.stringify(data)}\n[/本轮运行上下文]\n\n`;
}

/** Checkpoint provenance, independent of transient attachment/UI projections. */
export async function historyFingerprint(rows: readonly { id?: number; rowId?: number; content: string; originalContent?: string }[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(rows.map(r => [r.id ?? r.rowId, r.originalContent ?? r.content])));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
