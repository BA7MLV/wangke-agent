/**
 * PCM 纯函数：混音 + 重采样。
 *
 * 单独抽出来的原因：抽音频既要在主线程跑（Worker 不可用时的回退路径），
 * 也要在 `extractWorker` 里跑（后台转写要把这段 CPU 开销挪出页面线程），
 * 两处必须是同一份实现，否则字幕时间轴会随「走没走 Worker」而漂移。
 */

/**
 * 把多声道的平面 Float32 数据（每声道一段）混成单声道。
 * `AudioSample` 拿到的是 `f32-planar`（不是 AudioBuffer），所以只保留这一条路径。
 */
export function mixPlanarToMono(planes: Float32Array[]): Float32Array {
  if (planes.length === 0) return new Float32Array(0);
  if (planes.length === 1) return planes[0];
  const len = planes[0].length;
  const out = new Float32Array(len);
  for (const p of planes) {
    for (let i = 0; i < len; i++) out[i] += p[i];
  }
  const inv = 1 / planes.length;
  for (let i = 0; i < len; i++) out[i] *= inv;
  return out;
}

/**
 * 线性插值重采样到 16kHz，输出 s16。
 *
 * `srcStartSeconds` 是这段数据在**媒体时间轴**上的起点（秒）。输出样本按全局序号对齐到
 * 1/16000 的网格：第 j 个输出样本就代表源时间 `j / 16000`，本段负责的区间是
 * `[ceil(start*16000), ceil(end*16000))`。**必须传真实起点**，不能只按长度算——
 * 44.1kHz 下每帧 1024 样本精确应得 371.51 个 16k 样本，若每帧独立 `floor(len/ratio)` 就只出 371 个，
 * 91 分钟累计会短 7.6s（0.139%），后期字幕线性偏早；按时间轴算区间时各段首尾相接、误差不累积。
 *
 * 相邻两段的边界需要一个跨段样本做插值，这里用 `input[idx+1] ?? a` 兜底（最多 1 个采样点的误差）。
 */
export function resampleTo16kS16(input: Float32Array, srcRate: number, srcStartSeconds = 0): Int16Array {
  const ratio = srcRate / 16000;
  const grid = srcStartSeconds * 16000;
  const outStart = Math.ceil(grid);
  const outEnd = Math.ceil(grid + input.length / ratio);
  const outLen = Math.max(0, outEnd - outStart);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = (outStart + i - grid) * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    const v = Math.max(-1, Math.min(1, a + (b - a) * frac));
    out[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return out;
}

/** 把若干 s16 分片拼成一整条（抽音频是流式解码，逐块追加） */
export function concatS16(chunks: Int16Array[], total: number): Int16Array {
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    pcm.set(c, offset);
    offset += c.length;
  }
  return pcm;
}
