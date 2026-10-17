/** Persistent references, never blob URLs or model-authored filesystem paths. */
export interface MaterialImageRef { courseId: string; key: string }
export const materialImageHref = (courseId: string, key: string) =>
  `#source-image/${encodeURIComponent(courseId)}/${key}`;

export function parseMaterialImageHref(value: unknown): MaterialImageRef | undefined {
  if (typeof value !== 'string') return;
  const m = /^#source-image\/([^/]+)\/((?:page-[1-9]\d*|image-[1-9]\d*(?:-[a-f0-9]{16})?))$/.exec(value);
  if (!m) return;
  try {
    const courseId = decodeURIComponent(m[1]);
    if (!courseId || !Number.isSafeInteger(Number(m[2].split('-')[1]))) return;
    return { courseId, key: m[2] };
  } catch { return; }
}

/** Only raster data URLs and explicit HTTP(S) URLs. No local paths, SVG or blob lifetimes. */
export function imageSourceKind(src: string): 'inline' | 'remote' | 'unavailable' {
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(src)) return 'inline';
  try {
    const url = new URL(src);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return 'remote';
  } catch { /* Relative paths have no base in a single imported file. */ }
  return 'unavailable';
}

export function materialSourceHref(courseId: string, unit?: number): string {
  return `#/player/${encodeURIComponent(courseId)}${unit ? `?unit=${unit}` : ''}`;
}
