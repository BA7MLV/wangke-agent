/**
 * 模型直出 SVG 的净化器（```svg 围栏用）。
 *
 * ⚠️ 与 mermaidRender.ts 的安全结论**方向相反**，别把两者合并：
 * - mermaid 产出的 SVG：**不做二次 DOMPurify**。它的 `securityLevel:'strict'` 已经清过一遍，
 *   再净化无论怎么配都会把 foreignObject 里的标签文字整段删掉（流程图节点变空框）。
 *   那边只做「危险特征检测」，命中就回退源码、绝不重写 SVG。
 * - 模型直出的裸 SVG：**必须净化**。这段内容来自 LLM，而 LLM 的输入里混着课程字幕、
 *   用户提问、PDF/Word 材料 —— 全是可被第三方写入的文本，等于把一段可控 HTML 直接
 *   塞进 dangerouslySetInnerHTML。这里走的是白名单：不在清单里的标签与属性一律丢掉。
 *
 * 两条设计取向：
 * 1. **白名单，不是黑名单**。新增标签/属性要显式加进来，避免上游 DOMPurify 放宽默认值时被动挨打。
 * 2. **禁掉一切外部引用**。`href` / `xlink:href` / `src` 根本不进白名单，`url(...)` 另做同文档校验 ——
 *   否则一句提示词注入就能让模型画出 `<image href="https://evil/x.png">`，
 *   用户的 IP 与 UA 就这么漏出去了。
 *
 * 兜底：净化后再跑一遍危险特征检测与引用校验，命中就抛错、回退源码。
 */
import DOMPurify from 'dompurify';

/** SVG 标签白名单。刻意不含 script / foreignObject / image / style / use / a / 动画与滤镜原语。 */
const ALLOWED_TAGS = [
  // 结构
  'svg', 'g', 'defs', 'symbol', 'marker', 'pattern', 'clipPath', 'mask',
  // 图元
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  // 文本
  'text', 'tspan', 'title', 'desc',
  // 渐变
  'linearGradient', 'radialGradient', 'stop',
];

/**
 * 属性白名单。**没有 href / xlink:href / src / on* 任何一项**（前三个是外部引用面，后一类是脚本面）。
 *
 * 注：HTML 解析器会按规范表把 `viewbox` 校正回 `viewBox`（同理 `preserveAspectRatio`、
 * `gradientUnits`、`clipPathUnits` 等），所以这里按 SVG 的正确大小写写即可。
 */
const ALLOWED_ATTR = [
  // 画布与定位
  'xmlns', 'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y', 'transform',
  'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'dx', 'dy', 'rotate',
  'd', 'points', 'pathLength', 'textLength', 'lengthAdjust',
  // 渐变 / 图案 / 裁剪 / 标记
  'offset', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'patternUnits', 'patternContentUnits', 'clipPathUnits', 'maskUnits',
  'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient',
  'marker-start', 'marker-mid', 'marker-end', 'clip-path', 'clip-rule', 'mask',
  // 填充与描边
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-miterlimit', 'paint-order', 'vector-effect', 'stop-color', 'stop-opacity',
  // 文本排版
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'letter-spacing', 'word-spacing', 'text-anchor', 'dominant-baseline',
  'alignment-baseline', 'baseline-shift', 'direction', 'writing-mode', 'unicode-bidi',
  // 可见性与渲染
  'opacity', 'color', 'display', 'visibility', 'overflow',
  'shape-rendering', 'text-rendering', 'image-rendering', 'mix-blend-mode', 'isolation',
  // 无脚本副作用的外壳属性
  'id', 'class', 'style', 'role', 'aria-label', 'aria-hidden', 'tabindex',
];

/** 危险特征：白名单之外的兜底。命中说明净化被绕过，直接拒绝而不是重写。 */
const DANGEROUS_RE = /<\s*(script|iframe|object|embed|form|foreignObject|image|use|a)\b|\son[a-z]+\s*=|\bjavascript:|\bdata:text\/html/i;

/** `url(...)` 引用：只允许同文档片段（`#id`），其余（外部 URL、data:）一律拒绝 */
const URL_REF_RE = /url\(\s*['"]?\s*([^'")]*)/gi;

/**
 * 把模型直出的 SVG 源码净化成可安全插入 DOM 的字符串。
 *
 * @throws 源码不是一段完整 SVG / 净化后为空 / 命中危险特征或外部引用 —— 调用方回退源码展示
 */
export function sanitizeSvg(raw: string): string {
  const sliced = sliceSvg(raw);

  const clean = purifySvgChunk(sliced);

  if (typeof clean !== 'string' || !/^<svg[\s>]/i.test(clean)) {
    throw new Error('净化后没有剩下可渲染的图形内容');
  }
  assertSafe(clean);
  return clean;
}

/**
 * 白名单之外的兜底闸门。完整源码与流式增量**共用这一份** ——
 * 分成两处的话，增量那条迟早会漏掉某个特征，于是「边生成边画」就成了一条绕过安全层的旁路。
 *
 * @throws 命中危险特征，或 `url(...)` 指向的不是同文档片段
 */
function assertSafe(clean: string): void {
  if (DANGEROUS_RE.test(clean)) {
    throw new Error('SVG 包含脚本或外部嵌入内容，已阻止渲染');
  }
  for (const m of clean.matchAll(URL_REF_RE)) {
    if (!m[1].trim().startsWith('#')) {
      throw new Error('SVG 引用了外部资源，已阻止渲染');
    }
  }
}

/**
 * 从围栏内容里切出 SVG 本体：允许模型在围栏里多写一句「这是函数图像：」，
 * 但要求确实存在 `<svg …>` 与闭合的 `</svg>` —— 半截内容宁可报错也不要画出个残图。
 */
function sliceSvg(raw: string): string {
  const source = raw.trim();
  if (!source) throw new Error('SVG 源码为空');

  const start = source.search(/<svg[\s>]/i);
  if (start < 0) throw new Error('没有找到 <svg 标签：请用 ```svg 围栏包一段完整的 SVG');

  const end = source.toLowerCase().lastIndexOf('</svg>');
  if (end < 0) throw new Error('SVG 没有闭合（缺少 </svg>）');

  return source.slice(start, end + '</svg>'.length);
}

// ───────────────────────────────────────────────────────────────────────────────
// 流式增量：一笔画出来
// ───────────────────────────────────────────────────────────────────────────────
//
// 围栏闭合前的内容是**半截的**，而 `sanitizeSvg` 的契约就是「不完整就不画」（见 sliceSvg）。
// 但那说的是**最终结果**：闭合那一刻的判定，与流式期间给人看的预览，是两件事。
// 这里的 `peekSvgProgress` 只回答后者 —— 半截内容里**哪些已经写完整、可以安全落画**。
//
// 三条取向：
//
// 1. **只发「自己闭合了」的顶层元素**。`d="M 0 0 L 1` 这种半条路径宁可晚几十毫秒，
//    也绝不先画出去 —— 画歪了收不回来，只能等 `</svg>` 整体重来。
// 2. **每个片段独立过白名单**（外面套一层空 `<svg>`）。安全口径与完整源码完全一致，
//    增量不是旁路；套壳也不是装饰，见 `sanitizePiece` 的注释。
// 3. **闭合后一律回到 `sanitizeSvg`**。增量的结果只是预览，最终上屏的永远是完整净化产物，
//    所以预览层出 bug 的最坏后果也只是「动画丑一点」，不会变成一张画错的图。

/** 半截内容的一份落画快照：根属性 + 已经写完整的顶层子元素 */
export interface SvgProgress {
  /**
   * 根 `<svg>` 的属性串（净化后），形如 `viewBox="0 0 220 140" xmlns="…"`。
   * 根标签闭合那一刻属性就定死了，之后不会再变 —— 所以调用方只需建一次画布。
   */
  rootAttrs: string;
  /** 已经闭合、可以上屏的顶层子元素（净化后的片段），按出现顺序。末尾可能还留着半截没写完。 */
  elements: string[];
}

/**
 * 从**未闭合**的围栏内容里切出「已经可以落画」的部分。
 *
 * @returns 根标签还没成形、净化后没有可用几何信息、或内容命中安全闸门 → `null`
 *          （调用方退回等待态，等围栏闭合后统一处置）。**不抛错**：这只是一层预览。
 * @throws 命中安全闸门（外部 `url(...)` 之类）—— 与 `sanitizeSvg` 同一套判定
 */
export function peekSvgProgress(raw: string): SvgProgress | null {
  const source = raw.trim();
  if (!source) return null;

  const start = source.search(/<svg[\s/>]/i);
  if (start < 0) return null;

  // 根标签的 '>' 还没到：viewBox 与 width 都可能还在后面，此刻连画布尺寸都定不下来
  const rootEnd = findTagEnd(source, start);
  if (rootEnd < 0) return null;

  const rootAttrs = sanitizeRoot(source.slice(start, rootEnd + 1));
  // 没有几何信息就没法先把「纸」铺出来 —— 这种半截 SVG 老实退回等待态
  if (!/(^|\s)viewBox\s*=/.test(rootAttrs) && !/(^|\s)width\s*=/.test(rootAttrs)) return null;

  return { rootAttrs, elements: closedTopLevel(source, rootEnd + 1).map(sanitizePiece) };
}

/**
 * 找标签的结束 `>`（引号感知）。
 *
 * 引号感知是必须的：`d="M0 0 L1 1"` 这种属性值里没有 `>`，但
 * `<text>it's fine</text>` 之类**正文**里的引号与尖括号又不该影响标签边界 ——
 * 所以引号状态只在标签内部生效，进入正文（`>` 之后）就退出。
 *
 * @returns `>` 的下标；标签还没写完（属性值只写了一半）→ -1
 */
function findTagEnd(s: string, lt: number): number {
  let quote = '';
  for (let i = lt + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

/**
 * 扫出 body 里**已经写完整**的顶层子元素原文。
 *
 * 判定只有一条：元素自己闭合了 —— 自闭合 `/>` 到了，或者配对的 `</tag>` 到了。
 * 半截的一律不收，留给下一拍：没写完的标签、没写完的注释 / CDATA / 声明，以及孤立闭标签
 * （流式期间那个 `</svg>` 就是典型 —— 它闭合的是根标签，而根标签不在这一层里收）。
 */
function closedTopLevel(body: string, from: number): string[] {
  const out: string[] = [];
  let i = from;
  let depth = 0;
  let start = -1;
  while (i < body.length) {
    const lt = body.indexOf('<', i);
    // 剩下没有 '<' 了：那是正文尾巴（流式期间就是被 `>` 截断的半句话），不是元素
    if (lt < 0) break;

    // 注释 / CDATA / 声明：整体跳过，未写完就停
    let skip = -1;
    if (body.startsWith('<!--', lt)) skip = body.indexOf('-->', lt + 4);
    else if (body.startsWith('<![CDATA[', lt)) skip = body.indexOf(']]>', lt + 9);
    else if (body[lt + 1] === '!' || body[lt + 1] === '?') skip = body.indexOf('>', lt + 2);
    if (skip >= 0) {
      i = skip + (body[skip] === '>' ? 1 : 3);
      continue;
    }
    if (body[lt + 1] === '!' || body[lt + 1] === '?') break;

    const gt = findTagEnd(body, lt);
    if (gt < 0) break; // 标签本身没写完（多半是属性值只写了一半）
    const tag = body.slice(lt, gt + 1);
    const closing = tag[1] === '/';
    const selfClosing = !closing && /\/\s*>$/.test(tag);

    if (closing) {
      // 孤立的闭标签（`</svg>` 或畸形内容）不该把 depth 推成负数：那会让后面的元素全部判成「在嵌套里」
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start >= 0) {
        out.push(body.slice(start, gt + 1));
        start = -1;
      }
    } else {
      if (depth === 0 && start < 0) start = lt;
      if (selfClosing) {
        if (depth === 0) {
          out.push(body.slice(start, gt + 1));
          start = -1;
        }
      } else {
        depth++;
      }
    }
    i = gt + 1;
  }
  return out;
}

const PIECE_CACHE_MAX = 400;
const pieceCache = new Map<string, string>();

/** 根标签的属性串。净化一次就定死了，之后每拍都撞同一个字符串 —— 单槽记忆足够 */
let rootMemo = { raw: '', attrs: '' };

/** 与 `sanitizeSvg` 完全同一份配置。三条路径（完整源码 / 根标签 / 单个元素）共用一处常量，
 *  免得「预览那条路忘了更新白名单」这种偏差 —— 那等于给旁路开了个口子。 */
function purifySvgChunk(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // data-* 没有渲染意义，一并关掉（ARIA 属性保留，无害）
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * 根 `<svg …>` 的属性串（净化后）。
 *
 * 原样把这段喂给 DOMPurify（它没闭合也没关系：HTML 解析器会在 body 末尾补齐，
 * 序列化出来仍是 `<svg …></svg>`），再从第一个 `>` 前面切出属性段。
 * 属性值里的 `"` 被序列化成 `&quot;`，所以这里按第一个 `>` 切是安全的。
 *
 * ⚠️ 别写成「套一层 `<svg>` 再取 inner」：那样取出来的是**内层那个 `<svg …></svg>` 整段**，
 * 去掉 `<svg` 前缀后尾巴还带着一个 `</svg>` —— rootAttrs 会变成
 * `viewBox="…" xmlns="…"></svg`，画布直接不渲染。属性段只能从**序列化结果的最外层**切。
 */
function sanitizeRoot(rawTag: string): string {
  if (rootMemo.raw === rawTag) return rootMemo.attrs;

  const clean = purifySvgChunk(rawTag);
  const gt = typeof clean === 'string' && clean.startsWith('<svg') ? clean.indexOf('>') : -1;
  if (gt < 0) throw new Error('根标签净化后不是可渲染的 <svg>');
  assertSafe(clean);

  const attrs = clean.slice(4, gt).trim();
  rootMemo = { raw: rawTag, attrs };
  return attrs;
}

/**
 * 单个元素的净化：外面套一层空 `<svg>` 再过 DOMPurify，取出里面的东西。
 *
 * 套壳不是装饰 —— HTML 解析器**只把 `<svg>` 子树里的元素放进 SVG 命名空间**，
 * 而 DOMPurify 按命名空间决定属性名要不要小写化（SVG 命名空间原样保留，HTML 命名空间一律
 * lowerCase）。裸喂一个 `<rect viewBox=…>` 的话，`viewBox` / `gradientUnits` 这类 camelCase
 * 属性会被打成小写、再被白名单（按 SVG 正确大小写写的）剔掉 —— 图就悄悄少了一截。
 * 套一层根标签等于把命名空间交给解析器，跟 `sanitizeSvg` 走同一条路。
 *
 * 结果按元素原文缓存：流式每一拍都会重新扫到**全部**已完成的元素，
 * 而每个元素的净化结果恒定，缓存之后整条流只净化「真正新到的那几个」。
 */
function sanitizePiece(piece: string): string {
  const hit = pieceCache.get(piece);
  if (hit !== undefined) return hit;

  const clean = purifySvgChunk(`<svg>${piece}</svg>`);
  const gt = typeof clean === 'string' && clean.startsWith('<svg') ? clean.indexOf('>') : -1;
  if (gt < 0) throw new Error('片段净化后不是可渲染的 SVG 片段');
  assertSafe(clean);

  const inner = clean.slice(gt + 1, clean.lastIndexOf('</svg>'));
  pieceCache.set(piece, inner);
  if (pieceCache.size > PIECE_CACHE_MAX) {
    const oldest = pieceCache.keys().next().value;
    if (oldest !== undefined) pieceCache.delete(oldest);
  }
  return inner;
}
