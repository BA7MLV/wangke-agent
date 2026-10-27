import { BudgetBlocked } from './budget.js';

/** Estimated, not a provider tokenizer. UTF-8 bytes upper-bound byte-fallback
 * text tokens; include the entire serialized wire envelope plus 10%/1024
 * protocol headroom. Never estimate JS UTF-16 characters as half a token. */
export function textTokens(value: unknown) { return Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') * 1.1) + 1024; }
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v);

function dimensions(bytes: Buffer): [number, number] | undefined {
  if (bytes.length >= 24 && bytes.toString('ascii', 1, 4) === 'PNG') return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'GIF') return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
  if (bytes.length >= 30 && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (kind === 'VP8 ') return [bytes.readUInt16LE(26) & 16383, bytes.readUInt16LE(28) & 16383];
    if (kind === 'VP8L') { const n = bytes.readUInt32LE(21); return [(n & 16383) + 1, ((n >>> 14) & 16383) + 1]; }
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let i = 2; i + 8 < bytes.length;) {
      if (bytes[i++] !== 255) return;
      const marker = bytes[i++];
      if (marker === 216 || marker === 217) continue;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) return;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) return [bytes.readUInt16BE(i + 5), bytes.readUInt16BE(i + 3)];
      i += length;
    }
  }
}

export function boundedRequest(payload: ObjectValue, endpoint: string, defaultOutput = 4096) {
  endpoint = endpoint.split('?')[0].replace(/\/$/, '');
  const body = structuredClone(payload);
  const completionLimit = Object.hasOwn(body, 'max_completion_tokens');
  const requested = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens ?? defaultOutput;
  if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 1) throw new Error('invalid_model_output_limit');
  const output = Math.min(requested, defaultOutput);
  delete body.max_output_tokens; delete body.max_completion_tokens; delete body.max_tokens;
  if (endpoint.endsWith('responses')) body.max_output_tokens = output;
  else if (endpoint.endsWith('messages')) body.max_tokens = output;
  else if (completionLimit || /^(o[134](?:-|$)|gpt-5)/.test(String(body.model))) body.max_completion_tokens = output;
  else body.max_tokens = output;
  let images = 0;
  const image = (data: unknown) => {
    if (typeof data !== 'string' || data.length > 28 * 1024 * 1024) throw new Error('unsupported_budgeted_image');
    const bytes = Buffer.from(data, 'base64'), size = dimensions(bytes);
    // No unbounded remote URLs, video/audio or huge decompression dimensions.
    // 16384/image is a deliberately high policy envelope for <=2048² raster
    // images, not base64 text tokens. Unknown vendor billing can still exceed
    // it: settlement detects this and stops subsequent execution.
    if (!size || size.some(n => n < 1 || n > 2048) || ++images > 4) throw new Error('unsupported_budgeted_image');
    return '[bounded raster image]';
  };
  const estimateView = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(estimateView);
    if (!object(value)) return value;
    if (['audio', 'input_audio', 'video', 'input_video', 'document'].includes(String(value.type))) throw new Error('unsupported_budgeted_modality');
    if (value.type === 'image' && object(value.source)) {
      if (value.source.type !== 'base64') throw new Error('unsupported_budgeted_image');
      return { ...value, source: { ...value.source, data: image(value.source.data) } };
    }
    if (['image_url', 'input_image'].includes(String(value.type))) {
      const url = object(value.image_url) ? value.image_url.url : value.image_url;
      if (typeof url !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(url)) throw new Error('unsupported_budgeted_image');
      // Force low-detail OpenAI image processing in the transmitted payload.
      if (object(value.image_url)) value.image_url.detail = 'low'; else value.detail = 'low';
      return { ...value, image_url: image(url.slice(url.indexOf(',') + 1)) };
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, estimateView(v)]));
  };
  const view = estimateView(body);
  const input = textTokens(view) + images * 16384;
  return { body, input, output, total: input + output, estimated: true as const };
}
export function checkRequestCapacity(total: number, capacity: number) { if (total > capacity) throw new BudgetBlocked('context_capacity_exceeded'); }
