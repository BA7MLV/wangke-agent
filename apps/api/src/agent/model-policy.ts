export type ModelRequestOptions = { attempts?: number; timeoutMs?: number; chainMs?: number };

function setting(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = value?.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** The chain covers every attempt and backoff, rather than silently capping a
 * longer per-attempt timeout at the old two-minute deadline. */
export function modelRequestPolicy(options: ModelRequestOptions = {}, env = process.env) {
  const timeoutMs = options.timeoutMs ?? setting(env.MODEL_TIMEOUT_MS, 120_000, 1000, 600_000);
  const attempts = options.attempts ?? setting(env.MODEL_MAX_RETRIES, 2, 0, 5) + 1;
  const chainMs = options.chainMs ?? setting(env.MODEL_CHAIN_TIMEOUT_MS, timeoutMs * attempts + 60_000, 1000, 3_660_000);
  if (![timeoutMs, attempts, chainMs].every(Number.isSafeInteger) || timeoutMs < 1 || timeoutMs > 600_000 || attempts < 1 || attempts > 6 || chainMs < 1 || chainMs > 3_660_000) throw new Error('invalid_model_request_policy');
  return { timeoutMs, attempts, chainMs };
}
