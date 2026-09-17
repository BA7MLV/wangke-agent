/**
 * PDF 模块：pdf.js 封装。
 *
 * ## 版本为什么锁 4.10.38（不要随手升）
 *
 * pdf.js 新版大量使用**无守卫**的新 API，在旧 Safari 上是直接 `TypeError`，不是优雅降级。
 * 实测（下载各版本 build/pdf.mjs 后 grep 是否带 typeof 守卫/polyfill）：
 *
 * | 版本 | 无守卫的新 API | 浏览器地板 |
 * |---|---|---|
 * | **4.10.38** | 仅 `Promise.withResolvers` | **Safari 17.4** |
 * | 5.4.624 | +`Promise.try`、`Uint8Array.fromBase64` | Safari 18.2 |
 * | 6.3.289 | +`Math.sumPrecise`（ES2026，Safari 26.2 才落地） | iOS 26.2 |
 *
 * 这个应用是装到主屏幕的 PWA，「用户不升级 iOS 就永久打不开材料」不可接受。
 * 4.10.38 是唯一自带 `Promise.try` polyfill 与 `fromBase64` 守卫的版本。
 * 结论见 docs/plans/2026-09-17-materials-and-selection-ask-design.md §2.1。
 *
 * ## 懒加载
 *
 * pdf.js 主包 ~660KB，绝不能进首屏。所有入口都经过 `pdfjs()`，只有真正打开材料才下载。
 * worker 用 `?url` 拿到构建产物地址（vite.config 里已把 `mjs` 加进 PWA 预缓存，
 * 否则「开发能跑、离线打不开 PDF」）。
 */

import type { PDFDocumentProxy, PDFPageProxy, PageViewport, TextLayer } from 'pdfjs-dist';
import { joinPdfLines, type RawUnit } from './chunk.ts';

type PdfjsModule = typeof import('pdfjs-dist');

let modPromise: Promise<PdfjsModule> | null = null;

/** 懒加载 pdf.js 主包并接上 worker（只做一次） */
async function pdfjs(): Promise<PdfjsModule> {
  if (!modPromise) {
    modPromise = (async () => {
      const [mod, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      mod.GlobalWorkerOptions.workerSrc = worker.default;
      return mod;
    })();
  }
  return modPromise;
}

/**
 * CJK 字体映射表与标准字体目录，由 vite 插件 `pdfjsAssets()` 从 node_modules 提供
 * （dev 直出、build 拷进 dist），仓库里不放这 2.4MB 的二进制。
 *
 * 不配这两项的话：**未内嵌字体的中文 PDF 会渲染成空白/乱码**，这是中文 PDF 的常见情形
 * （很多教材用系统字体而非内嵌），必须配。
 */
export const CMAP_URL = '/pdfjs/cmaps/';
export const STANDARD_FONTS_URL = '/pdfjs/standard_fonts/';

/** 打开 PDF。`url` 由调用方用 blob URL 造好并负责 revoke */
export async function openPdf(url: string): Promise<PDFDocumentProxy> {
  const { getDocument } = await pdfjs();
  return getDocument({
    url,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONTS_URL,
  }).promise;
}

// ── 目录（书签） ────────────────────────────────────────────────────────────

export interface OutlineEntry {
  title: string;
  /** 1 起的页码 */
  page: number;
}

/**
 * 读 PDF 书签目录。
 *
 * 用途有二：阅读器的目录导航；给文本块补 `section`（所属章节），
 * 让 Word 与 PDF 的引用格式统一成「§章节 第 N 页 / 第 N 段」。
 * 没有书签的 PDF 返回空数组（**不要**去猜字号，PDF 没有段落/样式语义，字号启发式误判率高）。
 */
export async function readPdfOutline(doc: PDFDocumentProxy): Promise<OutlineEntry[]> {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline?.length) return [];
  const out: OutlineEntry[] = [];

  const resolvePage = async (dest: unknown): Promise<number> => {
    try {
      const target = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(target) || !target[0]) return 0;
      const idx = await doc.getPageIndex(target[0] as Parameters<typeof doc.getPageIndex>[0]);
      const n = typeof idx === 'number' ? idx : 0;
      return n + 1;
    } catch {
      return 0; // 单条解析失败不影响其他条目
    }
  };

  const walk = async (nodes: typeof outline, depth: number): Promise<void> => {
    if (depth > 6) return; // 防病态深嵌套
    for (const n of nodes) {
      const page = await resolvePage(n.dest);
      const title = (n.title ?? '').replace(/\s+/g, ' ').trim();
      if (title && page > 0) out.push({ title, page });
      if (n.items?.length) await walk(n.items as typeof outline, depth + 1);
    }
  };

  await walk(outline, 0);
  return out.sort((a, b) => a.page - b.page);
}

// ── 文本抽取 ────────────────────────────────────────────────────────────────

export interface PdfExtractProgress {
  page: number;
  total: number;
}

/**
 * 把 `getTextContent()` 的 item 流切成行。
 *
 * 要点：item 之间**默认补一个空格** —— pdf.js 常按「词」或「字」逐个吐 item，
 * 位置信息只存在于坐标里，不补空格会把拉丁词粘成一坨。
 * 中文的「汉字 空格 汉字」随后由 `joinPdfLines` → `collapseCjkSpaces` 吃掉，
 * 所以这个「补了再说」的策略对中英混排同时成立。
 * 真正的换行只认 `hasEOL`。
 *
 * 注：曾经这里还按 item 的 `height` 做「字号大 → 标题」的启发式，已删 ——
 * 已改用 PDF 书签判章节（见 `readPdfOutline`）。PDF 没有段落/样式语义，
 * 字号启发式在封面页、页眉、公式上误判率太高，不如不做。
 */
function groupLines(items: Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items']): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const it of items) {
    if (!('str' in it)) continue; // TextMarkedContent 没有 str
    const str = it.str ?? '';
    if (str) {
      const needSpace = cur.length > 0 && !/\s$/.test(cur) && !/^\s/.test(str);
      cur += (needSpace ? ' ' : '') + str;
    }
    if (it.hasEOL) {
      lines.push(cur);
      cur = '';
    }
  }
  if (cur.trim()) lines.push(cur);
  return lines;
}

/** 一页文本偏短 → 可能是章节扉页（配合书签判定 kind: 'title'） */
const TITLE_PAGE_MAX_CHARS = 120;

/**
 * 逐页抽文本，产出一个单元一页。
 *
 * `section` 取自 PDF 书签（最近一个书签标题），无书签则为 undefined。
 * 抽完 `page.cleanup()` 显式释放：几百页的 PDF 不释放会把 pdf.js 的页缓存撑爆。
 */
export async function extractPdfUnits(
  doc: PDFDocumentProxy,
  onProgress?: (p: PdfExtractProgress) => void,
): Promise<RawUnit[]> {
  const outline = await readPdfOutline(doc);
  const total = doc.numPages;
  const units: RawUnit[] = [];

  for (let p = 1; p <= total; p++) {
    onProgress?.({ page: p, total });
    const page = await doc.getPage(p);
    try {
      const tc = await page.getTextContent();
      const lines = groupLines(tc.items);
      const text = joinPdfLines(lines);
      if (text) {
        // 该页之前（含）最近的书签标题 = 所属章节
        let section: string | undefined;
        let startsHere = false;
        for (const e of outline) {
          if (e.page <= p) section = e.title;
          if (e.page === p) startsHere = true;
        }
        const isDivider = startsHere && text.length <= TITLE_PAGE_MAX_CHARS;
        units.push({ unit: p, text, kind: isDivider ? 'title' : 'body', section });
      }
    } finally {
      page.cleanup();
    }
  }
  return units;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

/** 某页在给定 CSS 宽度下的 CSS 像素尺寸（渲染前先占位，避免滚动跳动） */
export function pageSizeAt(page: PDFPageProxy, cssWidth: number): { width: number; height: number } {
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const vp = page.getViewport({ scale });
  return { width: Math.floor(vp.width), height: Math.floor(vp.height) };
}

/**
 * 渲染一页到 canvas，**返回可取消的句柄**。
 *
 * 为什么必须暴露取消：pdf.js 对同一个 canvas 并发 render 会抛
 * "Cannot use the same canvas during multiple render() operations"。
 * 阅读器缩放/改窗口宽度时会立刻重渲染，上一次若还在飞就会撞上——
 * 所以调用方在发起新一次之前必须先 `cancel()` 掉旧的。
 *
 * 关键：canvas 按 `dpr` 放大后用 `transform` 缩放绘制（清晰），但 canvas 的 **CSS 尺寸**与
 * 文本层都用「CSS 像素」的同一个 viewport —— 二者必须严格同源，否则文字层会与画面错位，
 * 划词就会选到错的位置。`--scale-factor` 也必须是这个 viewport.scale
 * （pdf.js v4 的文本层用 `calc(var(--scale-factor) * Npx)` 定位，见 build/pdf.mjs 的 #layout）。
 */
export interface PdfRenderHandle {
  viewport: PageViewport;
  /** 取消本次渲染。取消后 `done` 会以 RenderingCancelledException 拒绝，调用方应吞掉 */
  cancel: () => void;
  done: Promise<void>;
}

export function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  dpr: number,
): PdfRenderHandle {
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const viewport = page.getViewport({ scale });
  const ratio = Math.min(2, Math.max(1, dpr));

  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法获取 canvas 2d 上下文');
  const task = page.render({
    canvasContext: ctx,
    viewport,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
  });
  return { viewport, cancel: () => task.cancel(), done: task.promise };
}

/**
 * 画文本层（透明、可选中）。`container` 会被清空并填满一层绝对定位的 span。
 *
 * 必须做两件事，否则**选不了字或选错位置**：
 * 1. `--scale-factor` 设在 container 上 —— TextLayer 构造函数内部会 `setLayerDimensions`
 *    用 `var(--scale-factor)` 算容器尺寸，属性必须在构造之前就位；
 * 2. 末尾补一个 `.endOfContent`（pdf.js viewer 的做法）—— 没有它时，
 *    在空白处拖选会一路扩到整页。
 *
 * 返回 TextLayer 实例供调用方 `cancel()`：页面被移出渲染窗口（滚动走了）时
 * 还有半个流的 textContent 没消费完，不取消会一直挂着 reader。
 */
export async function renderTextLayer(
  page: PDFPageProxy,
  container: HTMLElement,
  viewport: PageViewport,
): Promise<TextLayer> {
  container.replaceChildren();
  container.style.setProperty('--scale-factor', String(viewport.scale));
  const { TextLayer } = await pdfjs();
  const layer = new TextLayer({
    textContentSource: page.streamTextContent({
      includeMarkedContent: true,
      disableNormalization: true,
    }),
    container,
    viewport,
  });
  await layer.render();
  const end = document.createElement('div');
  end.className = 'endOfContent';
  container.append(end);
  return layer;
}
