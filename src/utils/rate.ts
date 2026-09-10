/**
 * 播放器倍速档位的纯逻辑（无 React / 无浏览器依赖，便于在 Node 下单测）。
 * 组件侧见 components/RateButtons.tsx。
 */

/** 内置倍速档位（含 4x 上限） */
export const PRESET_RATES = [1, 1.5, 2, 3, 4];

/** 自定义倍速合法区间：下限防 0/负数（原生 playbackRate 不接受），上限对齐内置最高档 */
export const MIN_RATE = 0.25;
export const MAX_RATE = 4;

/** 归一到两位小数并夹进合法区间（顺带抹掉 2.0000000001 这类浮点噪声） */
export function normalizeRate(value: number): number {
  return Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, value)) * 100) / 100;
}

/** 倍速等价比较（避开浮点误差） */
export function sameRate(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

/** 1 → "1x"，1.5 → "1.5x"，1.25 → "1.25x"（去掉尾零，避免出现 "2.00x"） */
export function formatRate(value: number): string {
  return `${Number(value.toFixed(2))}x`;
}

/** 内置档位 ∪ 自定义档位：归一 + 去重 + 升序（避免自定义录入 2 后按钮栏里出现两个 2x） */
export function mergeRates(preset: readonly number[], custom: readonly number[]): number[] {
  const merged = [...preset, ...custom].map(normalizeRate).filter((r) => Number.isFinite(r));
  return [...new Set(merged)].sort((a, b) => a - b);
}

/** 取比当前倍速大的下一档，超出最大档则回到最小档（当前值不在档位里也能工作） */
export function nextRateOf(rates: readonly number[], current: number): number {
  return rates.find((r) => r > current + 1e-6) ?? rates[0];
}
