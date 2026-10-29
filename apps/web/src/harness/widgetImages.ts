import { MAX_WIDGET_IMAGES } from './widget';
import { parseMaterialImageHref } from '../materials/imageRefs';

export interface WidgetImageResult { ref: string; data?: string; error?: string }
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** Only declarations in the original source are resolved. The iframe cannot request
 * arbitrary materials, URLs or files. Same references as Markdown's MaterialImage.
 * A template is inert, unlike a detached DOMParser document which may load images.
 */
export function widgetImageReferences(html: string): string[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  return [...new Set(Array.from(template.content.querySelectorAll('img[data-wbw-image]'), image => image.getAttribute('data-wbw-image')!))]
    .filter(ref => !!parseMaterialImageHref(ref)).slice(0, MAX_WIDGET_IMAGES);
}

/** Bounded local-only decoding, with two workers per preview and no global blob cache. */
export async function loadWidgetImages(refs: readonly string[], receive: (result: WidgetImageResult) => void, signal: AbortSignal): Promise<void> {
  let index = 0, total = 0;
  async function worker() {
    while (!signal.aborted && index < Math.min(refs.length, MAX_WIDGET_IMAGES)) {
      const href = refs[index++], ref = parseMaterialImageHref(href);
      if (!ref) continue;
      try {
        const { loadMaterialImage } = await import('../materials/images');
        if (signal.aborted) return;
        const result = await loadMaterialImage(ref.courseId, ref.key);
        if (signal.aborted) return;
        const blob = result.blob;
        if (!blob) throw new Error('此原图是外链，请在材料中查看或导入图片后重试');
        if (!/^image\/(?:png|jpeg|gif|webp|avif|bmp)$/i.test(blob.type)) throw new Error('此原图格式不支持，请使用 PNG、JPEG 或 WebP');
        if (blob.size > MAX_IMAGE_BYTES || total + blob.size > MAX_TOTAL_BYTES) throw new Error('图片过大，请裁剪原图或拆分作品后重试');
        total += blob.size;
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          const abort = () => reader.abort();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('原图读取失败'));
          reader.onabort = () => reject(new Error('原图读取已取消'));
          reader.onloadend = () => signal.removeEventListener('abort', abort);
          signal.addEventListener('abort', abort, { once: true });
          reader.readAsDataURL(blob);
        });
        if (!signal.aborted) receive({ ref: href, data });
      } catch (error) {
        if (!signal.aborted) receive({ ref: href, error: error instanceof Error ? error.message.slice(0, 200) : '原图读取失败' });
      }
    }
  }
  await Promise.all([worker(), worker()]);
}
