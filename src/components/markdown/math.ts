import type { MarkedExtension, TokenizerExtension } from 'marked';

const MAX_MATH_LENGTH = 20000;
// GFM splits table cells before parsing HTML attributes, so TeX pipes need an entity too.
const escapeHtml = (text: string) => text.replace(/[&<>"'|]/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '|': '&#124;',
})[c]!);

/** Runs inside Marked's lexer: code spans/fences and escaped dollars retain Markdown semantics. */
export function mathExtension(streaming: boolean): MarkedExtension {
  const extension = (block: boolean): TokenizerExtension => ({
    name: block ? 'displayMath' : 'inlineMath',
    level: block ? 'block' : 'inline',
    start(src) {
      const match = block ? /(?:^|\n)(?=\$\$|\\\[)/.exec(src) : /\$|\\[([]/.exec(src);
      return match ? match.index + (block && match[0] === '\n' ? 1 : 0) : undefined;
    },
    tokenizer(src) {
      const open = src.startsWith('$$') ? '$$' : src.startsWith('\\[') ? '\\['
        : !block && src.startsWith('\\(') ? '\\(' : !block && src.startsWith('$') ? '$' : '';
      if (!open) return;
      const display = open === '$$' || open === '\\[';
      if (block && !display) return;
      // Currency such as "$20 and $30" must remain ordinary text. Explicit \(...\)
      // can always be used for numeric-only expressions with surrounding spaces.
      if (open === '$' && (!src[1] || /\s/.test(src[1]))) return;
      const close = open === '\\[' ? '\\]' : open === '\\(' ? '\\)' : open;
      let end = -1;
      const limit = Math.min(src.length, MAX_MATH_LENGTH);
      for (let i = open.length; i < limit; i++) {
        if (!display && (src[i] === '\n' || src[i] === '\r')) break;
        if (src.startsWith(close, i)) {
          if (open === '$' && (/\s/.test(src[i - 1]) || /[\d$]/.test(src[i + 1] || ''))) continue;
          if (open === '$' && src[i - 1] === '$') continue;
          end = i;
          break;
        }
        // Skip escaped delimiters (including \\$), but not the explicit \) / \] closer.
        if (src[i] === '\\') i++;
      }
      if (end === open.length) return;
      if (end < 0) {
        // A blank paragraph ends an unfinished expression. Never swallow later paragraphs.
        if (!streaming || src.length >= MAX_MATH_LENGTH || /\n\s*\n/.test(src)
          || (!display && /[\r\n]/.test(src)) || (open === '$' && /^\$\d/.test(src))) return;
        return { type: block ? 'displayMath' : 'inlineMath', raw: src, text: '', display, pending: true };
      }
      const raw = src.slice(0, end + close.length);
      return { type: block ? 'displayMath' : 'inlineMath', raw, text: src.slice(open.length, end), display, pending: false };
    },
  });
  return {
    gfm: true,
    breaks: false,
    extensions: [false, true].map(block => ({
      ...extension(block),
      renderer(token) {
        return `<math-formula data-display="${token.display}" data-pending="${token.pending}" data-source="${escapeHtml(token.text)}"></math-formula>${block ? '\n' : ''}`;
      },
    })),
  };
}

export const COMPLETE_MARKDOWN = mathExtension(false);
export const STREAMING_MARKDOWN = mathExtension(true);

/** Protect TeX before XMarkdown's Markdown-only streaming cache sees '_' / '['.
 * Only presentation is transformed; persisted content remains the original Markdown.
 */
export function protectMath(source: string, streaming: boolean): string {
  if (!/\$|\\[([]/.test(source)) return source;
  const extensions = (streaming ? STREAMING_MARKDOWN : COMPLETE_MARKDOWN).extensions!;
  const inline = extensions[0] as TokenizerExtension & { renderer: (token: Record<string, unknown>) => string };
  let out = '';
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    // Fenced and indented code are opaque, including an unclosed streaming fence.
    if (i === 0 || source[i - 1] === '\n') {
      const fence = /^(?:[ \t]*>[ \t]*)*[ \t]*(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(rest);
      if (fence) {
        const marker = fence[1];
        const close = new RegExp(`^(?:[ \\t]*>[ \\t]*)*[ \\t]*${marker[0]}{${marker.length},}[ \\t]*(?:\\n|$)`, 'm');
        const end = close.exec(rest.slice(fence[0].length));
        const length = end ? fence[0].length + end.index + end[0].length : rest.length;
        out += rest.slice(0, length); i += length; continue;
      }
      const indent = /^(?: {4}|\t)[^\n]*(?:\n|$)/.exec(rest);
      if (indent) { out += indent[0]; i += indent[0].length; continue; }
    }
    if (rest[0] === '`') {
      const run = /^`+/.exec(rest)![0];
      const endPattern = new RegExp(`(?<!\x60)\x60{${run.length}}(?!\x60)`);
      const end = endPattern.exec(rest.slice(run.length));
      const length = end ? run.length + end.index + run.length : rest.length;
      out += rest.slice(0, length); i += length; continue;
    }
    // HTML attributes, autolinks and Markdown link destinations are not math.
    const html = rest[0] === '<' ? /^<[^>]*(?:>|$)/.exec(rest) : null;
    if (html) { out += html[0]; i += html[0].length; continue; }
    if (rest.startsWith('](')) {
      let end = 2; let depth = 1;
      for (; end < rest.length && depth; end++) {
        if (rest[end] === '\\') end++;
        else if (rest[end] === '(') depth++;
        else if (rest[end] === ')') depth--;
      }
      out += rest.slice(0, end); i += end; continue;
    }
    if (rest[0] === '$' || rest.startsWith('\\(') || rest.startsWith('\\[')) {
      const token = inline.tokenizer!.call({} as never, rest, []);
      if (token) { out += inline.renderer(token); i += token.raw.length; continue; }
    }
    if (rest[0] === '\\' && rest.length > 1) {
      out += rest.slice(0, 2); i += 2; continue;
    }
    out += rest[0]; i++;
  }
  return out;
}
