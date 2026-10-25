import { validateWidgetArgs } from './widget.ts';

/** 提问协议。旧卡片的字符串选项仍可读取，新问题使用稳定 ID。 */
export type AskUserType = 'single' | 'multiple' | 'text' | 'confirm';
export interface AskOption { id: string; label: string }
export interface AskUserData {
  question: string;
  type?: AskUserType;
  options: (AskOption | string)[];
  allowCustom?: boolean;
  allowSkip?: boolean;
  minSelections?: number;
  maxSelections?: number;
  /** Optional, untrusted presentation; the structured question remains authoritative. */
  presentation?: { html: string };
}
export interface AskUserAnswer {
  status: 'answered' | 'skipped' | 'declined' | 'cancelled';
  mode: 'selection' | 'custom' | 'text';
  selectedIds: string[];
  selectedLabels: string[];
  text: string;
  note: string;
}
export type AskUserValidation = { ok: true; ask: AskUserData } | { ok: false; error: string };
export const MIN_ASK_OPTIONS = 2;
export const MAX_ASK_OPTIONS = 5;

export function askOptions(ask: AskUserData): AskOption[] {
  return ask.options.map((o, i) => typeof o === 'string' ? { id: `option-${i + 1}`, label: o } : o);
}

export function validateAskUser(raw: unknown): AskUserValidation {
  const fail = (error: string): AskUserValidation => ({ ok: false, error });
  if (!raw || typeof raw !== 'object') return fail('question（题面）不能为空');
  const a = raw as Record<string, unknown>;
  const question = typeof a.question === 'string' ? a.question.trim() : '';
  if (!question) return fail('question（题面）不能为空');
  if (question.length > 200) return fail('question 超过 200 字，请改成一句话');
  const type = (a.type ?? 'single') as AskUserType;
  if (!['single', 'multiple', 'text', 'confirm'].includes(type)) return fail('type 必须是 single、multiple、text 或 confirm');
  let options: AskOption[] = [];
  if (type === 'confirm') {
    options = [
      { id: 'confirm', label: typeof a.confirmLabel === 'string' ? a.confirmLabel.trim() : '确认继续' },
      { id: 'decline', label: typeof a.declineLabel === 'string' ? a.declineLabel.trim() : '暂不执行' },
    ];
  } else if (type !== 'text') {
    const items = Array.isArray(a.options) ? a.options : [];
    if (items.length < MIN_ASK_OPTIONS || items.length > MAX_ASK_OPTIONS) return fail(`options 必须有 2~5 个选项（收到 ${items.length} 个）`);
    for (const [i, item] of items.entries()) {
      const o = typeof item === 'string' ? { id: `option-${i + 1}`, label: item } : item;
      if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !o.id.trim() || typeof o.label !== 'string') return fail(`第 ${i + 1} 个选项需要非空 id 和 label，选项不能为空`);
      options.push({ id: o.id.trim(), label: o.label.trim().replace(/\s+/g, ' ') });
    }
  }
  if (options.some(o => !o.label)) return fail('选项不能为空');
  if (new Set(options.map(o => o.id)).size !== options.length || new Set(options.map(o => o.label)).size !== options.length) return fail('选项 ID 和文案不能重复');
  const long = options.findIndex(o => o.label.length > 60);
  if (long >= 0) return fail(`第 ${long + 1} 个选项超过 60 字，请改写成更短的方案名`);
  const minSelections = type === 'multiple' ? (a.minSelections ?? 1) as number : 1;
  const maxSelections = type === 'multiple' ? (a.maxSelections ?? options.length) as number : 1;
  if (type === 'multiple' && (!Number.isInteger(minSelections) || !Number.isInteger(maxSelections) || minSelections < 1 || maxSelections < minSelections || maxSelections > options.length)) return fail('选择数量必须满足 1 ≤ minSelections ≤ maxSelections ≤ 选项数');
  // A broken optional presentation must never prevent answering the native question.
  const html = (a.presentation as { html?: unknown } | null)?.html;
  const visual = typeof html === 'string' ? validateWidgetArgs({ format: 'html', code: html }) : null;
  return { ok: true, ask: { question, type, options, allowCustom: type !== 'confirm' && a.allowCustom !== false, allowSkip: a.allowSkip === true, minSelections, maxSelections,
    ...(visual?.ok ? { presentation: { html: visual.args.code } } : {}) } };
}

/** 所有入口共用校验，显示文案从原问题取，不能由答案伪造。 */
export function validateAskAnswer(ask: AskUserData, input: AskUserAnswer | string): AskUserAnswer {
  return normalizeAnswer(ask, input, false);
}

/** In-progress input may be empty; permissions, IDs and upper bounds still apply. */
export function normalizeAskDraft(ask: AskUserData, input: unknown): AskUserAnswer {
  return normalizeAnswer(ask, input as AskUserAnswer, true);
}

function normalizeAnswer(ask: AskUserData, input: AskUserAnswer | string, draft: boolean): AskUserAnswer {
  if (typeof input !== 'string' && (!input || typeof input !== 'object'
    || !['answered', 'skipped', 'declined', 'cancelled'].includes(input.status)
    || !['selection', 'custom', 'text'].includes(input.mode)
    || !Array.isArray(input.selectedIds) || input.selectedIds.some(id => typeof id !== 'string')
    || typeof input.text !== 'string' || typeof input.note !== 'string')) throw new Error('作答格式无效');
  const type = ask.type ?? 'single';
  const options = askOptions(ask);
  const match = typeof input === 'string' ? options.find(o => o.label === input.trim()) : undefined;
  const answer: AskUserAnswer = typeof input === 'string'
    ? { status: 'answered', mode: match ? 'selection' : type === 'text' ? 'text' : 'custom', selectedIds: match ? [match.id] : [], selectedLabels: [], text: match ? '' : input.trim(), note: '' }
    : { status: input.status, mode: input.mode, selectedIds: [...input.selectedIds], selectedLabels: [],
      text: draft ? input.text : input.text.trim(), note: draft ? input.note : input.note.trim() };
  if (answer.text.length > 4000 || answer.note.length > 2000 || answer.selectedIds.length > MAX_ASK_OPTIONS) throw new Error('作答内容过长');
  if (answer.status === 'skipped') {
    if (draft) throw new Error('请在原生题卡中跳过或取消');
    if (!ask.allowSkip) throw new Error('这个问题需要回答后才能继续');
    return { status: 'skipped', mode: 'text', selectedIds: [], selectedLabels: [], text: '', note: '' };
  }
  if (answer.status === 'cancelled') {
    if (draft) throw new Error('请在原生题卡中跳过或取消');
    return { status: 'cancelled', mode: 'text', selectedIds: [], selectedLabels: [], text: '', note: '' };
  }
  const selected = answer.selectedIds.map(id => options.find(o => o.id === id));
  const max = type === 'multiple' ? ask.maxSelections ?? options.length : type === 'text' ? 0 : 1;
  if (selected.some(o => !o) || new Set(answer.selectedIds).size !== selected.length || selected.length > max) throw new Error('选项 ID 无效、重复或超过数量上限');
  if (answer.mode === 'selection') {
    const min = type === 'multiple' ? ask.minSelections ?? 1 : 1;
    const max = type === 'multiple' ? ask.maxSelections ?? options.length : 1;
    if (type === 'text' || (!draft && selected.length < min)) throw new Error(`请选择 ${min === max ? min : `${min}–${max}`} 项`);
    answer.selectedLabels = selected.map(o => o!.label);
    answer.text = '';
    answer.status = type === 'confirm' && answer.selectedIds[0] === 'decline' ? 'declined' : 'answered';
  } else {
    if (type === 'confirm' || (type !== 'text' && ask.allowCustom === false)) throw new Error('请使用问题卡中的选项回答');
    if (!draft && !answer.text) throw new Error('请填写你的回答');
    answer.mode = type === 'text' ? 'text' : 'custom';
    answer.status = 'answered';
    answer.selectedIds = [];
    answer.selectedLabels = [];
  }
  return answer;
}

export function askAnswerText(answer: AskUserAnswer): string {
  if (answer.status === 'skipped') return '跳过这个问题';
  if (answer.status === 'cancelled') return '取消本次作答';
  return [answer.mode === 'selection' ? answer.selectedLabels.join('、') : answer.text, answer.note].filter(Boolean).join('\n补充：');
}

export function askUserToolResult(answer: AskUserAnswer | string): string {
  if (typeof answer !== 'string') return JSON.stringify(answer);
  const value = answer.trim();
  return value ? `用户选择了：「${value}」。` : '用户没有回答这个问题。请依据已有信息回答，并说明你做的假设。';
}
