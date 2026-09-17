/**
 * 图表围栏的语言判定：```mermaid 与 ```svg 两种块级围栏共用同一套规则。
 *
 * 为什么单独抽一个**纯模块**（不 import React / mdui / mermaid / DOMPurify）：
 * 这是「提示词 ↔ 渲染层」之间的一条硬契约 —— 提示词（harness/prompts.ts 的 DIAGRAM_RULE）
 * 里写死了围栏名，前端只认这里放行的语言标记。两边对不上，模型输出的就是**一坨源码**
 * （比不画更糟）。而 markdown.tsx 依赖 mdui 自定义元素链，Node 里连 import 都过不去，
 * 所以把判定逻辑抽出来，让单测能在 Node 下直接守住这条契约（见 scripts/test-chat-frames.mjs）。
 */

/** 前端支持的图表围栏类型 */
export type DiagramKind = 'mermaid' | 'svg';

/**
 * 围栏语言可能是 `mermaid`，也可能带参数（如 `mermaid title=xx`），按**词首**匹配。
 *
 * 顺序即优先级；`\b` 保证 `svgb` / `mermaids` 这类不会被误判成图表围栏。
 */
const LANG_RULES: readonly (readonly [DiagramKind, RegExp])[] = [
  ['mermaid', /^\s*mermaid\b/i],
  ['svg', /^\s*svg\b/i],
];

/**
 * 判定一个 code / pre 元素是不是图表围栏。
 *
 * `block` 必须为真：行内 code（`` `svg` ``）不该被当成围栏。
 * XMarkdown 在 code 组件上挂了 `block` / `lang` 两个属性（见其 Parser 的 configureCodeRenderer）。
 *
 * @returns 图表类型；不是图表围栏时返回 null（普通代码块 / 行内 code 照旧渲染）
 */
export function diagramKindOf(props: { block?: unknown; lang?: unknown }): DiagramKind | null {
  if (!props.block) return null;
  const lang = String(props.lang ?? '');
  for (const [kind, re] of LANG_RULES) {
    if (re.test(lang)) return kind;
  }
  return null;
}
