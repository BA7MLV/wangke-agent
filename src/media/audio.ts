import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';

export interface ExtractedAudio {
  /** 16kHz 单声道 s16 PCM */
  pcm: Int16Array;
  duration: number; // 秒
}

/** 把 AudioBuffer 混成单声道 Float32 */
function mixToMono(buf: AudioBuffer): Float32Array {
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

/** 线性插值重采样到 16kHz，输出 s16 */
function resampleTo16kS16(input: Float32Array, srcRate: number): Int16Array {
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

/**
 * 用 WebCodecs（mediabunny）流式抽取视频音轨 → 16kHz 单声道 PCM。
 * 内存占用约为 32KB/秒（1 小时 ≈ 115MB），iPad 可承受。
 */
export async function extractAudio16k(
  blob: Blob,
  knownDuration: number,
  onProgress?: (ratio: number) => void,
): Promise<ExtractedAudio> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('未找到音轨：该文件可能没有声音，或格式不受支持（建议转为 MP4）');

    const sink = new AudioBufferSink(track);
    const chunks: Int16Array[] = [];
    let total = 0;
    let lastEnd = 0;

    for await (const wrapped of sink.buffers()) {
      const buf = wrapped.buffer as AudioBuffer;
      const mono = mixToMono(buf);
      const s16 = resampleTo16kS16(mono, buf.sampleRate);
      chunks.push(s16);
      total += s16.length;
      lastEnd = wrapped.timestamp + wrapped.duration;
      if (knownDuration > 0) onProgress?.(Math.min(0.99, lastEnd / knownDuration));
    }

    const pcm = new Int16Array(total);
    let offset = 0;
    for (const c of chunks) {
      pcm.set(c, offset);
      offset += c.length;
    }
    onProgress?.(1);
    return { pcm, duration: total / 16000 };
  } finally {
    input.dispose();
  }
}
