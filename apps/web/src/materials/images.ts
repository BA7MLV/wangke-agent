import { db, type VideoRow } from '../store/db';
import { getMaterialFile } from '../store/fileStore';
import { imageSourceKind, materialImageHref, materialSourceHref, parseMaterialImageHref, pdfRegionKey, validPdfRegion, videoFrameKey, type PdfRegion } from './imageRefs';

export interface MaterialImage {
  key: string;
  label: string;
  unit?: number;
  /** Video time, not a material page/paragraph anchor. */
  ts?: number;
  src?: string;
  /** Word ZIP entry, resolved only when needed. */
  entry?: string;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const RASTER_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
};
const xmlAttrs = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w:]+)\s*=\s*["']([^"']*)["']/g)].map((m) => [m[1], m[2]]));

async function fingerprint(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function versionSources(images: MaterialImage[]): Promise<MaterialImage[]> {
  return Promise.all(images.map(async (image) => ({ ...image, key: `${image.key}-${await fingerprint(new TextEncoder().encode(image.src ?? ''))}` })));
}

/** Metadata only: don't inflate every image in a large Word file just to list it. */
export async function docxImages(blob: Blob): Promise<MaterialImage[]> {
  const [{ unzipSync }, { extractDocxUnitsFromXml, decodeXmlEntities }] = await Promise.all([
    import('fflate'), import('./docx'),
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const revision = await fingerprint(bytes);
  const files = unzipSync(bytes, {
    filter: (f) => ['word/document.xml', 'word/_rels/document.xml.rels'].includes(f.name) && f.originalSize <= MAX_IMAGE_BYTES,
  });
  const decode = (name: string) => new TextDecoder().decode(files[name] ?? new Uint8Array());
  const rels = new Map<string, string>();
  for (const tag of decode('word/_rels/document.xml.rels').matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const a = xmlAttrs(tag[0]);
    if (a.TargetMode === 'External' || !a.Type?.endsWith('/image') || !a.Target) continue;
    const target = decodeXmlEntities(a.Target);
    const parts: string[] = target.startsWith('/') ? [] : ['word'];
    for (const part of target.split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    const entry = parts.join('/');
    if (entry.startsWith('word/media/') && RASTER_MIME[entry.split('.').pop()!.toLowerCase()]) rels.set(a.Id, entry);
  }
  const images: MaterialImage[] = [];
  let unit = 0;
  const xml = decode('word/document.xml');
  const body = /<w:body(?:\s[^>]*)?>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  for (const match of body.matchAll(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const block = match[0];
    const hasText = extractDocxUnitsFromXml(block).length > 0;
    if (hasText) unit++;
    for (const tag of block.matchAll(/<(?:a:blip|v:imagedata)\b[^>]*>/g)) {
      const a = xmlAttrs(tag[0]);
      const entry = rels.get(a['r:embed'] ?? a['r:id']);
      if (!entry) continue;
      const index = images.length + 1;
      images.push({ key: `image-${index}-${revision}`, label: `原图 ${index}`, entry, ...(hasText ? { unit } : {}) });
    }
  }
  return images;
}

async function markdownImages(src: string): Promise<MaterialImage[]> {
  const [{ marked, Lexer }, { extractMdUnits }] = await Promise.all([import('marked'), import('./md')]);
  const links = marked.lexer(src).links;
  const images: MaterialImage[] = [];
  for (const u of extractMdUnits(src)) {
    const lexer = new Lexer();
    lexer.tokens.links = links;
    marked.walkTokens(lexer.lex(u.text), (t) => {
      if (t.type === 'image') images.push({ key: `image-${images.length + 1}`, label: t.text || `原图 ${images.length + 1}`, src: t.href, unit: u.unit });
    });
  }
  return versionSources(images);
}

export async function listMaterialImages(course: VideoRow, blob: Blob): Promise<MaterialImage[]> {
  const format = course.materialFormat ?? 'pdf';
  if (format === 'pdf') {
    // Read the real page count; stale import metadata must not create dead references.
    const { openPdf } = await import('./pdf');
    const url = URL.createObjectURL(blob);
    try {
      const doc = await openPdf(url);
      try { return Array.from({ length: doc.numPages }, (_, i) => ({ key: `page-${i + 1}`, label: `第 ${i + 1} 页原文画面`, unit: i + 1 })); }
      finally { await doc.destroy(); }
    } finally { URL.revokeObjectURL(url); }
  }
  if (format === 'docx') return docxImages(blob);
  if (format === 'md') return markdownImages(await blob.text());
  const { extractHtmlImageSources } = await import('./html');
  return versionSources(extractHtmlImageSources(await blob.text()).map((image, i) => ({ ...image, key: `image-${i + 1}` })));
}

export async function readMaterialImageCatalog(course: VideoRow, offset = 0, limit = 12, range?: { start: number; end: number }): Promise<string> {
  if (course.kind !== 'material') return '此课程不是阅读材料。视频画面请 read 对应的 frames 资源。';
  const blob = await getMaterialFile(course.id);
  if (!blob) return '材料原文件已删除或不在此设备上，无法显示原图。请重新导入原文件。';
  const all = await listMaterialImages(course, blob);
  const images = range ? all.filter((i) => i.unit !== undefined && i.unit >= range.start && i.unit <= range.end) : all;
  const page = images.slice(offset, offset + Math.min(50, limit));
  const lines = [
    `path=/courses/${encodeURIComponent(course.id)}/images`,
    `共 ${images.length} 张${course.materialFormat === 'pdf' || !course.materialFormat ? '页面图（整页，不是单独裁出的插图）' : '图片'}。此目录只提供引用与位置，不代表你已经看过图片像素；不能据此臆测图像内容。`,
    '向用户展示时原样复制 Markdown 图片或链接；不要输出 base64、blob URL 或编造图片编号。',
    ...page.map((i) => {
      const label = i.label.replace(/[\[\]\\\r\n]/g, ' ').slice(0, 100);
      const href = materialImageHref(course.id, i.key);
      const availability = i.src ? imageSourceKind(i.src) : 'inline';
      return `${i.key}${i.unit ? ` · 第 ${i.unit} ${course.materialFormat === 'pdf' || !course.materialFormat ? '页' : '段'}` : ' · 无段落锚点'}\n${availability === 'unavailable' ? '图片地址是无法解析的相对路径或不支持的格式；只能打开原文，不要嵌图。' : `展示：![${label}](${href})\n查看链接：[${label}](${href})${availability === 'remote' ? '（外链图，由用户点击同意后加载）' : ''}`}\n来源：[打开原文](${materialSourceHref(course.id, i.unit)})`;
    }),
  ];
  if (offset + page.length < images.length) lines.push(`继续 read 此路径，offset=${offset + page.length}，limit=${limit}；保留相同 range。`);
  if (!images.length) lines.push('此范围没有可展示图片。可去掉 range 查看全文图片目录，或提供原文定位链接。');
  return lines.join('\n');
}

export interface LoadedMaterialImage { blob?: Blob; remoteUrl?: string; image: MaterialImage; courseName: string }

/** Return deterministic region references, not new blobs/rows. Reloading crops the original PDF again. */
export async function readPdfQuestionCrops(course: VideoRow, range: { start: number; end: number } | undefined, rawRegions?: unknown): Promise<string> {
  if ((course.materialFormat ?? 'pdf') !== 'pdf') return '自动裁题只用于 PDF；其他材料请使用原图目录。';
  if (!range || range.end - range.start > 2) return '裁题请同时提供 start/end，一次 1~3 页。';
  let regions: (PdfRegion & { page: number })[] | undefined;
  if (rawRegions !== undefined) {
    if (!Array.isArray(rawRegions) || !rawRegions.length || rawRegions.length > 10 || rawRegions.some((r) => !Number.isSafeInteger(r?.page) || r.page < range.start || r.page > range.end || !validPdfRegion(r)))
      return 'regions 需要 1~10 个 {page,x,y,width,height}：坐标为旋转后页面左上角起的千分比整数，宽高大于 0，不能越界，page 位于 start/end 内。';
    regions = rawRegions;
  }
  const file = await getMaterialFile(course.id);
  if (!file) return '材料原文件不在此设备上，无法裁题。';
  const [{ openPdf }, { detectQuestionRegions }] = await Promise.all([import('./pdf'), import('./pdfQuestionRegions')]);
  const url = URL.createObjectURL(file);
  try {
    const doc = await openPdf(url);
    try {
      if (range.end > doc.numPages) return '裁题页码超过 PDF 实际页数。';
      const lines = ['PDF 原页裁图（非 AI 重绘）。自动区域按题号和文字坐标估计，尚未视觉核验；共用材料、跨页题须同时保留相关页面，不能声称裁图完整。目录不代表已看过像素。'];
      for (let p = range.start; p <= range.end; p++) {
        const page = await doc.getPage(p);
        try {
          let found: { region: PdfRegion; label: string }[];
          if (regions) found = regions.filter((r) => r.page === p).map((r) => ({ region: r, label: '指定区域' }));
          else {
            const viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            const [a, b, c, d, e, f] = viewport.transform;
            found = detectQuestionRegions(content.items.flatMap((item) => {
              if (!('str' in item)) return [];
              const [ta, tb, , , tx, ty] = item.transform;
              const h = Math.max(1, Math.hypot(a * ta + c * tb, b * ta + d * tb));
              const x = a * tx + c * ty + e, y = b * tx + d * ty + f;
              // Rotated/vertical text needs visual region selection, not a guessed horizontal box.
              if (Math.abs(b * ta + d * tb) > Math.abs(a * ta + c * tb) * .2) return [];
              return [{ text: item.str, x, y: y - h, width: item.width, height: h }];
            }), viewport.width, viewport.height);
          }
          if (!found.length) lines.push(`第 ${p} 页未能可靠定位题号（可能是扫描件、复杂分栏或无题号）。使用页面图：![第 ${p} 页原文](${materialImageHref(course.id, `page-${p}`)})；可根据实际画面用 regions 修正，不能猜坐标。`);
          for (const crop of found) lines.push(`第 ${p} 页 · ${crop.label.replace(/[\[\]\\\r\n]/g, ' ')}\n区域：${JSON.stringify(crop.region)}\n![原题裁图](${materialImageHref(course.id, pdfRegionKey(p, crop.region))})\n[打开原页](${materialSourceHref(course.id, p)})`);
        } finally { page.cleanup(); }
      }
      return lines.join('\n\n');
    } finally { await doc.destroy(); }
  } finally { URL.revokeObjectURL(url); }
}

export async function loadMaterialImage(courseId: string, key: string): Promise<LoadedMaterialImage> {
  const course = await db.videos.get(courseId);
  if (key.startsWith('frame-')) {
    if (!parseMaterialImageHref(materialImageHref(courseId, key))) throw new Error('无效的视频画面引用');
    if (!course || course.kind === 'material') throw new Error('来源视频已删除或不存在');
    const frame = await db.frames.where('videoId').equals(courseId)
      .filter((r) => r.kind === 'slide' && videoFrameKey(r.ts) === key).first();
    if (!frame) throw new Error('已保存的课程画面不存在，请重新读取画面目录或打开来源视频');
    return { blob: frame.blob, image: { key, label: frame.caption || '课程画面', ts: frame.ts }, courseName: course.name };
  }
  if (!course || course.kind !== 'material') throw new Error('来源材料已删除或不存在');
  const file = await getMaterialFile(courseId);
  if (!file) throw new Error('此设备没有材料原文件，请重新导入后重试');
  // PDF loads just the requested page, without listing or rendering the whole document.
  if ((course.materialFormat ?? 'pdf') === 'pdf') {
    const ref = parseMaterialImageHref(materialImageHref(courseId, key));
    if (!ref || !key.startsWith('page-')) throw new Error('无效的 PDF 图片引用');
    const unit = Number(key.split('-')[1]);
    const { openPdf } = await import('./pdf');
    const url = URL.createObjectURL(file);
    try {
      const doc = await openPdf(url);
      try {
        if (unit > doc.numPages) throw new Error('引用的页面不存在');
        const page = await doc.getPage(unit);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 2000 / Math.max(base.width, base.height)) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        try {
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('无法创建图片画布');
          await page.render({ canvasContext: ctx, viewport }).promise;
          const region = ref.region;
          const output = region ? document.createElement('canvas') : canvas;
          try {
            if (region) {
              const x = Math.floor(region.x / 1000 * canvas.width), y = Math.floor(region.y / 1000 * canvas.height);
              output.width = Math.max(1, Math.ceil((region.x + region.width) / 1000 * canvas.width) - x);
              output.height = Math.max(1, Math.ceil((region.y + region.height) / 1000 * canvas.height) - y);
              const cropped = output.getContext('2d');
              if (!cropped) throw new Error('无法创建裁图画布');
              cropped.drawImage(canvas, x, y, output.width, output.height, 0, 0, output.width, output.height);
            }
            const blob = await new Promise<Blob>((resolve, reject) => output.toBlob((b) => b ? resolve(b) : reject(new Error('页面图片生成失败')), 'image/png'));
            return { blob, image: { key, label: `第 ${unit} 页${region ? '原题裁图' : '原文画面'}`, unit }, courseName: course.name };
          } finally { if (output !== canvas) output.width = output.height = 0; }
        } finally { canvas.width = canvas.height = 0; }
      } finally { await doc.destroy(); }
    } finally { URL.revokeObjectURL(url); }
  }
  const images = await listMaterialImages(course, file);
  const image = images.find((i) => i.key === key);
  if (!image) throw new Error('原图不存在，材料可能已修改，请让助手重新读取图片目录');
  if (image.entry) {
    const { unzipSync } = await import('fflate');
    const bytes = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => f.name === image.entry && f.originalSize <= MAX_IMAGE_BYTES })[image.entry];
    if (!bytes) throw new Error('原图缺失或超过 20 MB，无法预览');
    return { blob: new Blob([new Uint8Array(bytes)], { type: RASTER_MIME[image.entry.split('.').pop()!.toLowerCase()] }), image, courseName: course.name };
  }
  const kind = imageSourceKind(image.src ?? '');
  if (kind === 'remote') return { remoteUrl: image.src, image, courseName: course.name };
  if (kind !== 'inline') throw new Error('单文件导入无法访问相对路径图片，或该图片格式不支持');
  if (image.src!.length > MAX_IMAGE_BYTES * 1.4) throw new Error('图片超过 20 MB，无法预览');
  const blob = await (await fetch(image.src!)).blob();
  return { blob, image, courseName: course.name };
}
