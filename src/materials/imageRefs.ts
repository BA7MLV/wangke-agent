/** Persistent references, never blob URLs or model-authored filesystem paths. */
export interface PdfRegion { x: number; y: number; width: number; height: number }
export interface MaterialImageRef { courseId: string; key: string; region?: PdfRegion }
/** Coordinates are thousandths of the rotated page, from the top left. */
export function validPdfRegion(r: unknown): r is PdfRegion {
  if (!r || typeof r !== 'object') return false;
  const { x, y, width, height } = r as PdfRegion;
  return [x, y, width, height].every(Number.isSafeInteger) && x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1000 && y + height <= 1000;
}
export const pdfRegionKey = (page: number, r: PdfRegion) => `page-${page}-region-${r.x}-${r.y}-${r.width}-${r.height}`;
export const materialImageHref = (courseId: string, key: string) =>
  `#source-image/${encodeURIComponent(courseId)}/${key}`;
/** Millisecond timestamps survive frame row replacement and keep the source course explicit. */
export const videoFrameKey = (ts: number) => `frame-${Math.round(ts * 1000)}`;

export function parseMaterialImageHref(value: unknown): MaterialImageRef | undefined {
  if (typeof value !== 'string') return;
  const m = /^#source-image\/([^/]+)\/((?:page-[1-9]\d*(?:-region-\d+-\d+-\d+-\d+)?|image-[1-9]\d*(?:-[a-f0-9]{16})?|frame-(?:0|[1-9]\d*)))$/.exec(value);
  if (!m) return;
  try {
    const courseId = decodeURIComponent(m[1]);
    if (!courseId || !Number.isSafeInteger(Number(m[2].split('-')[1]))) return;
    const crop = /-region-(\d+)-(\d+)-(\d+)-(\d+)$/.exec(m[2]);
    const region = crop ? { x: Number(crop[1]), y: Number(crop[2]), width: Number(crop[3]), height: Number(crop[4]) } : undefined;
    if (crop && !validPdfRegion(region)) return;
    return { courseId, key: m[2], ...(region ? { region } : {}) };
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
