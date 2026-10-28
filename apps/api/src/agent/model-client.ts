import { BudgetBlocked, type RequestAttribution, type UsageLedger } from './budget.js';
import { boundedRequest, checkRequestCapacity } from './request-budget.js';

type JsonObject = Record<string, unknown>;
const object = (v: unknown): JsonObject | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : undefined;
export function modelUsage(body: unknown) {
  const usage = object(object(body)?.usage);
  if (!usage) return undefined;
  let input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const cache = object(usage.prompt_tokens_details)?.cached_tokens ?? usage.cache_read_input_tokens;
  // Anthropic input_tokens excludes cache reads/writes. Account both at the
  // configured input price; the ledger estimates writes at 2x input price.
  if (usage.prompt_tokens === undefined && typeof input === 'number') {
    for (const key of ['cache_read_input_tokens', 'cache_creation_input_tokens']) {
      const count = usage[key];
      if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) return undefined;
      input += typeof count === 'number' ? count : 0;
    }
  }
  if (![input, output].every(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) return undefined;
  return { input: input as number, output: output as number, ...(typeof cache === 'number' && Number.isSafeInteger(cache) && cache >= 0 ? { cache } : {}), ...(typeof usage.cache_creation_input_tokens === 'number' ? { cacheCreation: usage.cache_creation_input_tokens } : {}) };
}
export function retryAfter(value: string | null, time = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - time;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
export class ModelFailure extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly delay?: number) { super(code); }
}
function classify(status: number, delay?: number) {
  if (status === 401 || status === 403) return new ModelFailure('model_auth_failed');
  if (status === 402) return new ModelFailure('model_quota_exhausted');
  if (status === 429) return new ModelFailure('model_rate_limited', true, delay);
  if (status >= 500) return new ModelFailure('model_server_error', true, delay);
  return new ModelFailure('model_invalid_request');
}
async function limitedJson(response: Response, limit = 8 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new ModelFailure('model_empty_response');
  const reader = response.body.getReader();
  let text = '', bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw new ModelFailure('model_response_too_large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw new ModelFailure('model_invalid_json'); }
  } finally { await reader.cancel().catch(() => {}); }
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
async function sleep(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** Each retry is a distinct physical request. Unknown network usage keeps its
 * reservation; model retries never replay a tool or commit a late response. */
export class ModelClient {
  constructor(readonly ledger: UsageLedger, readonly fetcher: typeof fetch = fetch) {}
  async request(url: string, init: RequestInit, attribution: RequestAttribution, reserveTokens: number, options: { attempts?: number; timeoutMs?: number; chainMs?: number } = {}): Promise<unknown> {
    if (typeof init.body === 'string') {
      const payload: unknown = JSON.parse(init.body);
      if (!object(payload)) throw new Error('invalid_model_body');
      const model = this.ledger.model(attribution.owner, { providerId: attribution.provider, model: attribution.model });
      const request = boundedRequest(payload as JsonObject, url, model.outputTokens);
      checkRequestCapacity(request.total, Math.min(model.contextTokens, this.ledger.limits(attribution.owner, attribution.run).contextTokens));
      reserveTokens = request.total;
      init = { ...init, body: JSON.stringify(request.body) };
    }
    const signal = AbortSignal.any([init.signal ?? new AbortController().signal, AbortSignal.timeout(options.chainMs ?? 120000)]);
    for (let attempt = 1; attempt <= (options.attempts ?? 3); attempt++) {
      signal.throwIfAborted();
      const id = this.ledger.reserve(attribution, attempt, reserveTokens);
      let failure: ModelFailure;
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 30000)]);
        const response = await abortable(this.fetcher(url, { ...init, redirect: 'error', signal: requestSignal }), requestSignal);
        requestSignal.throwIfAborted();
        if (!response.ok) {
          if (response.status === 429) {
            let errorBody: unknown;
            try { errorBody = await abortable(limitedJson(response, 65536), requestSignal); } catch { /* classify status without echoing body */ }
            const code = object(object(errorBody)?.error)?.code;
            if (['insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_too_low'].includes(String(code))) throw new ModelFailure('model_quota_exhausted');
          } else await response.body?.cancel();
          throw classify(response.status, retryAfter(response.headers.get('retry-after')));
        }
        const body = await abortable(limitedJson(response), requestSignal);
        requestSignal.throwIfAborted();
        if (this.ledger.settle(id, 'completed', modelUsage(body))) throw new BudgetBlocked('model_usage_exceeded_reservation');
        this.ledger.checkAdmission(attribution);
        return body;
      } catch (error) {
        this.ledger.settle(id, signal.aborted ? 'cancelled' : error instanceof ModelFailure ? error.code : 'network_unknown');
        signal.throwIfAborted();
        if (error instanceof BudgetBlocked) throw error;
        this.ledger.checkAdmission(attribution);
        failure = error instanceof ModelFailure ? error : new ModelFailure('model_connection_failed', true);
      }
      if (!failure.retryable) throw failure;
      if (attempt === (options.attempts ?? 3)) throw new ModelFailure('model_request_failed');
      await sleep(failure.delay ?? Math.round(500 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5)), signal);
    }
    throw new ModelFailure('model_request_failed');
  }
}
