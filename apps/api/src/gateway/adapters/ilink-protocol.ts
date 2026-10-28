import { isLosslessNumber, parse } from 'lossless-json';

const ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);

/**
 * Tencent's client preserves these uint64 identifiers before conversion to Number.
 * Use a JSON parser, not a regexp over the response: quoted user text is not syntax.
 * Reference: Tencent/openclaw-weixin@874637a, src/api/api.ts parseWeixinApiJson.
 */
export function parseIlinkJson(text: string): any {
  return parse(text, (key, value) => {
    if (!isLosslessNumber(value)) return value;
    if (ID_FIELDS.has(key)) {
      if (!/^(0|[1-9]\d*)$/.test(value.value) || value.value.length > 20 || BigInt(value.value) > 18446744073709551615n) throw new Error('invalid_platform_message');
      return value.value;
    }
    const number = Number(value.value);
    if (!Number.isFinite(number)) throw new Error('invalid_platform_response');
    return number;
  });
}

/** HTTP Retry-After supports both delta-seconds and an HTTP date. */
export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value?.trim()) return 2000;
  const text = value.trim();
  const ms = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000
    : /^[A-Za-z]{3},/.test(text) ? Date.parse(text) - now : NaN;
  // Node timers cannot represent delays beyond a signed int32.
  return Number.isFinite(ms) ? Math.min(2147483647, Math.max(0, ms)) : 2000;
}

/** Equal jitter prevents synchronized retries while keeping a nonzero delay. */
export function ilinkBackoffMs(failures: number, retryAfter = 0, random = Math.random): number {
  const cap = Math.min(60_000, 1000 * 2 ** Math.min(Math.max(0, failures - 1), 6));
  return Math.max(retryAfter, Math.round(cap * (0.5 + random() * 0.5)));
}
