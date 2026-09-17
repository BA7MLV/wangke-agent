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

  const clean = DOMPurify.sanitize(sliced, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // data-* 没有渲染意义，一并关掉（ARIA 属性保留，无害）
    ALLOW_DATA_ATTR: false,
  });

  if (typeof clean !== 'string' || !/^<svg[\s>]/i.test(clean)) {
    throw new Error('净化后没有剩下可渲染的图形内容');
  }
  if (DANGEROUS_RE.test(clean)) {
    throw new Error('SVG 包含脚本或外部嵌入内容，已阻止渲染');
  }
  for (const m of clean.matchAll(URL_REF_RE)) {
    if (!m[1].trim().startsWith('#')) {
      throw new Error('SVG 引用了外部资源，已阻止渲染');
    }
  }
  return clean;
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
