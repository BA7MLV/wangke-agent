/**
 * Small, dependency-free helpers for HTML that is still being generated.
 *
 * This module deliberately does not try to "fix" HTML by regex-replacing the
 * whole document.  It only answers two bounded questions:
 *
 * 1. Which prefix ends at a complete top-level element and can be frozen?
 * 2. Which JSON string value has arrived so far in a streamed tool call?
 *
 * The returned HTML is still untrusted.  It must go through the DOMPurify
 * pipeline in `StreamingHtmlPreview` before it is put in the DOM.
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

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
