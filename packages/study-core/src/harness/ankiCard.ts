/** Anki 问答卡候选：数据结构 + LLM 输出清洗。纯模块无运行时依赖，Node 下可直接单测。 */
// 注：本文件被 node 测试脚本直接 import（type stripping），相对导入必须带 .ts 扩展名
import { parseTs } from '../utils/linkify.ts';

/** 一张待入库的问答卡（审核前/后的公共形状；落库时补 status/createdAt） */
export interface CardDraft {
  /** 问题（正面） */
  q: string;
  /** 答案（背面） */
  a: string;
  /** 考点对应的字幕时间（秒） */
  time: number;
}

/** 单张候选卡的长度约束（字） */
export const CARD_LIMITS = { qMin: 4, qMax: 120, aMin: 1, aMax: 200 } as const;

/** 时间戳钳制容差（秒），与弹幕一致 */
const TIME_TOLERANCE = 30;

/** 从 LLM 输出中稳健提取 JSON 数组（剥 ```json 围栏，取首个 [ 到末个 ]） */
export function extractJsonArray(text: string): unknown[] {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 清洗一张 LLM 输出的候选卡；非法返回 null（流水线逐张跳过，不整批失败）。
 * range 提供时，time 必须落在 [start-30, end+30] 内（钳制容差与弹幕一致）。
 */
export function cleanCard(raw: unknown, range?: { start: number; end: number }): CardDraft | null {
  const o = raw as Record<string, unknown> | null;
  const q = typeof o?.q === 'string' ? o.q.trim() : '';
  const a = typeof o?.a === 'string' ? o.a.trim() : '';
  if (q.length < CARD_LIMITS.qMin || a.length < CARD_LIMITS.aMin) return null;
  const time = parseTs(String(o?.time ?? ''));
  if (!Number.isFinite(time) || time < 0) return null;
  if (range && (time < range.start - TIME_TOLERANCE || time > range.end + TIME_TOLERANCE)) return null;
  return { q: q.slice(0, CARD_LIMITS.qMax), a: a.slice(0, CARD_LIMITS.aMax), time };
}

/** 规范化问题文本（去空白/标点、小写），用于判重 */
function normQ(q: string): string {
  return q.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 按时间排序 + 规范化问题去重（模型可能跨块重复出题；保留先出现的） */
export function dedupeCards(cards: CardDraft[]): CardDraft[] {
  const sorted = [...cards].sort((a, b) => a.time - b.time);
  const seen = new Set<string>();
  const out: CardDraft[] = [];
  for (const c of sorted) {
    const key = normQ(c.q);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
