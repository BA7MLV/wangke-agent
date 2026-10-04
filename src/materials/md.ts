/**
 * Markdown 阅读材料的纯文本抽取。
 *
 * 与 Word 同一套产物：`RawUnit[]`（标题 / 正文，空块不占段号）。
 * 不依赖 DOM，相对导入带 `.ts`，供 `node scripts/test-material-md.mjs` 直接测。
 */
import type { RawUnit } from './chunk.ts';

export const MD_MIME = 'text/markdown';

export function isMarkdownFile(file: { name: string; type?: string }): boolean {
  const t = file.type ?? '';
  if (t === MD_MIME || t === 'text/x-markdown') return true;
  const name = file.name.toLowerCase();
  return name.endsWith('.md') || name.endsWith('.markdown');
}

const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const ATX_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const SETEXT_RE = /^(=+|-+)[ \t]*$/;
const LIST_RE = /^(?:[-+*]|\d+[.)])[ \t]+/;

function stripFrontmatter(src: string): string {
  if (!src.startsWith('---')) return src;
  const end = src.indexOf('\n---', 3);
  if (end < 0) return src;
  const after = src.indexOf('\n', end + 1);
  return after < 0 ? '' : src.slice(after + 1);
}

interface Piece {
  text: string;
  title: boolean;
  /** 与上一段之间有空行。标题后的空行不算断开，便于把标题并进下一段正文。 */
  gap: boolean;
}

/**
 * 按块切：围栏整段保留，ATX / setext 标题单独成段，其余按空行成段。
 * 列表项之间没有空行时合并成一段，避免「一行一项」把段号打散。
 */
function piecesOf(src: string): Piece[] {
  const lines = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const pieces: Piece[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  let gap = false;

  const flush = (title: boolean) => {
    const text = buf.join('\n').trim();
    buf = [];
    if (text) {
      pieces.push({ text, title, gap });
      gap = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      buf.push(line);
      if (FENCE_RE.test(line) && line.startsWith(fence)) {
        fence = null;
        flush(false);
      }
      continue;
    }
  const open = FENCE_RE.exec(line);
  if (open) {
    flush(false);
    fence = open[1];
    buf.push(line);
    continue;
  }

    if (!line.trim()) {
      flush(false);
      gap = true;
      continue;
    }

    const atx = ATX_RE.exec(line);
    if (atx) {
      flush(false);
      pieces.push({ text: atx[2].trim(), title: true, gap });
      gap = false;
      continue;
    }

    const next = lines[i + 1];
    if (next !== undefined && SETEXT_RE.test(next) && !LIST_RE.test(line) && line.trim()) {
      flush(false);
      pieces.push({ text: line.trim(), title: true, gap });
      gap = false;
      i++;
      continue;
    }

    buf.push(line);
  }
  flush(false);
  return pieces;
}

/**
 * Markdown → 文本单元。
 *
 * 段号按**空行分隔的正文块**计，标题并进紧随其后的那段（不单独占号）。
 * 这样问答里的「第 N 段」指的是正文段落，而不是「标题也算一段」之后的错位序号。
 * 标题仍写入 `section`，供位置标签使用；块本身 `kind` 为 `title` 时表示这一段以标题开头。
 */
export function extractMdUnits(src: string): RawUnit[] {
  const body = stripFrontmatter(src.replace(/^\uFEFF/, ''));
  const pieces = piecesOf(body);
  const units: RawUnit[] = [];
  let section: string | undefined;
  let i = 0;
  while (i < pieces.length) {
    const heads: string[] = [];
    while (i < pieces.length && pieces[i].title) {
      section = pieces[i].text;
      heads.push(pieces[i].text);
      i++;
    }
    if (i < pieces.length && !pieces[i].title && (heads.length > 0 || !pieces[i].gap || units.length === 0)) {
      const bodyText = pieces[i].text;
      const text = heads.length > 0 ? `${heads.join('\n\n')}\n\n${bodyText}` : bodyText;
      units.push({
        unit: units.length + 1,
        text,
        kind: heads.length > 0 ? 'title' : 'body',
        section,
      });
      i++;
      continue;
    }
    if (heads.length > 0) {
      units.push({
        unit: units.length + 1,
        text: heads.join('\n\n'),
        kind: 'title',
        section,
      });
    }
    if (i < pieces.length && !pieces[i].title) {
      units.push({
        unit: units.length + 1,
        text: pieces[i].text,
        kind: 'body',
        section,
      });
      i++;
    }
  }
  return units;
}

/** 读 .md 原文（UTF-8）。阅读器渲染用这份，不要用分块后的文本拼回去。 */
export async function readMdText(blob: Blob): Promise<string> {
  return blob.text();
}

// ── 封面文案 ───────────────────────────────────────────────────────────────

/** 封面标题卡要的文案：从原文里取「一个标题 + 一段正文」 */
export interface MdCoverText {
  /** 封面主标题：全文首个标题。**没有标题时为 null**，由调用方回落文件名 */
  title: string | null;
  /** 首段正文的单行预览，已剥掉 markdown 标记 */
  preview: string;
}

/**
 * 剥掉块级与行内标记，压成一行可读文字。
 *
 * 顺序有讲究：先拆链接（`[文字](url)` 里含 `*` 与 `_`，晚了会被强调规则咬掉），
 * 再拆围栏首行与列表标记，最后才是强调 —— 强调用非贪婪 + 排除换行，
 * 宁可漏掉一处斜体，也不要把两段正文粘成一句。
 */
function flattenMd(text: string): string {
  return text
    .replace(/^\s*(`{3,}|~{3,}).*$/gm, '') // 围栏首行（围栏正文保留，那些往往是代码本身）
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接 / 图片 → 只留文字
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '') // 列表项
    .replace(/^\s*>\s?/gm, '') // 引用
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // 行内标题
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // 粗体
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2') // 斜体
    .replace(/`+([^`]*)`+/g, '$1') // 行内代码
    // 行内公式只留内容：`$A$` 显示成 `A`，不然封面上会是一排裸露的美元符号
    .replace(/(?<![$\\])\$([^$\n]+)\$(?!\$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 取封面标题卡要用的「标题 + 首段预览」。
 *
 * **直接用 `piecesOf`**（与阅读器、抽取同一套切块规则），不另写一套解析，也不再从
 * `extractMdUnits` 的产物反推：那个函数把标题并进了正文（`标题\n\n正文`，多个标题还是
 * `甲\n\n乙\n\n正文`），想只留正文就得按「剥掉开头那几行标题」把它拆回去 —— 而标题在
 * 产物里已经和正文长得一模一样，拆回去必然出错。`pieces` 里标题与正文是两个独立条目，
 * 各拿各的，一行判断都不用。
 *
 * 标题取**首个标题、不要求是 H1**：只从 H2 起的文档（导出常见）拿 H2 当标题，
 * 远比回落文件名贴切。没有标题返回 `null` 而不是空串 —— 调用方据此决定用不用文件名，
 * 空串会被误当成「有标题但排不出来」。
 *
 * 预览取**第一个正文条目**，前面的标题条目自然被跳过（连续两行标题的写法很常见）。
 */
export function mdCoverText(src: string): MdCoverText {
  const pieces = piecesOf(stripFrontmatter(src.replace(/^\uFEFF/, '')));
  let title = '';
  let preview = '';
  // 不 break：标题取**全文**首个、预览取**首个正文条目**，两者位置未必挨着
  // （正文开头没有标题、标题出现在第二段的文档很常见），提前退出会把标题漏掉。
  for (const p of pieces) {
    if (p.title) {
      // piecesOf 的标题恒为单行（ATX 捕获整行、setext 只留 `===` 上一行），直接就是标题文字
      if (!title) title = p.text;
      continue;
    }
    if (!preview) preview = flattenMd(p.text);
  }
  return { title: title || null, preview };
}
