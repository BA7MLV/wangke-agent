/**
 * 主页进度条的**纯逻辑**（不碰 DB、不碰 DOM，Node 里可直接跑，
 * 见 scripts/test-video-progress.mjs）。
 *
 * 这里只回答一个问题：**这根条该不该画、画多长**。
 * 数据从哪来（`videos.lastPosition` / `finished`）、画在哪儿（缩略图底边）
 * 分别属于 store/db.ts 与 pages/Library.tsx。
 *
 * 设计文档：docs/plans/2026-09-18-home-progress-bar-design.md
 */

/**
 * 进度至少要占到整条的 1% 才画。
 *
 * 40 分钟的课看了 5 秒是 0.2%，画出来是不到 1px 的一丝 —— 既看不清，
 * 也让人以为渲染坏了。**但不能用 `min-width: 2px` 去补救**：那会把「看了 5 秒」
 * 画成「看了 1%」，属于把错误藏起来。宁可不出条（与「没看过」同形）——
 * 这两者在 1px 的精度下本来就没有可分辨的差别。
 */
export const MIN_VISIBLE_RATIO = 0.01;

/** 算进度需要的字段（`VideoRow` 的子集，故意不依赖那个类型，便于单测造数据） */
export interface ProgressInput {
  /** 秒；材料恒为 0 */
  duration: number;
  /** 秒；真实播放位置，播完停在结尾 */
  lastPosition?: number;
  /** 1 = 本轮已看完 */
  finished?: 0 | 1;
  /** 不设视为 'video' */
  kind?: 'video' | 'material';
}

/**
 * 进度条比例。**返回 `null` = 不该画这根条**（调用方据此不渲染元素，
 * 而不是渲染一条 0 宽度的 —— 那会把「看了 2 秒」和「没看过」渲染成同一个东西）。
 *
 * 判断顺序是有讲究的：
 * 1. **材料先排除**：它的进度是 `lastUnit / unitCount`（页 / 段），另一套口径，本次不做。
 * 2. **`duration` 合法性在 `finished` 之前**：时长没探到（0 / NaN）说明这条记录本身残缺，
 *    列表里连时长都显示成「—」，给它画一条满条只会更怪。
 * 3. **`finished` 在比例计算之前**：万一 `lastPosition` 是 0（改动前「播完归零」写下的
 *    历史数据），标记仍能把它纠正成满条。
 * 4. 最后夹取 `0..1`：时长探测有误差，`lastPosition` 略大于 `duration` 会算出 100.4%。
 */
export function progressRatio(row: ProgressInput): number | null {
  if (row.kind === 'material') return null;

  const { duration, lastPosition } = row;
  if (!Number.isFinite(duration) || duration <= 0) return null;

  if (row.finished === 1) return 1;

  if (typeof lastPosition !== 'number' || !Number.isFinite(lastPosition) || lastPosition <= 0) {
    return null;
  }

  const ratio = lastPosition / duration;
  if (ratio < MIN_VISIBLE_RATIO) return null;

  return Math.min(1, ratio);
}
