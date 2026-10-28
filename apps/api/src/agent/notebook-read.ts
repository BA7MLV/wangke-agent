import type { SystemDocument } from '@wangke/contracts/system';
import { budgeted, fitsResult, fittingPrefix, RESULT_TOKEN_DEFAULT, safeEnd } from './result-budget.js';

export function notebookRead(document: SystemDocument, args: { offset?: number; column?: number; limit?: number; revision?: number; maxTokens?: number }) {
  if (args.revision !== undefined && document.revision !== args.revision) throw new Error('system_revision_conflict');
  const lines = document.content.split('\n'), start = args.offset ?? 0, column = args.column ?? 0;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(column) || column < 0 || column > (lines[start]?.length ?? 0) || safeEnd(lines[start] ?? '', column) !== column) throw new Error('invalid_result_offset');
  const maxTokens = args.maxTokens ?? RESULT_TOKEN_DEFAULT, time = new Date().toISOString();
  const selected: Array<{ line: number; column: number; text: string; endColumn: number }> = [];
  let nextLine = Math.min(start, lines.length), nextColumn = column;
  const build = () => ({ path: document.path, revision: document.revision, kind: document.kind, status: document.status, scope: document.scope, scopeId: document.scopeId, source: document.source,
    lines: selected, totalLines: lines.length, currentTime: time,
    nextOffset: nextLine < lines.length ? nextLine : null, nextColumn: nextLine < lines.length ? nextColumn : null,
    next: nextLine < lines.length ? { offset: nextLine, column: nextColumn, revision: document.revision } : null,
    truncated: nextLine < lines.length });
  const end = Math.min(lines.length, start + (args.limit ?? 50));
  for (let i = start; i < end; i++) {
    const from = i === start ? column : 0, text = lines[i].slice(from);
    const item = { line: i + 1, column: from, text, endColumn: lines[i].length };
    selected.push(item); nextLine = i + 1; nextColumn = 0;
    if (fitsResult(build(), maxTokens)) continue;
    nextLine = i; nextColumn = from;
    const prefix = fittingPrefix(text, part => {
      item.text = part; item.endColumn = from + part.length; nextColumn = item.endColumn;
      return fitsResult(build(), maxTokens);
    });
    item.text = prefix; item.endColumn = from + prefix.length; nextColumn = item.endColumn;
    if (!prefix) { selected.pop(); nextColumn = from; }
    break;
  }
  const result = budgeted(build(), maxTokens);
  if (result.budget.estimatedTokens > maxTokens || !selected.length && start < lines.length) throw new Error('result_budget_too_small');
  return result;
}
