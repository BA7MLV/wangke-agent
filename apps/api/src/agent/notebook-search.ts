import crypto from 'node:crypto';
import type { SystemDocument } from '@wangke/contracts/system';
import { budgeted, fitsResult, fittingPrefix, RESULT_TOKEN_DEFAULT, safeEnd } from './result-budget.js';
import { MEMORY_PATH } from '@wangke/contracts/system';

type SearchArgs = { path: string; query: string; mode?: 'literal' | 'relevant'; caseSensitive?: boolean; contextLines?: number; offset?: number; cursor?: string; limit?: number; maxTokens?: number };
type Hit = { path: string; revision: number; status?: string; scope?: string; scopeId?: string; line: number; startLine: number; endLine: number; column: number; matchColumn: number; text: string; score: number; moreInFile: boolean };
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'is', 'what', 'how', '我', '的', '了', '是', '怎么', '什么', '今天', '一下', '关于']);

function terms(query: string) {
  const values = new Set<string>();
  for (const word of query.match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) ?? []) {
    if (stopWords.has(word)) continue;
    if (/^\p{Script=Han}+$/u.test(word) && [...word].length > 2) {
      const chars = [...word];
      for (let i = 0; i + 1 < chars.length; i++) if (!stopWords.has(chars[i] + chars[i + 1])) values.add(chars[i] + chars[i + 1]);
    } else values.add(word);
  }
  return [...values].slice(0, 64);
}

/** Lowercasing can expand a character (e.g. İ); cite original UTF-16 columns. */
function originalColumn(text: string, normalized: string, at: number) {
  if (text.length === normalized.length) return safeEnd(text, at);
  let original = 0, folded = 0;
  for (const char of text) {
    const length = char.toLowerCase().length;
    if (folded + length > at) return original;
    folded += length; original += char.length;
  }
  return original;
}

/** Local lexical retrieval: exact phrase + term coverage, section/path boosts, no model calls. */
export function notebookSearch(owner: string, documents: SystemDocument[], args: SearchArgs) {
  const maxTokens = args.maxTokens ?? RESULT_TOKEN_DEFAULT, mode = args.mode ?? 'literal';
  const normalize = (text: string) => args.caseSensitive ? text : text.toLowerCase();
  const query = normalize(mode === 'literal' ? args.query : args.query.trim());
  if (!query) throw new Error('invalid_search_query');
  const words = mode === 'relevant' ? terms(query) : [query];
  const fingerprint = digest([owner, args.path, query, mode, Boolean(args.caseSensitive), args.contextLines ?? 1, documents.map(d => [d.path, d.revision, d.status])]);
  let offset = args.offset ?? 0;
  if (args.cursor) {
    let cursor: { fingerprint: string; offset: number };
    try { cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')); } catch { throw new Error('invalid_search_cursor'); }
    if (!cursor || typeof cursor !== 'object' || typeof cursor.fingerprint !== 'string') throw new Error('invalid_search_cursor');
    if (cursor.fingerprint !== fingerprint) throw new Error('search_cursor_expired');
    offset = cursor.offset;
  }
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_search_cursor');
  const hits: Hit[] = [];
  let totalMatchedLines = 0;
  for (const document of documents) {
    const lines = document.content.split('\n');
    const ranked: Array<{ index: number; score: number; at: number }> = [];
    let heading = '';
    for (let i = 0; i < lines.length; i++) {
      const line = normalize(lines[i]);
      if (/^#{1,6}\s/.test(line)) heading = line;
      const phrase = line.indexOf(query), matching = words.filter(word => line.includes(word));
      if (phrase < 0 && (!matching.length || mode === 'literal')) continue;
      totalMatchedLines++;
      const score = mode === 'literal' ? 1 : (phrase >= 0 ? 30 : 0) + matching.length * 4 + words.filter(word => heading.includes(word)).length * 2 + words.filter(word => normalize(document.path).includes(word)).length;
      ranked.push({ index: i, score, at: originalColumn(lines[i], line, phrase >= 0 ? phrase : Math.min(...matching.map(word => line.indexOf(word)))) });
    }
    ranked.sort((a, b) => b.score - a.score || a.index - b.index);
    const selected: number[] = [], perFile = mode === 'literal' ? Infinity : args.path === MEMORY_PATH ? 3 : 50;
    for (const candidate of ranked) {
      // Suppress a matching line only when an existing excerpt actually shows
      // it. Merely overlapping context must not hide a nearby relevant fact.
      if (mode === 'relevant' && selected.some(index => Math.abs(index - candidate.index) <= (args.contextLines ?? 1))) continue;
      if (selected.length === perFile) break;
      selected.push(candidate.index);
      const start = Math.max(0, candidate.index - (args.contextLines ?? 1)), end = Math.min(lines.length, candidate.index + (args.contextLines ?? 1) + 1);
      let column = Math.max(0, candidate.at - 100);
      column = safeEnd(lines[candidate.index], column);
      const text = lines.slice(start, end).map((line, n) => {
        const from = start + n === candidate.index ? column : 0;
        const until = start + n === candidate.index ? Math.max(from + 350, candidate.at + query.length) : from + 350;
        return `${start + n + 1}: ${from ? '…' : ''}${line.slice(from, safeEnd(line, until))}${line.length > until ? '…' : ''}`;
      }).join('\n');
      hits.push({ path: document.path, revision: document.revision, status: document.status, scope: document.scope, scopeId: document.scopeId, line: candidate.index + 1, startLine: start + 1, endLine: end, column, matchColumn: candidate.at, text, score: candidate.score, moreInFile: ranked.length > perFile });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  const page: Hit[] = [];
  const build = () => {
    const next = offset + page.length < hits.length ? offset + page.length : null;
    return { hits: page, mode, literal: mode === 'literal', totalMatchedLines, totalFragments: hits.length,
      nextOffset: next, nextCursor: next === null ? null : Buffer.from(JSON.stringify({ fingerprint, offset: next })).toString('base64url'),
      truncated: next !== null || page.some(hit => hit.moreInFile), note: 'Excerpts only; read path with revision for full evidence. Cursors expire after source edits/deletions.' };
  };
  for (const hit of hits.slice(offset, offset + (args.limit ?? 8))) {
    page.push(hit);
    if (fitsResult(build(), maxTokens)) continue;
    if (page.length > 1) { page.pop(); break; }
    // Context is optional, but the matching line and its actual match location are not.
    const line = documents.find(d => d.path === hit.path)!.content.split('\n')[hit.line - 1];
    const normalized = normalize(line), phrase = normalized.indexOf(query);
    const matching = words.filter(word => normalized.includes(word));
    const match = phrase >= 0 ? query : matching.reduce((best, word) => normalized.indexOf(word) < normalized.indexOf(best) ? word : best);
    const at = hit.matchColumn;
    const shortened = { ...hit, column: at, text: '', startLine: hit.line, endLine: hit.line };
    page[page.length - 1] = shortened;
    const prefix = fittingPrefix(line.slice(at, safeEnd(line, at + Math.max(350, match.length))), part => { shortened.text = `${hit.line}: ${part}…`; return fitsResult(build(), maxTokens); });
    shortened.text = `${hit.line}: ${prefix}…`;
    if (normalize(prefix).includes(match) && fitsResult(build(), maxTokens)) break;
    page.pop(); break;
  }
  const result = budgeted(build(), maxTokens);
  if (result.budget.estimatedTokens > maxTokens || !page.length && offset < hits.length) throw new Error('result_budget_too_small');
  return result;
}
