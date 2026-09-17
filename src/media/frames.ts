export interface ExtractedFrame {
  ts: number; // 秒
  blob: Blob; // JPEG
  width: number;
  height: number;
}

/** 16x16 灰度均值哈希差（0~255），用于画面去重 */
function frameDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function toGray16(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Uint8Array {
  const tmp = document.createElement('canvas');
  tmp.width = 16;
  tmp.height = 16;
  const tctx = tmp.getContext('2d')!;
  tctx.drawImage(canvas, 0, 0, 16, 16);
  const data = tctx.getImageData(0, 0, 16, 16).data;
  const gray = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    gray[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
  }
  void ctx;
  return gray;
}

/**
 * 用 <video> + canvas 等间隔抽帧，并按画面差异去重（PPT 翻页会保留，静止画面被过滤）。
 */
export async function extractFrames(
  blob: Blob,
  opts: {
    interval?: number; // 采样间隔秒，默认 20
    maxFrames?: number; // 最多保留帧数，默认 60
    diffThreshold?: number; // 去重阈值，默认 12
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ExtractedFrame[]> {
  const { interval = 20, maxFrames = 60, diffThreshold = 12, onProgress } = opts;

  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('视频加载失败，无法抽帧'));
    });

    const duration = video.duration;
    if (!duration || !isFinite(duration)) throw new Error('无法读取视频时长');

    const timestamps: number[] = [];
    for (let t = Math.min(2, duration * 0.02); t < duration - 1; t += interval) {
      timestamps.push(t);
    }

    const scale = Math.min(1, 640 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d')!;

    const frames: ExtractedFrame[] = [];
    let lastGray: Uint8Array | null = null;

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      await new Promise<void>((resolve) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = ts;
      });

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const gray = toGray16(canvas, ctx);
      const diff = lastGray ? frameDiff(gray, lastGray) : Infinity;

      if (diff >= diffThreshold) {
        const blobOut = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.75));
        if (blobOut) {
          frames.push({ ts, blob: blobOut, width: canvas.width, height: canvas.height });
          lastGray = gray;
        }
      }
      onProgress?.(i + 1, timestamps.length);
      if (frames.length >= maxFrames) break;
    }

    return frames;
  } finally {
    URL.revokeObjectURL(url);
    video.src = '';
  }
}

/** Blob → base64 data URL（供 VL 模型） */
export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * 定点高清抽帧：讲义配图用。
 * extractFrames 的 640px/q0.75 是给 VL 识图的折中（省 token），直接进 DOCX 只有约 110 DPI；
 * 这里按原视频分辨率（maxWidth 封顶）+ 高 JPEG 质量重抽实际用到的少量帧。
 */
export async function extractFramesAt(
  blob: Blob,
  timestamps: number[],
  opts: { maxWidth?: number; quality?: number } = {},
): Promise<Map<number, ExtractedFrame>> {
  const { maxWidth = 1600, quality = 0.92 } = opts;
  const out = new Map<number, ExtractedFrame>();
  if (timestamps.length === 0) return out;

  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('视频加载失败，无法抽帧'));
    });

    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d')!;
    const duration = video.duration;

    for (const ts of timestamps) {
      const t = Math.min(Math.max(0, ts), Math.max(0, duration - 0.1));
      await new Promise<void>((resolve) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = t;
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blobOut = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
      if (blobOut) out.set(ts, { ts, blob: blobOut, width: canvas.width, height: canvas.height });
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
    video.src = '';
  }
}

// ── 封面 ────────────────────────────────────────────────────────────────────

/** 封面长边上限。卡片实际显示宽度 240~360px，2x 屏够到 720；480 是体积与清晰度的折中 */
export const COVER_EDGE = 480;
/** 候选帧数量。再多只是让导入变慢，5 个足以覆盖「片头 → 首页课件」这一段 */
const COVER_CANDIDATES = 5;
/** 候选窗口的最长跨度（秒）：一小时的长课，标题页也一定在开头，扫到 2 分钟足够 */
const COVER_WINDOW_MAX = 120;
/** 稳定性探针间隔（秒）：隔这么久画面还几乎不动，说明不是转场中点也不是剧烈运镜 */
const COVER_STABLE_DT = 0.35;
/** 打分用的探针小图长边。够看出明暗与清晰度，getImageData 的开销又可忽略 */
const PROBE_EDGE = 64;

export interface CoverPick {
  /** 已编码的封面图（WebP，不支持时 JPEG），长边不超过 COVER_EDGE */
  blob: Blob;
  width: number;
  height: number;
  /** 选中的时间点（秒） */
  ts: number;
  /** 实际参与打分的候选数 */
  candidates: number;
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('视频 seek 失败'));
    };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = t;
  });
}

function readGray(ctx: CanvasRenderingContext2D, w: number, h: number): Uint8Array {
  const data = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
  }
  return gray;
}

function meanOf(gray: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  return sum / gray.length / 255;
}

/**
 * 拉普拉斯响应的方差，经典的「清晰度」度量：边缘越多越锐，响应越分散，方差越大。
 * 纯色/静态大片区域（黑场、过曝白底、虚焦）方差接近 0。
 */
function laplacianVariance(gray: Uint8Array, w: number, h: number): number {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/** 亮度带：均值落在 [0.15, 0.85] 之外时按距离线性衰减（黑场与过曝白底都要避开） */
function luminanceBand(mean: number): number {
  if (mean < 0.15) return mean / 0.15;
  if (mean > 0.85) return (1 - mean) / 0.15;
  return 1;
}

/**
 * 把 canvas 编码成封面图：优先 WebP，拿不到就 JPEG。
 *
 * **必须校验 `blob.type`**：`convertToBlob` / `toBlob` 在编码器不认识所请求的格式时
 * 不报错，而是静默退回 PNG——PNG 的封面比 WebP 大一倍以上，白白浪费鉴权。
 */
export async function encodeCanvas(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const off = new OffscreenCanvas(canvas.width, canvas.height);
      const octx = off.getContext('2d');
      if (octx) {
        octx.drawImage(canvas, 0, 0);
        const b = await off.convertToBlob({ type: 'image/webp', quality });
        if (b.type === 'image/webp' || b.type === 'image/jpeg') return b;
      }
    } catch {
      /* 落到下面的主线程编码：Safari 16.4 以下没有 OffscreenCanvas */
    }
  }
  const jpeg = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
  if (!jpeg) throw new Error('封面编码失败');
  return jpeg;
}

/**
 * 为「封面」挑一帧。
 *
 * 与 `extractFrames` 的分工：那条路是**给讲义配图 / 给 VL 识图**的——等间隔铺满全片、
 * 按画面差异去重；封面要回答的是另一个问题：**哪一帧最适合当这门课的脸**。
 * 这里复用同一套 `<video>` + canvas 手法（都在主线程，才能直接吃浏览器的解码），
 * 但采样窗口、打分方式、输出档位全部为封面定制：
 *
 * 1. **只采开头**：从 `min(3s, 2%)` 起、跨度不超过 120 秒。课程视频的标题页/首页课件
 *    就在这一段；把窗口铺到全片的 40%，只会让讲师出镜的随机画面被选中。
 * 2. **不打绝对阈值**：拉普拉斯方差在不同分辨率与码率下绝对值没法通用，标定出来的
 *    阈值换个视频就失效。所以清晰度与稳定性**只在这几个候选之间做组内归一化**，
 *    免标定。唯一的绝对量是亮度带——黑场/过曝无论什么时候都该被判死。
 * 3. **稳定性探针**：同一位置再取 `t + 0.35s` 的一帧，两帧差得越多越可能是转场中点
 *    或剧烈运镜。那种帧是重影/半透明的，当封面很难看。
 * 4. **输出长边 480、编码 WebP**：1080p 原尺寸帧有 1~3MB，480px WebP 只要 15~30KB。
 *
 * 成本：每个候选 2 次 seek（打分 + 稳定性），5 个候选共 10 次左右，加上最后出图 1 次。
 * 单个视频在数百毫秒到两三秒之间，因此调用方必须放在串行队列里跑（见 pipelines/coverQueue）。
 */
export async function pickCoverFrame(
  blob: Blob,
  opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<CoverPick> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('视频加载失败，无法生成封面'));
    });

    const duration = video.duration;
    if (!duration || !isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长');
    if (!video.videoWidth || !video.videoHeight) throw new Error('无法读取视频分辨率');

    const start = Math.min(3, duration * 0.02);
    const span = Math.min(duration * 0.4, COVER_WINDOW_MAX);
    const end = Math.max(start, Math.min(duration - 0.2, start + span));
    const timestamps: number[] = [];
    for (let i = 0; i < COVER_CANDIDATES; i++) {
      // 候选数写成 1 时退化成「只取起点」，用 max 兜住除零，不必为它单独分支
      const step = Math.max(1, COVER_CANDIDATES - 1);
      const t = start + ((end - start) * i) / step;
      timestamps.push(Math.max(0, Math.round(t * 100) / 100));
    }

    const sw = PROBE_EDGE;
    const sh = Math.max(1, Math.round((sw * video.videoHeight) / video.videoWidth));
    const probe = document.createElement('canvas');
    probe.width = sw;
    probe.height = sh;
    const pctx = probe.getContext('2d', { willReadFrequently: true })!;

    const raws: { ts: number; mean: number; lap: number; stab: number }[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i];
      try {
        await seekTo(video, t);
      } catch {
        continue; // 单个时间点 seek 失败不该让整次生成失败
      }
      pctx.drawImage(video, 0, 0, sw, sh);
      const gray = readGray(pctx, sw, sh);
      const mean = meanOf(gray);
      const lap = laplacianVariance(gray, sw, sh);

      let stab = 1;
      const t2 = t + COVER_STABLE_DT;
      if (t2 < duration - 0.05) {
        const before = toGray16(probe, pctx);
        try {
          await seekTo(video, t2);
          pctx.drawImage(video, 0, 0, sw, sh);
          const after = toGray16(probe, pctx);
          // frameDiff 的尺度：~16 已经是「换了画面」，取 40 作为完全不稳定
          stab = 1 - Math.min(1, frameDiff(before, after) / 40);
        } catch {
          /* 探针失败就按「稳定」处理，不因此否定这个候选 */
        }
      }

      raws.push({ ts: t, mean, lap, stab });
      opts.onProgress?.(i + 1, timestamps.length);
    }

    if (raws.length === 0) throw new Error('无法从视频中取到任何一帧');

    const lapMin = Math.min(...raws.map((r) => r.lap));
    const lapMax = Math.max(...raws.map((r) => r.lap));
    const lapSpan = lapMax - lapMin;
    let best = raws[0];
    let bestScore = -1;
    for (const r of raws) {
      const sharp = lapSpan > 1e-6 ? (r.lap - lapMin) / lapSpan : 1;
      // 亮度是硬门槛（乘），清晰度与稳定性内部加权
      const score = luminanceBand(r.mean) * (0.55 * sharp + 0.45 * r.stab);
      // 严格大于：并列时保留更早的候选——课程首页通常就在开头
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = r;
      }
    }

    const scale = Math.min(1, COVER_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d')!;
    await seekTo(video, best.ts);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const out = await encodeCanvas(canvas, 0.75);

    return {
      blob: out,
      width: canvas.width,
      height: canvas.height,
      ts: best.ts,
      candidates: raws.length,
    };
  } finally {
    URL.revokeObjectURL(url);
    video.src = '';
  }
}

/**
 * 把一张已有的图重编码成封面档位（长边 480 + WebP）。
 *
 * 用途是「复用讲义已经抽好的 slide 帧当封面」——那些帧本来就是从同一个视频里
 * 按画面差异挑出来的课件页，质量比临时重新抽样更稳，唯一的问题是它们是
 * 640px JPEG（给 VL 识图的折中），档位与封面不一致，所以在这里过一次。
 */
export async function downscaleToCover(
  source: Blob,
): Promise<{ blob: Blob; width: number; height: number } | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, COVER_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { blob: await encodeCanvas(canvas, 0.75), width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}
