/**
 * Split outbound Markdown without treating it as an opaque character array.
 *
 * This is intentionally a final-delivery chunker, not a token streamer. The
 * low/high watermarks and break order follow the block chunking pattern used
 * by mature multi-channel gateways: prefer semantic boundaries and only make
 * a hard cut when the platform limit leaves no other choice.
 */

type Fence = { start: number; end: number; open: string; close: string };
type Span = { start: number; end: number };

const fenceOpen = /^( {0,3})(`{3,}|~{3,})(.*)$/;

function codePoints(value: string): string[] { return Array.from(value); }
function units(value: string): number { return codePoints(value).length; }

function indexAtUnits(value: string, count: number): number {
  if (count <= 0) return 0;
  let seen = 0;
  for (const part of codePoints(value)) {
    if (seen++ >= count) break;
  }
  return Array.from(value).slice(0, count).join('').length;
}

function graphemeSafeIndex(value: string, index: number): number {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locales?: string | string[], options?: { granularity: string }) => { segment(input: string): Iterable<{ index: number; segment: string }> } }).Segmenter;
  if (!Segmenter) return index;
  let safe = 0;
  for (const part of new Segmenter('zh', { granularity: 'grapheme' }).segment(value)) {
    if (part.index >= index) return safe || part.index + part.segment.length;
    safe = part.index + part.segment.length;
  }
  return safe || value.length;
}

function fenceSpans(value: string): Fence[] {
  const result: Fence[] = [];
  let active: { start: number; marker: string; open: string } | undefined;
  let offset = 0;
  for (const line of value.split(/(?<=\n)/)) {
    const body = line.replace(/\r?\n$/, '');
    const match = fenceOpen.exec(body);
    if (!active && match) {
      active = { start: offset, marker: match[2], open: line };
    } else if (active && match && match[2][0] === active.marker[0] && match[2].length >= active.marker.length && !match[3].trim()) {
      result.push({ start: active.start, end: offset + line.length, open: active.open, close: `${match[1]}${match[2]}` });
      active = undefined;
    }
    offset += line.length;
  }
  if (active) result.push({ start: active.start, end: value.length, open: active.open, close: `${active.marker}` });
  return result;
}

function protectedSpans(value: string): Span[] {
  const spans: Span[] = [];
  const patterns = [
    /(`+)(?!`)([\s\S]*?)\1/g,
    /\$\$[\s\S]*?\$\$|(?<!\\)\$(?!\s)[^$\n]+?(?<!\\)\$/g,
    /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g,
    /\[[^\]\n]*\]\([^\)\n]*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      if (match.index !== undefined) spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return spans;
}

function safeBoundary(value: string, index: number, fences: Fence[], protectedRanges: Span[]): boolean {
  if (index <= 0 || index >= value.length) return false;
  if (fences.some(fence => index > fence.start && index < fence.end)) return false;
  return !protectedRanges.some(span => index > span.start && index < span.end);
}

function findBreak(value: string, limit: number, minimum: number, fences: Fence[], protectedRanges: Span[]): number {
  const window = value.slice(0, limit);
  const choose = (index: number) => index >= minimum && safeBoundary(value, index, fences, protectedRanges) ? index : -1;

  const paragraphs = [...window.matchAll(/\n[ \t]*\n+/g)];
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const index = choose((paragraphs[i].index ?? 0) + paragraphs[i][0].length);
    if (index > 0) return index;
  }
  for (let i = window.lastIndexOf('\n'); i >= minimum; i = window.lastIndexOf('\n', i - 1)) {
    const index = choose(i + 1);
    if (index > 0) return index;
  }
  const sentences = [...window.matchAll(/[。！？!?](?=\s|$)|[.!?](?=\s|$)/g)];
  for (let i = sentences.length - 1; i >= 0; i--) {
    const index = choose((sentences[i].index ?? 0) + sentences[i][0].length);
    if (index > 0) return index;
  }
  for (let i = window.length - 1; i >= minimum; i--) {
    if (/\s/.test(window[i])) {
      const index = choose(i + 1);
      if (index > 0) return index;
    }
  }
  return -1;
}

function activeFence(value: string, index: number, fences: Fence[]): Fence | undefined {
  return fences.find(fence => index > fence.start && index < fence.end);
}

/** Split Markdown into deterministic, platform-sized outbound messages. */
export function splitGatewayMarkdown(input: string, maxUnits = 1500): string[] {
  const value = String(input);
  if (!value || units(value) <= maxUnits) return [value];
  const parts: string[] = [];
  let rest = value;
  while (units(rest) > maxUnits) {
    const fences = fenceSpans(rest);
    const protectedRanges = protectedSpans(rest).filter(span => !fences.some(fence => span.start >= fence.start && span.end <= fence.end));
    const limit = indexAtUnits(rest, maxUnits);
    const minimum = indexAtUnits(rest, Math.max(1, Math.floor(maxUnits * 0.45)));
    let cut = findBreak(rest, limit, minimum, fences, protectedRanges);
    const fence = activeFence(rest, limit, fences);
    const atomic = protectedRanges.find(span => limit > span.start && limit < span.end);
    // A formula, inline code span, or link is more valuable intact than
    // syntactically broken. Prefer a boundary immediately before it; if the
    // single span itself is larger than the platform limit, send that span as
    // one exceptional part rather than corrupting the Markdown.
    if (atomic && units(rest.slice(atomic.start, atomic.end)) <= maxUnits && (cut < 0 || cut > atomic.start)) {
      cut = atomic.start >= minimum && safeBoundary(rest, atomic.start, fences, protectedRanges)
        ? atomic.start : atomic.end;
    }
    if (cut < 0) {
      const hardLimit = fence ? Math.max(1, indexAtUnits(rest, maxUnits - fence.close.length - 2)) : limit;
      cut = graphemeSafeIndex(rest, hardLimit);
    }
    if (cut <= 0) cut = graphemeSafeIndex(rest, limit) || limit;

    let chunk = rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).replace(/^\n+/, '');
    if (fence && cut > fence.start && cut < fence.end) {
      chunk = `${chunk}\n${fence.close}\n`;
      rest = `${fence.open}${rest}`;
    }
    if (chunk) parts.push(chunk);
  }
  if (rest.trim()) parts.push(rest.trimStart());
  return parts.length ? parts : [value];
}
