import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import { concatS16, mixToMono, resampleTo16kS16 } from './pcm';

export interface ExtractedAudio {
  /** 16kHz 单声道 s16 PCM */
  pcm: Int16Array;
  duration: number; // 秒
}

/**
 * 用 WebCodecs（mediabunny）流式抽取视频音轨 → 16kHz 单声道 PCM。
 * 内存占用约为 32KB/秒（1 小时 ≈ 115MB），iPad 可承受。
 *
 * 走的是 `AudioBufferSink`，依赖 Web Audio 的 `AudioBuffer`，**只能在主线程跑**。
 * 后台转写默认改用 Worker 里的 `AudioSampleSink` 版本（见 `extractClient.ts`）；
 * 这条路径保留为回退：Worker 建不起来时仍然要能转写。
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

    onProgress?.(1);
    return { pcm: concatS16(chunks, total), duration: total / 16000 };
  } finally {
    input.dispose();
  }
}
