/**
 * 框选区域：从画布裁出图片 + 取出框内文字。
 *
 * 图片规格**刻意对齐 `media/snapshot.ts` 的 `captureFrame`**（大图最长边 1280 / JPEG 0.85，
 * 缩略图 320 / 0.7）：这样框选产出与视频截图完全同构，能直接复用 ChatPanel 里
 * 现成的「三级多模态降级链」（多模态直读 → 视觉模型描述成文字 → 不支持则拦截引导），
 * 不需要为材料另写一套多模态逻辑。
 */

import { collapseCjkSpaces } from './chunk.ts';

/** 相对页面左上角的 CSS 像素矩形 */
export interface RectCss {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegionImage {
  /** 送模型的大图（最长边 1280，JPEG 0.85） */
  dataUrl: string;
  /** 持久化用缩略图（最长边 320） */
  thumb: string;
}

/** 由两个拖拽端点算出规范矩形（支持任意方向拖） */
export function normalizeRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
): RectCss {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** 太小的框（误触）不当作选区 */
export const MIN_REGION_SIDE = 12;

export function isUsableRegion(rect: RectCss): boolean {
  return rect.w >= MIN_REGION_SIDE && rect.h >= MIN_REGION_SIDE;
}

function drawScaled(
  source: HTMLCanvasElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  maxEdge: number,
  quality: number,
): string {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(sw * scale));
  out.height = Math.max(1, Math.round(sh * scale));
  const ctx = out.getContext('2d');
  if (!ctx) return '';
  // 裁出来的区域底色统一铺白：JPEG 不支持透明，否则透明处会变黑
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', quality);
}

/**
 * 从页面 canvas 裁出选区。
 *
 * `ratio` = canvas.width / 该页的 CSS 宽度：canvas 是按 dpr 放大画的（还叠了 pdf.js 的
 * render transform），所以 CSS 坐标 → 设备像素要多乘这一层，否则裁出来的位置会偏。
 * 直接由 `canvas.width / viewport.width` 算出，避免各处自己猜 dpr。
 */
export function cropCanvasRegion(
  canvas: HTMLCanvasElement,
  rect: RectCss,
  ratio: number,
): RegionImage | null {
  if (!isUsableRegion(rect)) return null;
  const sx = Math.max(0, Math.round(rect.x * ratio));
  const sy = Math.max(0, Math.round(rect.y * ratio));
  const sw = Math.min(canvas.width - sx, Math.round(rect.w * ratio));
  const sh = Math.min(canvas.height - sy, Math.round(rect.h * ratio));
  if (sw < 2 || sh < 2) return null;
  const dataUrl = drawScaled(canvas, sx, sy, sw, sh, 1280, 0.85);
  const thumb = drawScaled(canvas, sx, sy, sw, sh, 320, 0.7);
  if (!dataUrl || !thumb) return null;
  return { dataUrl, thumb };
}

/** 框内文字的上限：再多也没意义，反倒挤占上下文 */
const MAX_REGION_TEXT = 2000;

/**
 * 取框选范围内的文字（PDF 的文本层 span 都绝对定位，用包围盒求交即可）。
 *
 * 顺带产出文字是有意的：图 + 字双通道喂给模型，对公式/表格这类纯视觉识别易错的内容更稳，
 * 也让「框选」在 Word 这种没有画布可裁的场景下依然可用（退化为只取文字）。
 *
 * span 之间用空格相连再走 `collapseCjkSpaces`：中文粘在一起、拉丁词保持分开 —— 与
 * PDF 正文抽取用同一套规则，避免同一个页面在「阅读时的文本」和「框选出的文本」上表现不一致。
 */
export function textInRect(root: HTMLElement, rect: RectCss): string {
  const base = root.getBoundingClientRect();
  const hits: string[] = [];
  for (const el of root.querySelectorAll('span')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const x = r.left - base.left;
    const y = r.top - base.top;
    const overlap = x < rect.x + rect.w && x + r.width > rect.x && y < rect.y + rect.h && y + r.height > rect.y;
    if (!overlap) continue;
    const t = el.textContent ?? '';
    if (t) hits.push(t);
    if (hits.join('').length > MAX_REGION_TEXT) break;
  }
  return collapseCjkSpaces(hits.join(' ')).replace(/\s+/g, ' ').trim().slice(0, MAX_REGION_TEXT);
}

/** 清理选区文本：折叠空白、去首尾、限长（划词与框选共用的入口） */
export function cleanSelectionText(raw: string, maxChars = 1200): string {
  const t = collapseCjkSpaces(raw.replace(/\s+/g, ' ')).trim();
  return t.length > maxChars ? `${t.slice(0, maxChars)}…（已截断）` : t;
}

/** 短于此长度的选区不弹浮层（多为误触或多选了一个字） */
export const MIN_SELECTION_CHARS = 2;

export function isUsableSelection(text: string): boolean {
  return text.replace(/\s/g, '').length >= MIN_SELECTION_CHARS;
}
