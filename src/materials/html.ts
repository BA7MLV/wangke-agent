/**
 * HTML 阅读材料的识别、正文抽取与安全渲染。
 *
 * HTML 文件是不可信输入：解析阶段只在 DOMParser 生成的惰性文档里读文本；
 * 渲染阶段再经过严格白名单，脚本、表单、样式与外部图片都不会进入应用 DOM。
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
  /** 与 text 对齐的原始 HTML 片段；只允许交给 sanitizeHtmlFragment 后渲染。 */
  html: string;
}

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
 * HTML → 段落单元。
 *
 * 优先采用语义块（标题、段落、列表项、表格等）；只有页面只是若干 div 时才回退到
 * 最深的有字容器。标题与紧随其后的正文合成一个单元，规则与 Markdown 阅读器一致。
 */
export function extractHtmlUnits(src: string): HtmlUnit[] {
  if (typeof DOMParser === 'undefined') throw new Error('当前环境不支持 HTML 解析');
  const doc = new DOMParser().parseFromString(src, 'text/html');
  doc.querySelectorAll('script,style,noscript,template,iframe,object,embed,form').forEach((el) => el.remove());
  const body = doc.body;

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

  const elements = [...primary, ...fallback].sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
  });

  // 没有任何块标签时，仍把 body 的纯文本作为一段导入。
  if (elements.length === 0) {
    const text = textOf(body);
    return text ? [{ unit: 1, text, html: `<p>${escapeHtml(text)}</p>`, kind: 'body' }] : [];
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
    const html = [...heads.map((h) => h.outerHTML), el?.outerHTML ?? ''].filter(Boolean).join('\n');
    units.push({
      unit: units.length + 1,
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

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark', 'small', 'sub', 'sup',
  'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'figure', 'figcaption', 'details', 'summary', 'img', 'a', 'div', 'span',
];
const ALLOWED_ATTR = ['href', 'title', 'alt', 'src', 'colspan', 'rowspan', 'start'];

/** 将一个 HTML 单元净化成可插入阅读器 DOM 的片段。 */
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
    if (!/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i.test(src)) img.removeAttribute('src');
    img.loading = 'lazy';
    img.decoding = 'async';
  });
  template.content.querySelectorAll<HTMLAnchorElement>('a').forEach((a) => {
    const href = a.getAttribute('href')?.trim() ?? '';
    if (!/^(?:https?:|mailto:)/i.test(href)) {
      a.removeAttribute('href');
      return;
    }
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  return template.innerHTML;
}

export async function readHtmlText(blob: Blob): Promise<string> {
  return blob.text();
}
