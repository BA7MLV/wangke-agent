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
