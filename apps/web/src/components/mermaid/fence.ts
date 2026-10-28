/**
 * 图表围栏的语言判定与元信息解析：```mermaid / ```diagram / ```svg 三种块级围栏共用。
 *
 * 为什么单独抽一个**纯模块**（不 import React / mdui / mermaid / DOMPurify）：
 * 这是「提示词 ↔ 渲染层」之间的一条硬契约 —— 提示词（harness/prompts.ts 的 DIAGRAM_RULE）
 * 里写死了围栏名，前端只认这里放行的语言标记。两边对不上，模型输出的就是**一坨源码**
 * （比不画更糟）。而 markdown.tsx 依赖 mdui 自定义元素链，Node 里连 import 都过不去，
 * 所以把判定逻辑抽出来，让单测能在 Node 下直接守住这条契约（见 scripts/test-chat-frames.mjs）。
 *
 * 两个导出：`diagramKindOf`（是哪种图）与 `fenceTitleOf`（这张图叫什么）。后者与
 * show_widget 预检（harness/widget.ts）**必须同一份口径** —— 预检通过后回给模型的
 * 围栏里也要带着标题，否则模型「原样贴进正文」时标题就丢了。
 *
 * 三种围栏的分工（提示词侧的口径，细节在「讲解配图」技能）：
 * - `mermaid`：标准结构图（flowchart / sequenceDiagram / stateDiagram-v2 / mindmap / pie）；
 * - `diagram`：**JSON 中间层**。函数图像、几何图形、坐标轴，以及需要精确定位的
 *   结构图。模型只写 JSON，布局/坐标/采样由渲染器算（components/mermaid/diagramRender.ts）；
 * - `svg`：模型直出裸 SVG。**历史数据兼容**保留着 —— 2026-10-13 之前存入 IndexedDB 的
 *   问答/题卡里可能有这种围栏，去掉它们会渲染成一坨源码。新内容不再教这条（见 DIAGRAM_RULE）。
 */

import { isSvgCode } from '../../utils/artifactEdit';

/** 前端支持的图表围栏类型 */
export type DiagramKind = 'mermaid' | 'diagram' | 'svg';

/**
 * 围栏语言可能是 `mermaid`，也可能带参数（如 `mermaid title=xx`），按**词首**匹配。
 *
 * 顺序即优先级；`\b` 保证 `svgb` / `mermaids` 这类不会被误判成图表围栏。
 */
const LANG_RULES: readonly (readonly [DiagramKind, RegExp])[] = [
  ['mermaid', /^\s*mermaid\b/i],
  ['diagram', /^\s*diagram\b/i],
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
export function diagramKindOf(props: { block?: unknown; lang?: unknown; children?: unknown }): DiagramKind | null {
  if (!props.block) return null;
  const lang = String(props.lang ?? '');
  for (const [kind, re] of LANG_RULES) {
    if (re.test(lang)) return kind;
  }
  return isSvgCode(lang, props.children) ? 'svg' : null;
}

// ───────────────────────────────────────────────────────────────────────────────
// 围栏标题：```diagram title="抛物线开口方向"
// ───────────────────────────────────────────────────────────────────────────────

/**
 * 标题长度上限。模型偶尔会把整段结论塞进 title —— 块头一行放不下（会把标题栏撑成两行），
 * 下载的文件名也会长得离谱。超了**截断**而不是丢弃：图表还在，别因为标题长就不显示。
 */
export const MAX_FENCE_TITLE = 40;

/**
 * 取 `title=` 的值。三种写法照 HTML 的属性来，优先级即书写顺序：
 * `title="…"`（可含空格与 `=`）/ `title='…'` / 裸值 `title=…`（到空白为止）。
 *
 * 第三支的 `["']?` 是**为流式准备的**：围栏首行是逐 token 到达的，`title="二次` / `title='二次`
 * 这一刻两支带引号的都匹配不上（没有闭合引号），靠这一支先吃掉那个开引号、再取到半截标题 ——
 * 与 svg 围栏「边生成边落画」同一条取向（宁可有，也不要空一下再蹦出来）。闭合的下一拍自然纠正。
 * 引号必须写成 `["']?` 而不是 `"?`：只管双引号的话，`title='半截` 会连半截都取不到
 * （`'` 既不被 `"?` 吃掉，又被 `[^\s"']` 排除在外）。
 *
 * `(?:^|\s)` 不能省：否则 `subtitle=x` / `mytitle=x` 会被当成标题。
 */
const TITLE_RE = /(?:^|\s)title\s*=\s*(?:"([^"]*)"|'([^']*)'|["']?([^\s"']+))/i;

/**
 * 从围栏 info string 里取标题。
 *
 * 传的是 `markdown.tsx` 拿到的 `lang` **整串**（XMarkdown 的 `data-lang` 就是完整
 * info string，见其 Parser 的 configureCodeRenderer），所以 `diagram title=xx`
 * 里的 `xx` 到这里还在，不必自己切词。
 *
 * @returns 规范化后的标题；没写、写空、或只剩控制字符时返回 null（调用方退回图种标签）
 */
export function fenceTitleOf(lang: unknown): string | null {
  const m = TITLE_RE.exec(String(lang ?? ''));
  if (!m) return null;
  // 控制字符（含换行、制表、\u0000）会串进 class / 文件名 / 无障碍名，先去干净再量长度
  const clean = (m[1] ?? m[2] ?? m[3] ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!clean) return null;
  // 按码点切，别把 emoji 与生僻字劈成半个（代理对算一个字符）
  const chars = [...clean];
  return chars.length > MAX_FENCE_TITLE ? `${chars.slice(0, MAX_FENCE_TITLE).join('')}…` : clean;
}
