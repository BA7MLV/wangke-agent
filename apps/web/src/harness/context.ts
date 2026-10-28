import type { SegmentRow } from '../store/db';

/** 粗略 token 估算：中文为主，字符数 × 0.7；仅用于 UI 提示与历史截断 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.7);
}

/** 按 token 预算从最新往最旧选取历史消息（替代硬切最近 20 条） */
export function fitHistoryToBudget<T extends { content: string }>(rows: T[], budgetTokens: number): T[] {
  const out: T[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const t = estimateTokens(rows[i].content);
    if (used + t > budgetTokens && out.length > 0) break;
    used += t;
    out.unshift(rows[i]);
  }
  return out;
}

/**
 * 截图时刻的字幕上下文：从 ts 所在段起，向前后按完整 VAD 段扩展，
 * 累计 maxChars 字封顶。多时刻窗口重叠时合并（调用方去重 idx）。
 */
export function subtitleWindow(segments: SegmentRow[], ts: number, maxChars = 800): SegmentRow[] {
  if (segments.length === 0) return [];
  let center = segments.findIndex((s) => ts >= s.start && ts < s.end);
  if (center < 0) {
    center = segments.reduce(
      (best, s, i) => (Math.abs(s.start - ts) < Math.abs(segments[best].start - ts) ? i : best),
      0,
    );
  }
  // 集合统一存 SegmentRow.idx（输入为单视频按 idx 排序的段；切片传入时 idx ≠ 数组下标）
  const picked = new Set<number>([segments[center].idx]);
  let total = segments[center].text.length;
  let lo = center - 1;
  let hi = center + 1;
  // 扩展循环：每轮先试离 ts 近的一侧，装不下再试远侧，两侧都装不下才 break。
  // total 只增不减，本轮装不下的段之后也装不下，故「每轮重试」与「超预算即永久排除该侧」
  // 可观测行为一致；且每轮要么选中一段（段数有界）要么 break，循环必然终止。
  for (;;) {
    const nextHi = hi < segments.length ? segments[hi] : null;
    const nextLo = lo >= 0 ? segments[lo] : null;
    if (!nextHi && !nextLo) break;
    const dHi = nextHi ? Math.abs(nextHi.start - ts) : Infinity;
    const dLo = nextLo ? Math.abs(ts - nextLo.end) : Infinity;
    const near = dHi <= dLo ? nextHi : nextLo;
    const far = near === nextHi ? nextLo : nextHi;
    const cand =
      near && total + near.text.length <= maxChars
        ? near
        : far && total + far.text.length <= maxChars
          ? far
          : null;
    if (!cand) break;
    picked.add(cand.idx);
    total += cand.text.length;
    if (cand === nextHi) hi++;
    else lo--;
  }
  return segments.filter((s) => picked.has(s.idx));
}
