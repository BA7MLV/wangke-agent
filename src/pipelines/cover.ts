import { db, type CoverRow, type VideoRow } from '../store/db';
import { getMaterialFile, getVideoFile } from '../store/fileStore';
import { COVER_EDGE, downscaleToCover, encodeCanvas, pickCoverFrame } from '../media/frames';
import { openPdf } from '../materials/pdf';
import { getColorFromImage } from '../ui/mdui';

/**
 * 生成并保存一份封面（**派生资源**）。
 *
 * 存在的理由：封面原先是从 `db.frames` 里顺手取的第一帧，而 `frames` 只有
 * **跑过讲义**的视频才有 —— 于是「刚导入的视频没有封面」「讲义重生成时封面凭空消失」
 * 都成了常态。这里把封面独立成一条链路：**入库即生成、存自己的表、和讲义解耦**。
 *
 * 三类资源共用这一条路：视频、PDF、Word 的主键都是 `videos.id`，
 * 所以 `covers` 直接拿它当主键，读取端一句 `covers.get(id)` 就够。
 *
 * 选帧质量的三级来源：
 *   1. `slide`　讲义已经抽好的幻灯片帧（课程首页即课件，质量最稳）
 *   2. `material-page`　PDF 首页渲染
 *   3. `auto`　自己对视频多点采样打分（见 `media/frames.ts` 的 pickCoverFrame）
 */

/** 一次生成的产物（写库前的中间形态） */
interface PickedCover {
  blob: Blob;
  w: number;
  h: number;
  ts: number;
  source: CoverRow['source'];
}

/**
 * 复用讲义抽好的帧当封面。
 *
 * 挑法与播放页的动态取色保持一致（`Player.tsx` 的同一套启发式）：**幻灯片帧优先，
 * 同类里取时间最早的**。那些帧本来就是按画面差异从同一个视频里挑出来的课件页，
 * 比临时抽样更稳——课程首页就是这门课的脸。
 *
 * 代价说明：`toArray()` 会把该视频所有帧的 blob 一起读出来（一节课几十帧、几 MB）。
 * 这里是**一次性后台操作、且队列串行**，与 Player.tsx 的取舍相同；
 * 帧表没有 `kind` 索引，想只读幻灯片帧也绕不开它，不值得为这个改库结构。
 */
async function reuseSlideFrame(id: string): Promise<PickedCover | null> {
  const frames = await db.frames.where('videoId').equals(id).toArray();
  if (frames.length === 0) return null;
  frames.sort((a, b) => Number(b.kind === 'slide') - Number(a.kind === 'slide') || a.ts - b.ts);
  const best = frames.find((f) => f.kind === 'slide' && f.blob);
  if (!best) return null;
  const scaled = await downscaleToCover(best.blob);
  if (!scaled) return null;
  return { blob: scaled.blob, w: scaled.width, h: scaled.height, ts: best.ts, source: 'slide' };
}

async function pickVideoCover(id: string, blob: Blob): Promise<PickedCover> {
  const reused = await reuseSlideFrame(id);
  if (reused) return reused;
  const pick = await pickCoverFrame(blob);
  return { blob: pick.blob, w: pick.width, h: pick.height, ts: pick.ts, source: 'auto' };
}

/**
 * PDF：把首页渲染成封面。
 *
 * 这里**不走 `pdf.ts` 的 `renderPageToCanvas`** —— 那个是给阅读器用的，尺寸由
 * 「CSS 宽度 × dpr」推出来（要跟文本层的 viewport 严格同源，否则划词会错位），
 * 落到封面这里就会出现 floor 误差（A4 算出来 479 而不是 480）。
 * 封面只要一张确定尺寸的位图，所以直接按目标尺寸算 scale、一次性画到位。
 *
 * 只认 PDF —— **Word 没有「首页画面」这回事**，硬渲染要自己排版一张标题卡，
 * 收益不大还容易做得难看，所以那边返回 null，由调用方标记完成并保留文档图标占位。
 */
async function pickMaterialCover(row: VideoRow, blob: Blob): Promise<PickedCover | null> {
  if (row.materialFormat !== 'pdf') return null;
  const url = URL.createObjectURL(blob);
  try {
    const doc = await openPdf(url);
    try {
      if (doc.numPages < 1) return null;
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: COVER_EDGE / Math.max(base.width, base.height) });

      const canvas = document.createElement('canvas');
      canvas.width = Math.min(COVER_EDGE, Math.round(viewport.width));
      canvas.height = Math.min(COVER_EDGE, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // 先铺白底：pdf.js 只画页面内容，带背景色的 PDF 反倒是少数，
      // 不铺的话封面会有一大片半透明区域
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();

      return {
        blob: await encodeCanvas(canvas, 0.75),
        w: canvas.width,
        h: canvas.height,
        ts: 1,
        source: 'material-page',
      };
    } finally {
      await doc.destroy();
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 从封面图里取主色，用作「封面还没生成好」时的占位底色（LQIP）。
 *
 * 复用 mdui 的 Material You 取色，与播放页的动态取色同一套量化 —— 免得站内出现
 * 两套「这门课的主色」。任何失败都只是「没有占位色」，不该影响封面本身，故一律吞掉。
 */
async function extractColor(source: Blob): Promise<string | undefined> {
  const url = URL.createObjectURL(source);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const hex = await getColorFromImage(img);
    return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : undefined;
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 为一份资源补齐封面。**幂等**：已有 `covers` 记录就直接返回（`force` 可强制重做）。
 *
 * 三种「不生成」的收尾都写 `coverState`，好让回填扫描别再反复试：
 * - 文件本体已删（`fileDeleted`）→ `skipped`
 * - 文件读不出来 → `skipped`
 * - Word 材料（没有可渲染的首页）→ `done`，保留文档图标
 *
 * @returns 是否真的写入了新封面（调用方据此决定要不要通知界面刷新）
 */
export async function ensureCover(id: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const row = await db.videos.get(id);
  if (!row) return false;

  const current = await db.covers.get(id);
  if (!opts.force) {
    if (current) {
      if (row.coverState !== 'done') await db.videos.update(id, { coverState: 'done' });
      return false;
    }
  } else if (current?.source === 'user') {
    // 强制重做（讲义跑完想换更好的幻灯片帧）也不能覆盖**用户手选**的封面——那是人的决定
    return false;
  }
  if (row.fileDeleted === 1) {
    await db.videos.update(id, { coverState: 'skipped' });
    return false;
  }

  const isMaterial = row.kind === 'material';
  const blob = isMaterial ? await getMaterialFile(id) : await getVideoFile(id);
  if (!blob) {
    await db.videos.update(id, { coverState: 'skipped' });
    return false;
  }

  const picked = isMaterial ? await pickMaterialCover(row, blob) : await pickVideoCover(id, blob);
  if (!picked) {
    await db.videos.update(id, { coverState: 'done' });
    return false;
  }

  const color = await extractColor(picked.blob);
  let written = false;
  await db.transaction('rw', db.covers, db.videos, async () => {
    // 生成期间这份资源可能已经被删了 —— 别留一条孤儿封面
    if (!(await db.videos.get(id))) return;
    // `covers.put` 是主键覆盖，天然原子：不存在「旧的删了、新的没写进去」的窗口
    await db.covers.put({
      videoId: id,
      blob: picked.blob,
      w: picked.w,
      h: picked.h,
      ts: picked.ts,
      source: picked.source,
      createdAt: Date.now(),
    });
    await db.videos.update(id, { coverState: 'done', dominantColor: color });
    written = true;
  });
  return written;
}
