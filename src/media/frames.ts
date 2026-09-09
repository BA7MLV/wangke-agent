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
