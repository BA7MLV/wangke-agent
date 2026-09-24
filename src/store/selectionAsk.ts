import { create } from 'zustand';
import type { RegionImage } from '../materials/region';

/**
 * 选区提问的**投递通道**。
 *
 * 为什么需要一个 store：`send()` 在 `ChatPanel` 内部（940 行的组件，动它风险最大），
 * 而选区来自 Player 的另一棵子树（PDF 阅读器 / Word 阅读器 / 字幕面板 / 讲义预览）。
 * 与其把 `send` 提升重写，不如用一个小 store 做投递：
 *
 * - 浮层/框选 → `ask(cite, mode)`
 * - `Player` 订阅 `pending` → 切到「问答」面板（移动端浮层点完必须能看到问答）
 * - `ChatPanel` 订阅 `pending` → 压入引用条；`explain` 直接发送，`compose` 只聚焦输入框
 *
 * 用状态而不是 ref/自定义事件：桌面端 `mdui-tab-panel` 与移动端 `panel-slot` 都用
 * `hidden`/`display:none` **保活**（面板组件始终挂着），所以 ChatPanel 一定收得到；
 * 走 DOM 事件则在面板被隐藏时时序很脆。
 */

export type AskSource = 'pdf' | 'docx' | 'md' | 'handout' | 'subtitle';

export interface Citation {
  /** 选中的原文（已归一化、限长） */
  text: string;
  source: AskSource;
  /** 展示用位置：「第 3 页」/「§2.1 第 4 段」/「03:25」 */
  unitLabel?: string;
  /** 定位单元（材料：页/段序号；视频类来源无此值） */
  unit?: number;
  /** 定位时间（秒）——字幕/讲义来源有 */
  time?: number;
  /** 框选裁图（PDF）；Word/讲义没有画布可裁，只有文字 */
  image?: RegionImage;
}

export type AskMode = 'explain' | 'compose';

interface BarState {
  cite: Citation;
  /** 视口坐标（浮层锚点） */
  anchor: { x: number; y: number };
}

interface SelectionAskStore {
  /** 待投递的引用；ChatPanel 消费后清空 */
  pending: { cite: Citation; mode: AskMode } | null;
  /** 浮层展示请求（框选直接投这条，让两种入口的动作条长得一样） */
  bar: BarState | null;
  ask: (cite: Citation, mode: AskMode) => void;
  showBar: (cite: Citation, anchor: { x: number; y: number }) => void;
  hideBar: () => void;
  take: () => void;
}

export const useSelectionAsk = create<SelectionAskStore>()((set) => ({
  pending: null,
  bar: null,
  ask: (cite, mode) => set({ pending: { cite, mode }, bar: null }),
  showBar: (cite, anchor) => set({ bar: { cite, anchor } }),
  hideBar: () => set({ bar: null }),
  take: () => set({ pending: null }),
}));

/**
 * 引用块文本：喂给模型的样子。
 *
 * 用 blockquote + 明确的来源行，而不是把原文直接拼进问题里 ——
 * 模型能清楚区分「这是引用」与「这是提问」，回答里也就更愿意标注来源页码。
 */
export function formatCitation(cite: Citation): string {
  const head = cite.unitLabel ? `[选自 ${cite.unitLabel}]` : '[选自课程内容]';
  return `> ${head}\n> ${cite.text.replace(/\n/g, '\n> ')}`;
}

/** 「解释这段」用的默认提问；用户自己补问时走 compose 模式，不用这条 */
export const EXPLAIN_PROMPT = '请解释这段内容的含义，并结合课程上下文说明它为什么重要。';

/** 引用条最多堆几条：再多会把输入区顶得很高，且一次问 3 段以上通常该拆开问 */
export const MAX_REFS = 3;
