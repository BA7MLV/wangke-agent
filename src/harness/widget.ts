/**
 * show_widget 的参数校验与回执文案。**纯模块，无运行时依赖**，Node 下可直接单测。
 *
 * ## 这个工具到底做什么（名字有误导性，先说清）
 *
 * 它**不渲染**任何东西。图形真正上屏靠的是回答正文里的 ```svg / ```mermaid 围栏，
 * 由 `components/mermaid/` 在渲染 Markdown 时接管。这个工具只做一件事：
 *
 *   把模型写好的源码**先过一遍真正的渲染管线**（svg 走 `sanitizeSvg`、mermaid 走
 *   `renderMermaid` 的 parse），通过就回一段可直接放进正文的围栏文本。
 *
 * ## 为什么值得多这一次调用
 *
 * 因为净化失败的后果是**静默降级**：`sanitizeSvg` 抛错时，渲染层不报错，而是
 * **回退成显示源码** —— 用户在回答里看到一坨 XML，问题却不在他那一侧。
 * 模型如果能在这里就拿到可执行的报错并重试，用户根本不会撞上那个降级。
 *
 * ## 为什么不做成「渲染成卡片」
 *
 * 卡片（present_quiz / ask / folderPlan）都挂在 `<XMarkdown>` **之后**渲染
 * （见 ChatPanel），图只能掉在整段回答末尾。而出图规范要求「图的前后各用一句
 * 说明，不要只丢一张图」「图与图之间要有正文过渡」—— 图必须活在正文里才做得到，
 * 唯一的载体就是围栏。所以这个工具刻意不建第二条渲染通道。
 */

export type WidgetFormat = 'svg' | 'mermaid';

export interface WidgetArgs {
  format: WidgetFormat;
  code: string;
}

export type WidgetArgsValidation = { ok: true; args: WidgetArgs } | { ok: false; error: string };

/** 源码长度上限：超了多半是模型把整篇正文塞进来了，渲染出来也没有意义 */
const MAX_CODE = 20_000;

/** 校验 show_widget 的入参。任何字段非法都返回**可直接照着改**的错误描述 */
export function validateWidgetArgs(raw: unknown): WidgetArgsValidation {
  const a = (raw as { format?: unknown; code?: unknown } | null) ?? {};

  const format = a.format;
  if (format !== 'svg' && format !== 'mermaid')
    return { ok: false, error: 'format 必须是 "svg" 或 "mermaid"' };

  const code = typeof a.code === 'string' ? a.code.trim() : '';
  if (!code) return { ok: false, error: 'code 不能为空' };
  if (code.length > MAX_CODE)
    return { ok: false, error: `code 过长（${code.length} 字，上限 ${MAX_CODE}）。只画图，不要把正文塞进来` };

  return { ok: true, args: { format, code } };
}

/**
 * 校验通过后的回执：**原样回一段围栏文本**，让模型嵌到回答里该在的位置。
 *
 * `code` 传**净化后的**源码（svg 分支），于是回执里的围栏就是最终会渲染出来的那一份 ——
 * 模型看到的、用户看到的、渲染器处理的，三者是同一份，不会出现「预检说没问题、
 * 渲染时被悄悄改掉」。
 *
 * 措辞上要盯住两件事，否则模型会把这段代码当成「已经画完了」而不写进正文：
 * 它只是预检，**图还没上屏**；以及围栏要**放在讲解中间**、前后各配一句说明。
 */
export function widgetAcceptedText(args: WidgetArgs): string {
  return [
    `预检通过（${args.format}）。**图还没有上屏** —— 请把下面这段围栏原样放进你的回答正文，`,
    '放在它要解释的那句话旁边，前后各用一句话说明，不要只丢一张图，也不要在正文外重复解释一遍。',
    '',
    '```' + args.format,
    args.code,
    '```',
  ].join('\n');
}

/**
 * 校验失败时的回执：把净化层/解析层抛出的原因**翻译成可执行的修改指引**。
 *
 * 「已阻止渲染」这类原文对模型没有可操作性 —— 它不知道该删哪一处。
 * 所以这里按报错文本归因，给出对应的改法；认不出来时回落到通用建议 + 原文。
 */
export function widgetRejectedText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  // 按「净化层会抛什么」归因，措辞对齐 components/mermaid/svgRender.ts
  let fix: string;
  if (/没有找到 <svg/i.test(raw))
    fix = 'code 必须是一段完整的 SVG，以 <svg 开头、以 </svg> 结尾';
  else if (/没有闭合|缺少 <\/svg>/i.test(raw))
    fix = 'SVG 没有闭合，补上 </svg>';
  else if (/净化后没有剩下可渲染/i.test(raw))
    fix =
      '净化后什么都不剩。你多半用了白名单之外的标签（script / foreignObject / image / use / style / a / 动画 / 滤镜），或只有 <defs> 没有实际图元。换用 path / rect / circle / line / polyline / text 这些';
  else if (/外部资源/.test(raw))
    fix = '不允许引用外部资源（href / src / url(https://…)），只允许 url(#id) 指向自己 <defs> 里定义的 marker、渐变';
  // ⚠️ 这条必须排在「外部资源」之后：净化层的两类报错都以「已阻止渲染」结尾，
  // 先命中它会把「引用了外部资源」误判成「含有脚本」，给出错的改法。
  else if (/脚本|外部嵌入|已阻止渲染/i.test(raw))
    fix = '含有脚本或外部嵌入（script、on* 事件、iframe、foreignObject、image、动画），全部会被丢弃，请只画静态图形';
  else if (/不支持|unknown diagram|no diagram type|mermaid/i.test(raw))
    fix = 'mermaid 语法或图种不被支持。改用 flowchart / sequenceDiagram / stateDiagram-v2 / mindmap / pie，或干脆改用 svg 手写';
  else
    fix = '按下面的原始报错定位问题后重试';

  return `预检没通过，图不会上屏：${fix}。（原始报错：${raw}）`;
}