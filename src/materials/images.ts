import { db, type VideoRow } from '../store/db';
import { getMaterialFile } from '../store/fileStore';
import { imageSourceKind, materialImageHref, materialSourceHref } from './imageRefs';

export interface MaterialImage {
  key: string;
  label: string;
  unit?: number;
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

export async function loadMaterialImage(courseId: string, key: string): Promise<LoadedMaterialImage> {
  const course = await db.videos.get(courseId);
  if (!course || course.kind !== 'material') throw new Error('来源材料已删除或不存在');
  const file = await getMaterialFile(courseId);
  if (!file) throw new Error('此设备没有材料原文件，请重新导入后重试');
  // PDF loads just the requested page, without listing or rendering the whole document.
  if ((course.materialFormat ?? 'pdf') === 'pdf') {
    if (!/^page-[1-9]\d*$/.test(key)) throw new Error('无效的 PDF 图片引用');
    const unit = Number(key.slice(5));
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
          const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('页面图片生成失败')), 'image/png'));
          return { blob, image: { key, label: `第 ${unit} 页原文画面`, unit }, courseName: course.name };
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
