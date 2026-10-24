/**
 * Small, dependency-free helpers for HTML that is still being generated.
 *
 * This module deliberately does not try to "fix" HTML by regex-replacing the
 * whole document.  It answers three bounded questions:
 *
 * 1. Which prefix ends at a complete top-level element and can be frozen?
 * 2. Which JSON string value has arrived so far in a streamed tool call?
 * 3. Where do HTML blocks end so later Markdown and questions stay separate?
 *
 * The returned HTML is still untrusted.  It must go through the DOMPurify
 * pipeline in `StreamingHtmlPreview` before it is put in the DOM.
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/**
 * Tags that are plausible roots of a model-generated HTML answer.
 *
 * This is intentionally a positive list.  A sentence such as `2 < 3` or a
 * Markdown autolink must continue through the Markdown renderer; only a
 * message that starts like an HTML fragment is routed to the HTML preview.
 */
const HTML_ROOT_TAGS = new Set([
  'a', 'article', 'aside', 'b', 'blockquote', 'body', 'button', 'caption', 'code',
  'col', 'colgroup', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'em', 'fieldset',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'img', 'input', 'label', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'select', 'small', 'span', 'strong', 'summary', 'table', 'tbody', 'td',
  'textarea', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/**
 * Decide whether an assistant message should use the HTML preview path.
 *
 * The normal answer renderer is Markdown.  Raw HTML needs a separate path so
 * incomplete tags do not get displayed as source text while a response is
 * streaming.  We only switch when the first meaningful token is a recognised
 * HTML root (or a doctype/html shell); Markdown prose and fenced code remain
 * untouched.
 */
export function looksLikeStreamingHtml(source: string): boolean {
  const text = source.trimStart();
  if (!text) return false;
  if (readFencedHtml(text) !== undefined) return true;
  return looksLikeRawHtml(text);
}

/**
 * Return the payload only when the answer contains a single HTML block.
 *
 * Fenced HTML is common when a model was not instructed to use the widget
 * tool.  It is still an HTML answer, not something the user should have to
 * copy-paste into a browser. Mixed answers return `undefined`; render those
 * with splitAssistantContent rather than treating the entire answer as HTML.
 */
export function htmlPreviewSource(source: string): string | undefined {
  const blocks = splitAssistantContent(source).filter((block) => block.source.trim());
  return blocks.length === 1 && blocks[0].kind === 'html' ? blocks[0].source : undefined;
}

export interface AssistantContentBlock {
  kind: 'markdown' | 'html';
  source: string;
  /** Offsets in the original answer, including fence markers when fenced. */
  start: number;
  end: number;
  location?: 'html' | 'fence';
  closed: boolean;
}

/** Split visual blocks without letting one HTML answer consume later prose or questions. */
export function splitAssistantContent(source: string): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = [];
  let markdownStart = 0;
  let cursor = 0;
  const markdown = (end: number) => {
    if (end > markdownStart) blocks.push({ kind: 'markdown', source: source.slice(markdownStart, end), start: markdownStart, end, closed: true });
  };
  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor);
    const lineEnd = newline < 0 ? source.length : newline + 1;
    const line = source.slice(cursor, lineEnd).replace(/\r?\n$/, '');
    const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*)[^\r\n]*$/.exec(line);
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*(?:\\r?\\n|$)`, 'gm');
      closing.lastIndex = lineEnd;
      const match = closing.exec(source);
      const end = match ? match.index + match[0].length : source.length;
      if (/^html?$/i.test(fence[2])) {
        markdown(cursor);
        blocks.push({ kind: 'html', source: source.slice(lineEnd, match?.index ?? end).replace(/\s+$/, ''),
          start: cursor, end, location: 'fence', closed: !!match });
        markdownStart = end;
      }
      // Never interpret HTML examples inside another language's code fence.
      cursor = end;
    } else if (/^ {0,3}</.test(line) && looksLikeRawHtml(line.trimStart())) {
      markdown(cursor);
      const end = rawHtmlEnd(source, cursor);
      blocks.push({ kind: 'html', source: source.slice(cursor, end ?? source.length), start: cursor,
        end: end ?? source.length, location: 'html', closed: end !== undefined });
      cursor = end ?? source.length;
      markdownStart = cursor;
    } else {
      cursor = lineEnd;
    }
  }
  markdown(source.length);
  return blocks;
}

/** Retrieval narration can reset; delivered visuals and their surrounding explanation cannot. */
export function nextVisualRound(source: string, hasWidgets = false): string {
  const visual = hasWidgets || splitAssistantContent(source).some((block) => block.kind === 'html')
    || /^ {0,3}(?:`{3,}|~{3,})wbw-widget[ \t]*$/m.test(source);
  return visual && source.trim() ? `${source.trimEnd()}\n\n` : '';
}

/** Read exactly one root, respecting quoted attributes, comments and raw-text elements. */
function rawHtmlEnd(source: string, start: number): number | undefined {
  const stack: string[] = [];
  let cursor = start;
  while (cursor < source.length) {
    const raw = stack[stack.length - 1];
    if (raw && /^(?:script|style|textarea|title)$/i.test(raw)) {
      const closing = new RegExp(`</${raw}\\s*>`, 'gi');
      closing.lastIndex = cursor;
      const match = closing.exec(source);
      if (!match) return undefined;
      cursor = match.index;
    }
    const open = source.indexOf('<', cursor);
    if (open < 0) return undefined;
    if (!/[A-Za-z!/?]/.test(source[open + 1] ?? '')) {
      cursor = open + 1;
      continue;
    }
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      if (end < 0) return undefined;
      cursor = end + 3;
      if (!stack.length) return cursor;
      continue;
    }
    const end = findTagEnd(source, open + 1);
    if (end < 0) return undefined;
    const token = source.slice(open, end + 1);
    const closing = /^<\/\s*([A-Za-z][\w:-]*)/.exec(token);
    const opening = /^<([A-Za-z][\w:-]*)(?:\s|\/?>)/.exec(token);
    if (closing) {
      const index = stack.lastIndexOf(closing[1].toLowerCase());
      if (index >= 0) stack.length = index;
      if (!stack.length) return end + 1;
    } else if (opening) {
      const name = opening[1].toLowerCase();
      if (!VOID_TAGS.has(name) && !/\/\s*>$/.test(token)) stack.push(name);
      if (!stack.length) return end + 1;
    }
    cursor = end + 1;
  }
  return undefined;
}

function looksLikeRawHtml(text: string): boolean {
  if (text.startsWith('```') || text.startsWith('~~~')) return false;
  if (/^<!doctype\s+html(?:\s|>|$)/i.test(text)) return true;
  if (/^<!--(?:.|\n)*?(?:-->|$)/.test(text)) return true;
  const opening = /^<([A-Za-z][\w:-]*)(?:\s[^<>]*|\s*\/?>|$)/.exec(text);
  return !!opening && HTML_ROOT_TAGS.has(opening[1].toLowerCase());
}

function readFencedHtml(text: string): string | undefined {
  const match = /^(`{3,}|~{3,})[ \t]*(?:html|htm)[ \t]*(?:\r?\n|$)([\s\S]*)$/i.exec(text);
  if (!match) return undefined;
  const marker = match[1];
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return match[2].replace(new RegExp(`\\r?\\n${escaped}[ \\t]*$`), '');
}

export interface StreamingHtmlSplit {
  /** Raw prefix ending at the latest complete top-level element. */
  stableEnd: number;
  /** The un-frozen tail, including an incomplete tag when one is present. */
  live: string;
  /** A tag/comment that has started but has not reached its closing delimiter. */
  incompleteTag: string;
}

/**
 * Find a conservative stable boundary.
 *
 * We intentionally freeze less rather than more.  A malformed HTML parser
 * should leave the tail live; the browser's HTML parser can then auto-close
 * the live fragment for a useful preview without making an untrusted partial
 * tag executable.
 */
export function splitStreamingHtml(source: string): StreamingHtmlSplit {
  let cursor = 0;
  let stableEnd = 0;
  const stack: string[] = [];

  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open < 0) break;

    // A less-than sign in ordinary text is not an unfinished tag.  Continue
    // scanning so that a real tag later in the same text can still be found.
    const next = source[open + 1] ?? '';
    if (!/[A-Za-z!/\?]/.test(next)) {
      cursor = open + 1;
      continue;
    }

    if (source.startsWith('<!--', open)) {
      const commentEnd = source.indexOf('-->', open + 4);
      if (commentEnd < 0) {
        return { stableEnd, live: source.slice(stableEnd), incompleteTag: source.slice(open) };
      }
      cursor = commentEnd + 3;
      continue;
    }

    const end = findTagEnd(source, open + 1);
    if (end < 0) {
      return { stableEnd, live: source.slice(stableEnd), incompleteTag: source.slice(open) };
    }

    const token = source.slice(open, end + 1);
    const closing = /^<\s*\/\s*([A-Za-z][\w:-]*)/.exec(token);
    const opening = /^<\s*([A-Za-z][\w:-]*)/.exec(token);

    if (closing) {
      const name = closing[1].toLowerCase();
      // Pop through a mismatched stack instead of allowing one malformed tag
      // to keep every later block live forever.  This mirrors the browser's
      // error recovery closely enough for a preview boundary.
      const index = stack.lastIndexOf(name);
      if (index >= 0) stack.length = index;
      if (stack.length === 0) stableEnd = end + 1;
    } else if (opening) {
      const name = opening[1].toLowerCase();
      const selfClosing = /\/\s*>$/.test(token);
      if (!selfClosing && !VOID_TAGS.has(name)) stack.push(name);
      if (stack.length === 0) stableEnd = end + 1;
    } else if (stack.length === 0) {
      // Doctype / processing instructions are not useful in a fragment, but
      // they are complete tokens and should not block the real body forever.
      stableEnd = end + 1;
    }

    cursor = end + 1;
  }

  // Never freeze text ending in a half-written entity.  Otherwise `&amp` +
  // `;` across the boundary would become two different text nodes.
  const stableText = source.slice(0, stableEnd);
  if (/&(?:#x?[0-9a-f]{0,7}|[a-z][a-z0-9]{0,31})$/i.test(stableText)) stableEnd = 0;

  return { stableEnd, live: source.slice(stableEnd), incompleteTag: '' };
}

function findTagEnd(source: string, from: number): number {
  let quote = '';
  for (let i = from; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

/** Data extracted from a partially streamed show_widget tool argument. */
export interface PartialWidgetArguments {
  format?: string;
  /** Decoded prefix of the JSON `code` string. */
  code?: string;
}

/**
 * Decode the fields that are useful before the tool-call JSON is complete.
 *
 * Tool arguments are JSON, not HTML.  A plain `slice` would leave `\\n` and
 * `\\uXXXX` escapes in the preview and, worse, could cut an escape in half.
 * This decoder only returns complete escape sequences and therefore never
 * invents a character from an incomplete token.
 */
export function readPartialWidgetArguments(json: string): PartialWidgetArguments {
  return {
    format: readPartialJsonString(json, 'format'),
    code: readPartialJsonString(json, 'code'),
  };
}

function readPartialJsonString(json: string, key: string): string | undefined {
  const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"`);
  const match = re.exec(json);
  if (!match || match.index < 0) return undefined;
  const start = match.index + match[0].length;
  let value = '';

  for (let i = start; i < json.length; i += 1) {
    const char = json[i];
    if (char === '"') return value;
    if (char !== '\\') {
      // Literal control characters are not valid JSON string content.  Keep
      // the already decoded prefix and wait for the model to finish instead
      // of putting an invalid value through the sanitizer.
      if (char < ' ') return value;
      value += char;
      continue;
    }

    const escaped = json[i + 1];
    if (escaped == null) break;
    const simple: Record<string, string> = {
      '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
    };
    if (simple[escaped] !== undefined) {
      value += simple[escaped];
      i += 1;
      continue;
    }
    if (escaped === 'u') {
      const hex = json.slice(i + 2, i + 6);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      value += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    // Invalid escape: no safe, deterministic preview can be produced from it.
    break;
  }

  return value;
}
