/**
 * 材料的「定位单元」抽象：PDF 用页、Word 用段落。
 *
 * 与 `utils/vtt.ts` 的 `fmtTime` 对称 —— 那边把秒格式化成 `mm:ss`，
 * 这边把单元号格式化成「第 3 页」；那边的引用标记是 `[03:25]`，这边是 `[第3页]`。
 *
 * 约束：本文件被 node 测试脚本直接 import（type stripping），
 * 相对导入必须带 `.ts` 扩展名，且**不允许依赖 DOM**。
 */

export type UnitKind = 'page' | 'para';

/** 单元的量词：页码用「页」，段落用「段」 */
export function unitNoun(kind: UnitKind): string {
  return kind === 'page' ? '页' : '段';
}

/**
 * 引用标记（模型输出、linkify 匹配都用这一个来源，避免两处正则各写一遍漂移）。
 *
 * 容忍模型输出的空格差异：`[第3页]` / `[第 3 页]` / `[ 第3页 ]` 都认。
 * 不做 global 复用：RegExp 带 g 时有 lastIndex 状态，共享会踩坑，因此每次新建。
 */
export function unitRefRe(kind: UnitKind): RegExp {
  return new RegExp(`\\[\\s*第\\s*(\\d{1,4})\\s*${unitNoun(kind)}\\s*\\]`, 'g');
}

/** 生成引用标记：`第3页`（紧凑形式，供提示词与 linkify 生成目标使用） */
export function fmtUnitRef(kind: UnitKind, n: number): string {
  return `第${n}${unitNoun(kind)}`;
}

/**
 * 生成位置描述（给人看的，带空格更易读）：`第 3 页`。
 * `section` 用于 Word：`§2.1 第 4 段`。
 */
export function fmtUnitLabel(kind: UnitKind, n: number, section?: string): string {
  const base = `第 ${n} ${unitNoun(kind)}`;
  return section ? `${section} ${base}` : base;
}

/** 从引用标记里反解单元号（如 `第3页` → 3）；不是该类型的引用则返回 null */
export function parseUnitRef(raw: string, kind: UnitKind): number | null {
  const m = new RegExp(`^\\s*第\\s*(\\d{1,4})\\s*${unitNoun(kind)}\\s*$`).exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 抽出文本里出现的全部单元号（校验模型有没有编造页码用） */
export function extractUnitRefs(text: string, kind: UnitKind): number[] {
  const re = unitRefRe(kind);
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(Number(m[1]));
  return out;
}

/** 把单元号夹到 [1, max]；max 未知（0/undefined）时只保证下界 */
export function clampUnit(n: number, max?: number): number {
  const v = Math.max(1, Math.floor(n));
  return max && max > 0 ? Math.min(v, max) : v;
}
