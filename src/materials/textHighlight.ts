/// <reference lib="es2022.intl" />
import type { InkRect, TextAnchor } from './ink';

interface TextRun { node: Text; start: number; end: number }
interface HitRun { run: TextRun; rects: DOMRect[] }
interface Glyph { start: number; end: number; rects: DOMRect[] }
export interface TextIndex {
  text: string; runs: TextRun[]; host: HTMLElement;
  layout?: { bounds: DOMRect; runs: HitRun[]; glyphs: Map<TextRun, Glyph[]> };
}
const EXCLUDE = '.ink-layer,.mr-md__badge,.mr-html__badge,script,style,button,textarea,select,[hidden],[aria-hidden="true"],.katex-mathml';
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

export function indexText(host: HTMLElement): TextIndex {
  const root = host.querySelector('.textLayer') ?? host;
  const walker = host.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (element.matches(EXCLUDE) || host.ownerDocument.defaultView?.getComputedStyle(element).display === 'none') return NodeFilter.FILTER_REJECT;
        return element.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return node.parentElement?.closest(EXCLUDE) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = '';
  const runs: TextRun[] = [];
  let previousBlock: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) { if (text && !text.endsWith('\n')) text += '\n'; continue; }
    const value = node.textContent ?? '';
    if (!value) continue;
    const block = node.parentElement?.closest('p,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote') ?? null;
    if (text && block && previousBlock && block !== previousBlock && !text.endsWith('\n')) text += '\n';
    previousBlock = block;
    runs.push({ node: node as Text, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text, runs, host };
}

const rangeOf = (run: TextRun, start = run.start, end = run.end) => {
  const range = run.node.ownerDocument.createRange();
  range.setStart(run.node, Math.max(start, run.start) - run.start);
  range.setEnd(run.node, Math.min(end, run.end) - run.start);
  return range;
};

/** 把浏览器选区映射回正文索引；按节点定位，重复文本不会误标到别处。 */
export function selectionOffsets(index: TextIndex, selection: Range): { start: number; end: number } | null {
  let start = Infinity, end = -1;
  for (const run of index.runs) {
    if (!selection.intersectsNode(run.node)) continue;
    const from = selection.startContainer === run.node ? selection.startOffset : 0;
    const to = selection.endContainer === run.node ? selection.endOffset : run.node.length;
    if (to <= from) continue;
    start = Math.min(start, run.start + from);
    end = Math.max(end, run.start + to);
  }
  return end > start ? { start, end } : null;
}
const distance = (r: DOMRect, x: number, y: number) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));

/** 先定位文字节点，再按字素命中，避免逐帧扫描整页所有字符。 */
export function hitText(index: TextIndex, x: number, y: number, maxDistance = 32): { start: number; end: number } | null {
  const bounds = index.host.getBoundingClientRect(), previous = index.layout?.bounds;
  // 同一次拖选只测量一次文字节点 / 字素，避免长 Word 文档每帧反复强制布局。
  if (!previous || bounds.x !== previous.x || bounds.y !== previous.y || bounds.width !== previous.width || bounds.height !== previous.height) {
    index.layout = { bounds, runs: index.runs.map((run) => ({ run, rects: [...rangeOf(run).getClientRects()] })), glyphs: new Map() };
  }
  const layout = index.layout!;
  let best: TextRun | undefined, min = Infinity;
  for (const { run, rects } of layout.runs) {
    for (const rect of rects) {
      if (!rect.width || !rect.height) continue;
      const d = distance(rect, x, y);
      if (d < min) { min = d; best = run; }
    }
  }
  if (!best || min > maxDistance) return null;
  let hit: { start: number; end: number } | null = null;
  min = Infinity;
  let glyphs = layout.glyphs.get(best);
  if (!glyphs) {
    let offset = 0;
    const segments = segmenter?.segment(best.node.data) ?? Array.from(best.node.data, (segment) => {
      const index = offset; offset += segment.length; return { segment, index };
    });
    glyphs = Array.from(segments, (s) => {
      const start = best!.start + s.index, end = start + s.segment.length;
      return { start, end, rects: [...rangeOf(best!, start, end).getClientRects()] };
    });
    layout.glyphs.set(best, glyphs);
  }
  for (const { start, end, rects } of glyphs) {
    for (const r of rects) {
      if (!r.width || !r.height) continue;
      const d = distance(r, x, y);
      if (d < min) { min = d; hit = { start, end }; }
    }
  }
  return hit;
}

export function resolveTextAnchor(text: string, a: TextAnchor): { start: number; end: number } | null {
  if (!a.exact) return null;
  const matches = (start: number) => (!a.prefix || text.slice(Math.max(0, start - a.prefix.length), start) === a.prefix)
    && (!a.suffix || text.slice(start + a.exact.length, start + a.exact.length + a.suffix.length) === a.suffix);
  if (text.slice(a.start, a.end) === a.exact && matches(a.start)) return { start: a.start, end: a.end };
  let found = -1;
  for (let i = text.indexOf(a.exact); i !== -1; i = text.indexOf(a.exact, i + 1)) {
    if (!matches(i)) continue;
    if (found !== -1) return null;
    found = i;
  }
  return found < 0 ? null : { start: found, end: found + a.exact.length };
}

export function textRects(index: TextIndex, start: number, end: number, host: HTMLElement): InkRect[] {
  const base = host.getBoundingClientRect();
  if (!base.width) return [];
  const boxes: InkRect[] = [];
  for (const run of index.runs) {
    if (run.end <= start || run.start >= end) continue;
    for (const r of rangeOf(run, start, end).getClientRects()) {
      if (r.width <= 0 || r.height <= 0) continue;
      boxes.push({ x: (r.left - base.left) / base.width * 1000, y: (r.top - base.top) / base.width * 1000,
        w: r.width / base.width * 1000, h: r.height / base.width * 1000 });
    }
  }
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  const merged: InkRect[] = [];
  for (const b of boxes) {
    const last = merged.at(-1);
    if (last && Math.abs(last.y - b.y) < 1 && Math.abs(last.h - b.h) < 1 && b.x <= last.x + last.w + 1) {
      last.w = Math.max(last.x + last.w, b.x + b.w) - last.x;
    } else merged.push({ ...b });
  }
  return merged;
}

export function makeTextAnchor(index: TextIndex, start: number, end: number, host: HTMLElement, surface: string): TextAnchor {
  const source = surface.split(':')[0] as TextAnchor['source'];
  const first = index.runs.find((r) => r.end > start)?.node.parentElement?.closest<HTMLElement>('[data-askable]');
  const unit = Number(first?.dataset.askUnit ?? first?.dataset.unit ?? surface.split(':')[1]);
  const last = index.runs.find((r) => r.end >= end)?.node.parentElement?.closest<HTMLElement>('[data-askable]');
  const endUnit = Number(last?.dataset.askUnit ?? last?.dataset.unit ?? unit);
  return { start, end, exact: index.text.slice(start, end), prefix: index.text.slice(Math.max(0, start - 32), start), suffix: index.text.slice(end, end + 32),
    source, unit, endUnit, unitLabel: endUnit !== unit ? `第 ${unit}–${endUnit} 段` : first?.dataset.askLabel ?? host.dataset.askLabel ?? `第 ${unit} ${source === 'pdf' ? '页' : '段'}` };
}
