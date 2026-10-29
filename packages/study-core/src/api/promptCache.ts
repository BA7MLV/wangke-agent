import type { ApiProtocol } from './modelTypes.ts';

export type CachePolicy = 'none' | 'anthropic' | 'openai' | 'openai-explicit';
type Target = { baseUrl?: string; protocol?: ApiProtocol; model: string };
/** A model's name/catalog is not evidence that an arbitrary gateway accepts
 * vendor fields. Only audited endpoint + protocol + model combinations opt in. */
export function cachePolicy(target: Target): CachePolicy {
  let host = '';
  try { const url = new URL(target.baseUrl ?? ''); if (url.protocol === 'https:') host = url.hostname; } catch { /* unknown route */ }
  if (host === 'api.anthropic.com' && target.protocol === 'anthropic-messages' && /^claude-(?:3[.-]|(?:sonnet|opus|haiku)-4(?:[.-]|$))/.test(target.model)) return 'anthropic';
  if (host === 'api.openai.com' && (target.protocol === 'openai-chat' || target.protocol === 'openai-responses') && /^(?:gpt-(?:4o|4\.1|5(?:\.[0-6])?|6\.1)(?:-|$)|o[134](?:-|$))/.test(target.model)) {
    return /^gpt-(?:5\.6|6\.1)(?:-|$)/.test(target.model) ? 'openai-explicit' : 'openai';
  }
  return 'none';
}

/** Canonicalize schemas, not message text or tool arguments. Arrays retain their
 * semantics; tools have a deterministic name order independent of discovery. */
export function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonical) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) as T;
}
export function stableTools<T extends { function: { name: string } }>(tools: readonly T[]): T[] {
  return [...tools].sort((a, b) => a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0).map(canonical);
}

export function applyPromptCache(body: Record<string, unknown>, target: Target, key?: string): Record<string, unknown> {
  const policy = cachePolicy(target);
  if (policy === 'none') return body;
  const result = { ...body };
  if (policy === 'anthropic') {
    const blocks = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : Array.isArray(body.system) ? body.system : [];
    // Two reusable system boundaries plus the automatically advancing tail.
    result.system = blocks.map((b, i) => i === 0 || i === blocks.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b);
    result.cache_control = { type: 'ephemeral' };
    return result;
  }
  if (key) result.prompt_cache_key = key;
  if (body.stream && target.protocol !== 'openai-responses') result.stream_options = { ...(body.stream_options as object), include_usage: true };
  if (policy === 'openai-explicit') {
    result.prompt_cache_options = { mode: 'implicit' };
    const field = target.protocol === 'openai-responses' ? 'input' : 'messages';
    if (!Array.isArray(body[field])) return result;
    let marked = 0;
    result[field] = (body[field] as Array<Record<string, unknown>>).map(m => {
      if (m.role !== 'system' || marked++ >= 2 || typeof m.content !== 'string') return m;
      return { ...m, content: [{ type: target.protocol === 'openai-responses' ? 'input_text' : 'text', text: m.content, prompt_cache_breakpoint: { mode: 'explicit' } }] };
    });
  }
  return result;
}
