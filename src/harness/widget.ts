/**
 * show_widget 的参数校验与回执文案。**纯模块，无运行时依赖**，Node 下可直接单测。
 *
 * ## 这个工具到底做什么（名字有误导性，先说清）
 *
 * svg / mermaid / diagram **不由工具直接渲染**：它们真正上屏靠回答正文里的围栏，
 * 由 `components/mermaid/` 在渲染 Markdown 时接管。html 则是例外：它会先构造隔离文档，
 * 通过后由调用方把载荷交给 `WidgetBlock`。工具的共同职责是：
 *
 *   把模型写好的源码**先过一遍真正的渲染管线**（svg 走 `sanitizeSvg`、mermaid 走
 *   `renderMermaid` 的 parse、diagram 走 `validateDiagram` + `renderDiagram`），
 *   通过就回一段可直接放进正文的围栏文本。
 *
 * ## 为什么值得多这一次调用
 *
 * 因为净化失败的后果是**静默降级**：`sanitizeSvg` 抛错时，渲染层不报错，而是
 * **回退成显示源码** —— 用户在回答里看到一坨 XML，问题却不在他那一侧。
 * 模型如果能在这里就拿到可执行的报错并重试，用户根本不会撞上那个降级。
 *
 * ## 为什么图形围栏不做成「渲染成卡片」
 *
 * 卡片（present_quiz / ask / folderPlan）都挂在 `<XMarkdown>` **之后**渲染
 * （见 ChatPanel），图只能掉在整段回答末尾。而出图规范要求「图的前后各用一句
 * 说明，不要只丢一张图」「图与图之间要有正文过渡」—— 图必须活在正文里才做得到，
 * 唯一的载体就是围栏。所以 svg / mermaid / diagram 刻意不建第二条渲染通道；
 * html 是必须执行脚本的交互例外：载荷单独保存，正文引用负责定位隔离沙箱。
 */

import type { WidgetLib } from './widgetRuntime';
import { MAX_FENCE_TITLE } from '../components/mermaid/fence.ts';
import { widgetReference } from './widgetLayout.ts';

export type WidgetFormat = 'svg' | 'mermaid' | 'diagram' | 'html';

export interface WidgetArgs {
  format: WidgetFormat;
  code: string;
  /**
   * 图的标题（```diagram title="抛物线开口方向"）。图块左上角显示，也当下载文件名。
   *
   * 它必须由**这里**回执带回围栏（见 widgetAcceptedText）：模型是照着回执「原样贴进正文」的，
   * 回执里不带标题，标题就在这一趟往返里丢掉了 —— 而丢的地方恰恰是模型看不见的。
   */
  title?: string;
  /** html 形态才用：声明要宿主内联的库 */
  libs?: WidgetLib[];
}

export type WidgetArgsValidation = { ok: true; args: WidgetArgs } | { ok: false; error: string };

/** 源码长度上限：超了多半是模型把整篇正文塞进来了，渲染出来也没有意义 */
const MAX_CODE = 20_000;
/**
 * 拼好文档后的体积上限。
 * 唯一的大头是内联的 Chart.js（UMD 约 200KB）—— 所以卡在「文档总长」而不是分别卡每个库：
 * 声明了不需要的库就该被这个上限挡住，而不是白扛 200KB 再渲染。
 */
export const MAX_WIDGET_DOC = 320_000;
/** html 形态的独立上限：它要连 DOM 带脚本，比 SVG 大得多，但仍要卡住 */
const MAX_HTML = 60_000;

/** 校验 show_widget 的入参。任何字段非法都返回**可直接照着改**的错误描述 */
export function validateWidgetArgs(raw: unknown): WidgetArgsValidation {
  const a = (raw as { format?: unknown; code?: unknown; libs?: unknown; title?: unknown } | null) ?? {};

  const format = a.format;
  if (format !== 'svg' && format !== 'mermaid' && format !== 'diagram' && format !== 'html')
    return { ok: false, error: 'format 必须是 "svg"、"mermaid"、"diagram" 或 "html"' };

  const code = typeof a.code === 'string' ? a.code.trim() : '';
  if (!code) return { ok: false, error: 'code 不能为空' };

  if (format === 'html') {
    // html 形态渲染成独立图形卡，卡上没有标题栏 —— 收下它就只能悄悄丢掉。
    // 与其让模型以为「标题写上了」，不如现在说清它该往哪儿写。
    if (a.title != null)
      return {
        ok: false,
        error: 'html 形态没有标题栏，title 只用于 mermaid / diagram / svg 围栏。图的名字请写进正文那句话里，或不传 title',
      };
    if (code.length > MAX_HTML)
      return { ok: false, error: `code 过长（${code.length} 字，上限 ${MAX_HTML}）。只画图，不要把正文塞进来` };
    // 文档外壳由宿主的 runtime 统一提供。模型自己套一层会让 CSP 与桥接脚本的注入位置失控，
    // 所以这里直接拒掉并说清正确写法，而不是默默剥掉。
    if (/<\s*\/?\s*(?:!doctype|html|head|body)\b/i.test(code))
      return {
        ok: false,
        error: 'html 形态只给**片段**：不要写 <html>/<head>/<body>/DOCTYPE，外壳由宿主提供',
      };
    // 外链一律不行：CSP 已经断了网络，这里再挡一层是为了给出可执行的解释，
    // 而不是让模型对着一个「空白图 + connect-src 报错」瞎猜。
    if (/<\s*script[^>]+src\s*=/i.test(code))
      return { ok: false, error: '不要用 <script src> 引外部脚本：外部网络已被禁用。需要库时改用 libs 参数（如 libs: ["chart.js"]）' };
    // 交互统一走 data-wbw-prompt，不开放链接导航；图片只允许内联 data:image。
    // 这比只拦 http(s) 更保守，也挡住 HTML entity / 混合大小写绕过协议黑名单的变体。
    const urlAttr = /(?:^|[\s<])(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    for (const match of code.matchAll(urlAttr)) {
      const attr = match[1].toLowerCase();
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      if (value.includes('&'))
        return { ok: false, error: 'src/href 不要使用 HTML entity；图片用原始 data:image，交互请使用 data-wbw-prompt' };
      if (attr === 'href' && !value.startsWith('#'))
        return { ok: false, error: 'html 形态不支持外部链接或链接导航；交互请使用 data-wbw-prompt' };
      if (attr === 'src' && !/^data:image\//i.test(value))
        return { ok: false, error: 'src 只允许内联 data:image；不要引用外部资源，交互请使用 data-wbw-prompt' };
    }
    // CSP 的 navigate-to 在部分 Chromium 版本里不会阻止 sandbox 文档导航，
    // 所以再挡住脚本里最直接的导航 API。widget 的交互桥只需要 DOM、计时器和
    // window.__wbw，不需要 location / window.open；宁可让模型删掉这段，也不把
    // 课程内容放进 URL 交给外部站点。
    const scriptBody = /<\s*script\b[^>]*>([\s\S]*?)(?:<\s*\/\s*script\s*>|$)/gi;
    for (const match of code.matchAll(scriptBody)) {
      const body = match[1] ?? '';
      if (/\blocation\b|(?:window|globalThis|document|self|top|parent)\s*(?:\.\s*(?:open|location)|\[\s*["'](?:open|location)["']\s*\])/i.test(body))
        return { ok: false, error: '脚本不能导航窗口或打开外部页面（location / window.open）；交互请使用 data-wbw-prompt' };
    }

    const libs = normalizeLibs(a.libs);
    if (!libs.ok) return libs;
    return { ok: true, args: { format, code, libs: libs.libs } };
  }

  if (code.length > MAX_CODE)
    return { ok: false, error: `code 过长（${code.length} 字，上限 ${MAX_CODE}）。只画图，不要把正文塞进来` };

  const title = normalizeTitle(a.title);
  if (!title.ok) return title;
  return { ok: true, args: title.title ? { format, code, title: title.title } : { format, code } };
}

/**
 * 校验围栏标题。这里**拒**超长而不是像 fence.ts 那样截断 —— 两个位置的分工不同：
 * 预检是唯一能教会模型的时机（说清「标题是图的名字、不是正文句子」，它下一轮就写短了），
 * 渲染层则必须保证「模型写什么都画得出来」，所以那边截断兜底。
 *
 * 引号一并在这里收口：围栏参数按引号解析，标题里两种引号同时出现就没法安全表达
 * （见 fenceHeader），与其拼一段解析不回来的围栏，不如现在说清。
 */
function normalizeTitle(raw: unknown): { ok: true; title?: string } | { ok: false; error: string } {
  if (raw == null) return { ok: true };
  if (typeof raw !== 'string') return { ok: false, error: 'title 必须是字符串' };
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: true }; // 空标题＝没写，按没写处理
  if ([...t].length > MAX_FENCE_TITLE)
    return {
      ok: false,
      error: `title 过长（${[...t].length} 字，上限 ${MAX_FENCE_TITLE}）。标题是这张图的名字，点明它讲什么就够，不要把正文句子塞进来`,
    };
  if (t.includes('"') && t.includes("'"))
    return { ok: false, error: 'title 里不要同时出现双引号与单引号（围栏参数按引号解析）：去掉引号或只留一种' };
  return { ok: true, title: t };
}

/**
 * 围栏首行：`diagram` 或 `diagram title="抛物线开口方向"`。
 *
 * 引号按标题里已出现的那一种让位：解析侧（fence.ts 的 fenceTitleOf）认 `"…"` / `'…'` / 裸值，
 * 两种引号同时出现由上面的预检拒掉，所以这里只需二选一。
 */
function fenceHeader(format: WidgetFormat, title?: string): string {
  if (!title) return format;
  return title.includes('"') ? `${format} title='${title}'` : `${format} title="${title}"`;
}

const KNOWN_LIBS: readonly WidgetLib[] = ['chart.js'];

/** libs 只认白名单里的名字：它决定宿主往沙箱里内联哪份源码，不是模型能自选的路径 */
function normalizeLibs(raw: unknown): { ok: true; libs?: WidgetLib[] } | { ok: false; error: string } {
  if (raw == null) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false, error: 'libs 必须是数组，可选值：["chart.js"]' };
  const out: WidgetLib[] = [];
  for (const n of raw) {
    if (typeof n !== 'string' || !KNOWN_LIBS.includes(n as WidgetLib))
      return {
        ok: false,
        error: `libs 只能取 ${KNOWN_LIBS.map((k) => `"${k}"`).join(' / ')}（或省略），收到：${JSON.stringify(n)}`,
      };
    if (!out.includes(n as WidgetLib)) out.push(n as WidgetLib);
  }
  return { ok: true, libs: out.length ? out : undefined };
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
export function widgetAcceptedText(args: WidgetArgs, ref?: string): string {
  // The reference contains no executable source. Only this message's registered payload can render it.
  if (args.format === 'html') {
    if (!ref) throw new Error('HTML 预检缺少宿主引用');
    return `图形预检通过。把下面的引用原样放在正文中需要看图的位置，单独成块，不要贴 HTML 源码。只补充必要的观察或结论，不重复图中的内容。\n\n${widgetReference(ref)}`;
  }
  return [
    `预检通过（${args.format}）。**图还没有上屏** —— 请把下面这段围栏原样放进你的回答正文，`,
    '放在它要解释的那句话旁边，前后各用一句话说明，不要只丢一张图，也不要在正文外重复解释一遍。',
    '',
    '```' + fenceHeader(args.format, args.title),
    args.code,
    '```',
  ].join('\n');
}

/**
 * 校验失败时的回执：把净化层/解析层抛出的原因**翻译成可执行的修改指引**。
 *
 * 「已阻止渲染」这类原文对模型没有可操作性 —— 它不知道该删哪一处。
 * 所以这里按报错文本归因，给出对应的改法；认不出来时回落到通用建议 + 原文。
 *
 * ⚠️ 归因顺序：diagram 的分支必须**整体排在 svg/mermaid 之前**。两个原因：
 * 1. type 报错的文案里含着「```mermaid」字样，排后会被 mermaid 分支截胡；
 * 2. diagram 的 schema 报错与 svg 的净化报错文本完全不重叠，排前不会误伤。
 */
export function widgetRejectedText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  // —— diagram（JSON 中间层）：归因对齐 diagramSchema.ts / expr.ts 的报错文案 ——
  let fix: string;
  if (/表达式第 \d+ 字符附近出错/.test(raw))
    fix =
      'fn 表达式写法不对：只支持 x、pi/e/tau、+ - * / ^ %、括号与白名单函数（sin/cos/tan/exp/ln/log/sqrt/abs/min/max/pow 等），支持隐式乘法（2x、2sin(x)）。报错给了字符位置，照着改';
  else if (/不认识的字段/.test(raw))
    fix =
      'diagram 的 schema 是锁死的：只用了 schema 列出的字段（大小写敏感）。把报错点名的字段改成可用字段或删掉；完整 schema 见「讲解配图」技能';
  else if (/引用了不存在的节点/.test(raw))
    fix = 'edge 的 from/to 必须指向 nodes 里已存在的 id；报错消息里列出了全部可用 id，照着改';
  else if (/type 必须是/.test(raw))
    fix =
      'type 只能取 "graph"（节点+连线）、"plot"（函数图像/几何/坐标轴）或 "chart"（柱/折/饼数据图）。时序等未覆盖图种用 ```mermaid 围栏';
  else if (/不是合法的 JSON/.test(raw))
    fix =
      '围栏里必须是一个 JSON 对象（{"type": …} 开头）。检查多余的逗号、缺引号、把说明文字写进了围栏；也不要把 SVG / mermaid 源码放进 ```diagram';
  // 上限类：schema 的几种文案形状不同 ——「超过 10 个」「超过 16 条」「超过 4 项」
  // 「超过 20 字」「超过 12 个点」，所以量词用并集而不是逐个枚举
  else if (/超过 \d+ (?:个|条|项|字)/.test(raw))
    fix = '超出数量上限了：拆成两张图，或删掉不重要的节点 / 曲线 / 标注（上限见「讲解配图」技能）';
  else if (/自环/.test(raw))
    fix = '不支持 from 与 to 相同的自环：去掉这条边，或把说明写进节点文案';
  else if (/domain/.test(raw))
    fix = '曲线的 domain 超出了 x 范围：把 domain 收进坐标轴范围内，或加大 x 范围';
  else if (/至少需要 3 个点/.test(raw))
    fix = 'polygon 的 points 至少 3 个点';
  else if (/r 必须是正数/.test(raw))
    fix = 'circle 的 r 必须是正数';
  else if (/十六进制颜色|color/.test(raw))
    fix = 'color 只能是 #1677ff 这样的十六进制颜色或少数命名色，不要写 url(...) 或渐变';
  else if (/shape 只能是/.test(raw))
    fix = '节点 shape 只能是 box / round / ellipse / diamond';
  else if (/anchor 只能是/.test(raw))
    fix = 'label 的 anchor 只能是 start / middle / end';
  else if (/direction 只能/.test(raw))
    fix = 'direction 只能是 "TB"（纵向）或 "LR"（横向）';
  else if (/必须是非空字符串|必须是有限数字|必须是 \[a, b\]|必须是 true \/ false|必须是数组|不能为空|必须小于/.test(raw))
    fix =
      '字段类型或取值不对：按 schema 的类型写（字符串加引号、数字不加引号、坐标写 [x, y] 二元组、范围写 [最小值, 最大值]），完整 schema 见「讲解配图」技能';
  // —— svg（模型直出裸 SVG，历史兼容路径）——
  else if (/没有找到 <svg/i.test(raw))
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
    fix = 'mermaid 语法或图种不被支持。改用 flowchart / sequenceDiagram / stateDiagram-v2 / mindmap / pie';
  else
    fix = '按下面的原始报错定位问题后重试';

  return `预检没通过，图不会上屏：${fix}。（原始报错：${raw}）`;
}
