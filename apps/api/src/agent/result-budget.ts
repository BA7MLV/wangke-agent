import { textTokens } from './request-budget.js';

export const RESULT_TOKEN_DEFAULT = 4096;
export const resultBudgetSchema = { type: 'integer', minimum: 2048, maximum: 8192 };

/** Conservative UTF-8 wire estimate, including JSON/metadata; not a vendor tokenizer. */
export function budgeted<T extends object>(value: T, maxTokens = RESULT_TOKEN_DEFAULT) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 2048 || maxTokens > 8192) throw new Error('invalid_result_budget');
  let result = { ...value, budget: { maxTokens, estimatedTokens: 0, estimated: true } };
  for (let i = 0; i < 5; i++) {
    const tokens = textTokens(result);
    if (tokens === result.budget.estimatedTokens) break;
    result = { ...result, budget: { ...result.budget, estimatedTokens: tokens } };
  }
  return result;
}
export const fitsResult = (value: object, maxTokens: number) => budgeted(value, maxTokens).budget.estimatedTokens <= maxTokens;

/** Never split UTF-16 surrogate pairs; continuation offsets are UTF-16 columns. */
export function safeEnd(text: string, end: number) {
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) return end - 1;
  return end;
}
export function fittingPrefix(text: string, accepts: (prefix: string) => boolean) {
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (accepts(text.slice(0, safeEnd(text, middle)))) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, safeEnd(text, low));
}

export function boundedText<T extends object>(metadata: T, text: string, offset = 0, maxTokens = RESULT_TOKEN_DEFAULT, length = text.length) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || safeEnd(text, offset) !== offset) throw new Error('invalid_result_offset');
  const build = (part: string) => ({ ...metadata, text: part, offset, nextOffset: offset + part.length < text.length ? offset + part.length : null, totalChars: text.length, truncated: offset + part.length < text.length });
  const part = fittingPrefix(text.slice(offset, safeEnd(text, offset + length)), prefix => fitsResult(build(prefix), maxTokens));
  const result = budgeted(build(part), maxTokens);
  if (result.budget.estimatedTokens > maxTokens || !part && offset < text.length) throw new Error('result_budget_too_small');
  return result;
}
