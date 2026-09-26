/**
 * HTML 阅读材料的识别、整文档净化与原样渲染。
 *
 * ## 两种读法，共用一套抽取
 *
 * - **原样视图**（默认）：整份文档（含它自己的 `<style>`）净化后塞进**沙箱 iframe**，
 *   长得像原文档。见 `prepareHtmlDocument`。
 * - **分段视图**：按语义块逐段渲染。是历史实现，保留作退路（网页存档的导航条、
 *   窄栏小字在原样视图下确实难读）。
 *
 * 两条路径**必须共用同一个遍历**（`walkUnits`）：它既产出文本单元（喂 `materialBlocks`
 * / BM25），又在原 DOM 上打 `data-mr-unit` 锚点（供原样视图跳转与划词定位）。
 * 各写一份必然漂移，表现是 `[第3段]` 跳到第 5 段。
 *
 * ## 为什么整文档路径不用 DOMPurify
 *
 * `sanitizeHtmlFragment` 走 DOMPurify 白名单，那是对**片段**的正确做法（分段视图里
 * 只需要保留一小撮语义标签）。整文档路径不行，两个原因：
 *
 * 1. 白名单会砍掉保真所需的东西 —— `<ruby>` / `<abbr>` / `<picture>` / `<figure>` 之类
 *    都不在默认白名单里，砍掉就不是「原样」了；
 * 2. `ALLOW_DATA_ATTR: false` 会连我们自己打的 `data-mr-unit` 锚点一起剥掉，
 *    而放行 `data-*` 又等于把导入文档的任意 data 属性带进 DOM。
 *
 * 所以整文档路径改用**结构性黑名单 + CSP + 沙箱**三层（见 prepareHtmlDocument 注释），
 * 每一层都在 `scripts/test-material-html.mjs` 里有对应断言。
 */
import DOMPurify from 'dompurify';
import type { RawUnit } from './chunk.ts';

export const HTML_MIME = 'text/html';

export function isHtmlFile(file: { name: string; type?: string }): boolean {
  const t = (file.type ?? '').toLowerCase().split(';', 1)[0].trim();
  if (t === HTML_MIME || t === 'application/xhtml+xml') return true;
  const name = file.name.toLowerCase();
  return name.endsWith('.html') || name.endsWith('.htm');
}

export interface HtmlUnit extends RawUnit {
  /** 与 text 对齐的原始 HTML 片段；只允许交给 sanitizeHtmlFragment 后渲染（分段视图用）。 */
  html: string;
}

/**
 * 单元锚点属性名。
 *
 * 打在被抽为单元的**元素**上，随 DOM 一起序列化进 iframe —— 这样同一份文档
 * 既保持原样、又能被 `[第N段]` 与划词定位。见文件头「两种读法，共用一套抽取」。
 */
export const MR_UNIT_ATTR = 'data-mr-unit';

const PRIMARY_BLOCKS = 'h1,h2,h3,h4,h5,h6,p,pre,blockquote,li,table,figcaption,dt,dd';
const FALLBACK_BLOCKS = 'main,article,section,aside,div';
const HEADING_RE = /^H[1-6]$/;

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

function isHidden(el: Element): boolean {
  return !!el.closest('[hidden],[aria-hidden="true"]');
}

/**
 * 抽出「块级元素」清单：优先语义块，只有页面是若干 div 时才回退到最深的有字容器。
 * 顺序按文档序 —— 段号必须与视觉顺序一致。
 */
function collectBlocks(body: HTMLElement): Element[] {
  const primary = Array.from(body.querySelectorAll(PRIMARY_BLOCKS)).filter((el) => {
    if (isHidden(el) || !textOf(el)) return false;
    const parentBlock = el.parentElement?.closest(PRIMARY_BLOCKS);
    return !parentBlock || !body.contains(parentBlock);
  });
  const fallback = Array.from(body.querySelectorAll(FALLBACK_BLOCKS)).filter((el) => {
    if (isHidden(el) || !textOf(el) || el.querySelector(PRIMARY_BLOCKS)) return false;
    if (el.parentElement?.closest(PRIMARY_BLOCKS)) return false;
    return !Array.from(el.children).some((child) => child.matches(FALLBACK_BLOCKS) && textOf(child));
  });
  return [...primary, ...fallback].sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
  });
}

/**
 * 块级元素 → 文本单元。
 *
 * 标题与紧随其后的正文合成一个单元（与 Markdown 阅读器同一规则），规则见
 * `docs/plans/2026-09-17-materials-and-selection-ask-design.md`。
 *
 * `mark` 为真时**顺手把段号写回原 DOM**（`data-mr-unit`）。写回的位置有讲究：
 * 标题元素与正文块元素**都**写同一个号 —— 标题是 `scrollToUnit` 的落点，
 * 正文块是划词时 `closest()` 的命中点；只写一处就会瘸一条腿。
 * 纯容器（不含语义块的外层 div）**不写** —— 它是多个单元的公共祖先，写了会让
 * `closest()` 把里头的划词全部认到同一个错单元上。
 */
function walkUnits(body: HTMLElement, mark: boolean): HtmlUnit[] {
  const elements = collectBlocks(body);

  // 没有任何块标签时，仍把 body 的纯文本作为一段导入。
  if (elements.length === 0) {
    const text = textOf(body);
    if (!text) return [];
    if (mark) body.setAttribute(MR_UNIT_ATTR, '1');
    return [{ unit: 1, text, html: `<p>${escapeHtml(text)}</p>`, kind: 'body' }];
  }

  const units: HtmlUnit[] = [];
  let section: string | undefined;
  let pendingHeads: Element[] = [];
  const push = (el: Element | null) => {
    const heads = pendingHeads;
    pendingHeads = [];
    const bodyText = el ? textOf(el) : '';
    const headText = heads.map(textOf).filter(Boolean);
    const text = [...headText, bodyText].filter(Boolean).join('\n\n');
    if (!text) return;
    const unit = units.length + 1;
    const html = [...heads.map((h) => h.outerHTML), el?.outerHTML ?? ''].filter(Boolean).join('\n');
    if (mark) {
      for (const node of heads) node.setAttribute(MR_UNIT_ATTR, String(unit));
      el?.setAttribute(MR_UNIT_ATTR, String(unit));
    }
    units.push({
      unit,
      text,
      html,
      kind: heads.length > 0 ? 'title' : el?.tagName === 'TABLE' ? 'table' : 'body',
      section,
    });
  };

  for (const el of elements) {
    if (HEADING_RE.test(el.tagName)) {
      section = textOf(el);
      pendingHeads.push(el);
      continue;
    }
    push(el);
  }
  if (pendingHeads.length > 0) push(null);
  return units;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]!);
}

/**
 * HTML → 段落单元（**不改动输入**，供解析入库与分段视图使用）。
 *
 * 标题与紧随其后的正文合成一个单元，规则与 Markdown 阅读器一致。
 */
export function extractHtmlUnits(src: string): HtmlUnit[] {
  if (typeof DOMParser === 'undefined') throw new Error('当前环境不支持 HTML 解析');
  const doc = new DOMParser().parseFromString(src, 'text/html');
  doc.querySelectorAll('script,style,noscript,template,iframe,object,embed,form').forEach((el) => el.remove());
  return walkUnits(doc.body, false);
}

/* ── URL 分类 ─────────────────────────────────────────────────────────────── */

export type UrlKind =
  /** `data:` / `blob:` —— 内嵌资源，永远可用（也永远安全） */
  | 'inline'
  /** `http(s):` 与协议相对（`//host/x`）—— 联网才可用 */
  | 'remote'
  /** 纯页内锚点（`#id`）—— 不产生请求，放行 */
  | 'fragment'
  /** 相对路径（`./a.png` / `assets/x.css`）—— 单文件导入下无从解析，见 design §3.5 */
  | 'relative'
  /** 其它 scheme（`javascript:` / `file:` …）—— 一律不可用 */
  | 'other'
  | 'empty';

export function urlKind(raw: string): UrlKind {
  const v = raw.trim();
  if (!v) return 'empty';
  if (v.startsWith('#')) return 'fragment';
  if (/^(?:data|blob):/i.test(v)) return 'inline';
  // 协议相对也算远程：srcdoc 下会继承宿主的 scheme，照样出网
  if (/^(?:https?:)?\/\//i.test(v)) return 'remote';
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return 'other';
  return 'relative';
}

/* ── 整文档净化（原样视图） ───────────────────────────────────────────────── */

/**
 * 结构性黑名单：这些元素要么能执行代码、要么能自己发起导航、要么会把宿主拖进来。
 * 用 `localName` 判断而不是 `querySelectorAll('标签名')` —— SVG / MathML 命名空间里的
 * `<script>` 不会被 HTML 的大小写规则覆盖，按 localName 走没有这个盲区。
 */
const DROP_LOCAL_NAMES = new Set([
  'script', 'noscript', 'template',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal',
  'form', 'input', 'button', 'select', 'textarea', 'option', 'optgroup', 'label', 'output',
  'video', 'audio', 'source', 'track', 'canvas',
  'base', 'link', 'meta', 'title',
]);

/** `<link>` 里唯一放行的 rel；`preload` / `prefetch` / `dns-prefetch` 比图片更能泄漏意图 */
const STYLESHEET_REL = 'stylesheet';

export interface HtmlDocStats {
  /** 会被联网加载的外部资源数（联网开关关掉时恒为 0） */
  remoteLoaded: number;
  /** 因开关关闭而没加载的外部资源数 */
  remoteBlocked: number;
  /** 引用了本地相对路径或无效地址、已跳过的资源数 */
  unresolved: number;
}

export interface PreparedHtml {
  /** 整份文档，可直接作为 iframe 的 `srcdoc` */
  doc: string;
  /** 与文档里 `data-mr-unit` 一一对应的单元（段号同源同序） */
  units: HtmlUnit[];
  stats: HtmlDocStats;
}

export interface PrepareHtmlOptions {
  /** 是否允许加载远程图片 / 样式表 / 字体 */
  remote: boolean;
  /**
   * 高亮色，`"R G B"` 形式（与 mdui 的 `--mdui-color-primary` 同格式）。
   * iframe 是独立文档，CSS 自定义属性**不跨文档继承**，所以只能把值取出来写死进去。
   */
  markRgb?: string;
}

const DEFAULT_MARK_RGB = '103 80 164';

/**
 * 文档级 CSP。
 *
 * 这是**第二道闸**，与净化相互独立：净化规则总会漏（`<style>` 里的 `@import`、
 * CSS 变量拼出来的 URL），CSP 不会。`script-src` 走 `default-src 'none'` 兜底 ——
 * 这条比沙箱更靠前，因为它是**声明式**的，不依赖我们对标签黑名单的完备性。
 */
export function cspFor(remote: boolean): string {
  const net = remote ? ' https: http:' : '';
  return [
    "default-src 'none'",
    `img-src data: blob:${net}`,
    `style-src 'unsafe-inline'${net}`,
    `font-src data:${net}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** 我们自己注入的样式：锚点落点留白 + 引用跳转高亮。原文档的样式一概不动。 */
function overlayCss(markRgb: string): string {
  const rgb = /^\d{1,3}(?: \d{1,3}){2}$/.test(markRgb) ? markRgb : DEFAULT_MARK_RGB;
  return [
    `[${MR_UNIT_ATTR}]{scroll-margin-top:12px}`,
    `.mr-doc-mark{background:rgb(${rgb} / 0.22)!important;box-shadow:0 0 0 3px rgb(${rgb} / 0.85)!important;border-radius:4px}`,
  ].join('\n');
}

/**
 * 整份文档 → 可塞进沙箱 iframe 的 `srcdoc`。
 *
 * 净化分三层，缺一不可：
 * 1. **结构性黑名单**（本函数）：删掉能执行代码 / 自行导航 / 拖入宿主的元素与属性；
 * 2. **CSP**（注入 head 首位）：`default-src 'none'` 兜住所有漏网的加载；
 * 3. **沙箱**（HtmlReader 的 `sandbox` 属性）：不给 `allow-scripts`，这是底线。
 *
 * 相对路径必须显式拦住（不变量 4）：`srcdoc` 文档的 base URL 是**宿主页面的 URL**，
 * `./bg.png` 会解析到应用自己的域名上，导入一份网页就等于给应用服务器发一堆 404。
 */
export function prepareHtmlDocument(src: string, opts: PrepareHtmlOptions): PreparedHtml {
  if (typeof DOMParser === 'undefined') throw new Error('当前环境不支持 HTML 解析');
  const doc = new DOMParser().parseFromString(src, 'text/html');
  const stats: HtmlDocStats = { remoteLoaded: 0, remoteBlocked: 0, unresolved: 0 };

  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const name = el.localName.toLowerCase();

    if (name === 'meta') {
      // refresh 能让文档自己跳走（跳出沙箱之外也一样会发请求）；charset 已由解码阶段消费；
      // viewport 由我们注入自己的那份（原文档可能是 width=1200，在 iPad 上会缩成一团）
      const equiv = (el.getAttribute('http-equiv') ?? '').toLowerCase();
      if (equiv === 'refresh' || el.hasAttribute('charset') || el.getAttribute('name')?.toLowerCase() === 'viewport') {
        el.remove();
      }
      continue;
    }

    if (name === 'link') {
      const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
      const href = (el.getAttribute('href') ?? '').trim();
      if (!rel.includes(STYLESHEET_REL)) {
        el.remove();
        continue;
      }
      const kind = urlKind(href);
      if (kind === 'remote') {
        if (opts.remote) stats.remoteLoaded++;
        else stats.remoteBlocked++;
        el.remove();
        continue;
      }
      // 内嵌样式表用 data: 的情况罕见但合法；其余（相对路径等）都留不住
      if (kind === 'inline') continue;
      if (kind === 'relative') stats.unresolved++;
      el.remove();
      continue;
    }

    if (DROP_LOCAL_NAMES.has(name)) {
      el.remove();
      continue;
    }

    // 事件属性在沙箱里执行不了，但留着是纯负担，且会让「有没有脚本面」这件事变得要靠推理
    for (const attr of el.getAttributeNames()) {
      if (attr.startsWith('on')) el.removeAttribute(attr);
    }
  }

  // 图片：只留内嵌与（开关允许的）远程；`srcset` 没法逐条重写，直接摘掉
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = (img.getAttribute('src') ?? '').trim();
    img.removeAttribute('srcset');
    img.removeAttribute('background');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    const kind = urlKind(src);
    if (kind === 'inline') continue;
    if (kind === 'remote') {
      if (opts.remote) {
        stats.remoteLoaded++;
        continue;
      }
      stats.remoteBlocked++;
    } else if (kind === 'relative') {
      stats.unresolved++;
    }
    img.removeAttribute('src');
  }

  // 链接：http(s) / mailto 放行（由父窗口拦截后打开），页内锚点放行（不产生请求），其余摘掉
  for (const a of Array.from(doc.querySelectorAll('a'))) {
    const href = (a.getAttribute('href') ?? '').trim();
    if (!/^(?:https?:|mailto:|#)/i.test(href)) a.removeAttribute('href');
  }

  // CSS 里的 url() 与 @import 同样要过一遍（含 style 属性）
  for (const el of Array.from(doc.querySelectorAll('style'))) {
    el.textContent = rewriteCss(el.textContent ?? '', opts.remote, stats);
  }
  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    el.setAttribute('style', rewriteCss(el.getAttribute('style') ?? '', opts.remote, stats));
  }

  // 抽单元并把段号写回原 DOM —— 必须在上面的删改之后做，否则会算出不存在的段
  const units = walkUnits(doc.body, true);

  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
  // CSP 必须是 head 的第一个元素：在它之前的任何资源都不受约束
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', cspFor(opts.remote));
  head.prepend(csp);

  const viewport = doc.createElement('meta');
  viewport.setAttribute('name', 'viewport');
  viewport.setAttribute('content', 'width=device-width, initial-scale=1');
  head.append(viewport);

  const overlay = doc.createElement('style');
  overlay.setAttribute('data-mr-overlay', '');
  overlay.textContent = overlayCss(opts.markRgb ?? DEFAULT_MARK_RGB);
  head.append(overlay);

  return { doc: `<!doctype html>\n${doc.documentElement.outerHTML}`, units, stats };
}

/* ── CSS 文本改写 ─────────────────────────────────────────────────────────── */

const CSS_IMPORT_RE = /@import[^;]*;?/gi;
const CSS_URL_RE = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"\s]*))\s*\)/gi;
/** 非 global 版本，给 `@import` 里的 URL 提取用（global 正则带 lastIndex 状态，共享会踩坑） */
const CSS_URL_TOKEN = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"\s]*))\s*\)/i;
const CSS_IMPORT_STR = /@import\s+(?:'([^']*)'|"([^"]*)")/i;

/** 取匹配里第一个有值的捕获组：三种写法（`'x'` / `"x"` / 裸 `x`）落在不同组上 */
function firstGroup(m: RegExpExecArray | null): string {
  if (!m) return '';
  return (m[1] ?? m[2] ?? m[3] ?? '').trim();
}

/**
 * 改写 CSS 文本里的外部引用。
 *
 * 只处理「相对路径」与「不允许的 scheme」两种情况：远程引用在开关打开时原样留着
 * （由 CSP 决定能不能加载），内嵌与页内锚点不动。
 *
 * ⚠️ 这是**正则级**的近似处理，不是 CSS 解析器：`@import` 遇到 url 里带 `;` 的极端写法
 * 会切错。代价可接受 —— 切错的后果是背景图不出来，而**不做**处理的后果是给应用自己的
 * 域名发请求（不变量 4）。真要精确得引一个 CSS parser，为一个材料阅读器不值得。
 */
export function rewriteCss(css: string, remote: boolean, stats?: HtmlDocStats): string {
  const count = (kind: UrlKind) => {
    if (!stats) return;
    if (kind === 'relative') stats.unresolved++;
  };

  let out = css.replace(CSS_IMPORT_RE, (stmt) => {
    // `@import url("x")` / `@import "x"` / `@import url(x)` 三种写法都要认
    const url = firstGroup(CSS_URL_TOKEN.exec(stmt)) || firstGroup(CSS_IMPORT_STR.exec(stmt));
    const kind = urlKind(url);
    if (kind === 'remote' && remote) {
      if (stats) stats.remoteLoaded++;
      return stmt;
    }
    if (kind === 'remote') {
      if (stats) stats.remoteBlocked++;
    } else {
      count(kind);
    }
    return '/* mr: @import 已移除 */';
  });

  out = out.replace(CSS_URL_RE, (whole, single, double, bare) => {
    const url = (single ?? double ?? bare ?? '').trim();
    const kind = urlKind(url);
    if (kind === 'remote') {
      if (!stats) return whole;
      if (remote) {
        stats.remoteLoaded++;
        return whole;
      }
      stats.remoteBlocked++;
      return 'url("about:invalid")';
    }
    if (kind === 'relative' || kind === 'other') {
      count(kind);
      // about:invalid 是合法 URL 但永远加载不出来：占住位置，不产生任何请求
      return 'url("about:invalid")';
    }
    return whole;
  });

  return out;
}

/* ── 分段视图的片段净化（白名单） ─────────────────────────────────────────── */

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark', 'small', 'sub', 'sup',
  'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'figure', 'figcaption', 'details', 'summary', 'img', 'a', 'div', 'span',
];
const ALLOWED_ATTR = ['href', 'title', 'alt', 'src', 'colspan', 'rowspan', 'start'];

/**
 * 将一个 HTML 单元净化成可插入阅读器 DOM 的片段（**分段视图专用**）。
 *
 * 这里走白名单是合适的：只需要保留一小撮语义标签，白名单越窄越安全。
 * 整文档路径不能这么干，理由见文件头。
 */
export function sanitizeHtmlFragment(raw: string): string {
  const clean = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  if (typeof clean !== 'string' || !clean) return '';

  // DOMPurify 负责脚本面；这里再收紧网络面，避免导入文档静默加载跟踪图片。
  const template = document.createElement('template');
  template.innerHTML = clean;
  template.content.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
    const src = img.getAttribute('src')?.trim() ?? '';
    if (urlKind(src) !== 'inline') img.removeAttribute('src');
    img.loading = 'lazy';
    img.decoding = 'async';
  });
  template.content.querySelectorAll<HTMLAnchorElement>('a').forEach((a) => {
    const href = a.getAttribute('href')?.trim() ?? '';
    if (!/^(?:https?:|mailto:|#)/i.test(href)) {
      a.removeAttribute('href');
      return;
    }
    if (!href.startsWith('#')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  });
  return template.innerHTML;
}

/* ── 读取与解码 ───────────────────────────────────────────────────────────── */

/**
 * 按文档自己声明的字符集解码。
 *
 * 为什么不能直接 `blob.text()`：它**一律按 UTF-8 解**，而中文网页存档里 GB2312 / GBK
 * 占相当大的比例，直接读会整篇乱码 —— 乱码的 HTML 谈不上「原样」。
 * 浏览器的做法是看 HTTP 头与 `<meta charset>`，我们没有 HTTP 头，退而求其次看 meta。
 *
 * 只在文档开头嗅探（规范允许的范围就是前 1024 字节），嗅不到或标签不认识时回落 UTF-8 ——
 * 与现状行为一致，不会比现在更差。
 */
export async function readHtmlText(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const label = sniffCharset(bytes);
  if (!label) return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // 未知标签：退回 UTF-8，而不是抛错让整份材料打不开
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function sniffCharset(bytes: Uint8Array): string | null {
  // 只用 ASCII 视角扫开头：这几十个字节里不会有非 ASCII 字节参与匹配
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (bom) return 'utf-8';
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  if (!m) return null;
  const label = m[1].toLowerCase();
  return label === 'utf8' || label === 'utf-8' ? 'utf-8' : label;
}
