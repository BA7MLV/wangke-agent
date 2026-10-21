import type { ChatToolCall } from '../store/db';
import { toolDisplay } from './toolTrace';

/** 仅用于流式视图；结束状态由 streaming 决定，不持久化瞬态。 */
export type ProcessPhase = 'preparing' | 'thinking' | 'tool' | 'answering';

export type ProcessStep =
  | { kind: 'reasoning'; key: string; text: string }
  | { kind: 'tool'; key: string; call: ChatToolCall };

/** 保存偏移而不重复保存推理正文。老数据不猜顺序，回落为分析记录 + 工具列表。 */
export function processSteps(reasoning: string, calls: ChatToolCall[]): ProcessStep[] {
  const steps: ProcessStep[] = [];
  let cursor = 0;
  const ordered = calls.every((call) => call.reasoningOffset != null);
  const appendReasoning = (end: number) => {
    const text = reasoning.slice(cursor, end);
    if (text.trim()) steps.push({ kind: 'reasoning', key: `reasoning-${cursor}`, text });
    cursor = end;
  };
  if (!ordered) appendReasoning(reasoning.length);
  calls.forEach((call, index) => {
    if (ordered) appendReasoning(Math.max(cursor, Math.min(reasoning.length, call.reasoningOffset!)));
    steps.push({ kind: 'tool', key: `tool-${index}`, call });
  });
  appendReasoning(reasoning.length);
  return steps;
}

export function processTitle({ streaming, phase, calls, hint, waiting }: {
  streaming: boolean;
  phase?: ProcessPhase;
  calls: ChatToolCall[];
  hint?: string;
  waiting?: boolean;
}): string {
  if (waiting) return calls.some((call) => call.name === 'ask_user' && call.status === 'running')
    ? '等待你的回答' : '等待你的确认';
  if (!streaming) return '思考过程';
  const acting = calls.find((call) => call.status === 'running');
  if (acting && (!phase || phase === 'tool')) {
    if (acting.name === 'ask_user') return '等待你的回答';
    const { label, detail } = toolDisplay(acting.name, acting.detail);
    return `正在${label}${detail ? `：${detail}` : '…'}`;
  }
  if (phase === 'thinking') return '正在思考';
  if (phase === 'answering') return '正在组织回答';
  return hint || '正在准备下一步';
}
