/**
 * PCM 纯函数：混音 + 重采样。
 *
 * 单独抽出来的原因：抽音频既要在主线程跑（Worker 不可用时的回退路径），
 * 也要在 `extractWorker` 里跑（后台转写要把这段 CPU 开销挪出页面线程），
 * 两处必须是同一份实现，否则字幕时间轴会随「走没走 Worker」而漂移。
 */

/** 把 AudioBuffer 混成单声道 Float32 */
export function mixToMono(buf: AudioBuffer): Float32Array {
  const ch0 = buf.getChannelData(0);
  if (buf.numberOfChannels === 1) return ch0;
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < buf.length; i++) out[i] += ch[i];
  }
  const inv = 1 / buf.numberOfChannels;
  for (let i = 0; i < buf.length; i++) out[i] *= inv;
  return out;
}

/**
 * 把多声道的平面 Float32 数据（每声道一段）混成单声道。
 * Worker 里拿到的是 `f32-planar`，没有 AudioBuffer 可用，所以走这条路径。
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

/** 线性插值重采样到 16kHz，输出 s16 */
export function resampleTo16kS16(input: Float32Array, srcRate: number): Int16Array {
  if (srcRate === 16000) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const v = Math.max(-1, Math.min(1, input[i]));
      out[i] = v < 0 ? v * 32768 : v * 32767;
    }
    return out;
  }
  const ratio = srcRate / 16000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
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
