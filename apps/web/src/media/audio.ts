import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { extractAudio16kFromTrack, type RecoverInfo } from './tolerantDecode';

export interface ExtractedAudio {
  /** 16kHz 单声道 s16 PCM */
  pcm: Int16Array;
  duration: number; // 秒
  /** 补了多少秒静音（绕过损坏帧的代价） */
  skipped: number;
  /** 触发了几次坏帧续解 */
  recoveries: number;
}

/**
 * 用 WebCodecs（mediabunny）流式抽取视频音轨 → 16kHz 单声道 PCM。
 * 内存占用约为 32KB/秒（1 小时 ≈ 115MB），iPad 可承受。
 *
 * 这是**主线程回退路径**：后台转写默认在 Worker 里跑（见 `extractClient.ts`），
 * 这条路径只在 Worker 建不起来 / 起不来时兜底。
 *
 * 两个线程走的是同一个 `extractAudio16kFromTrack`（`AudioSampleSink` + 平面 PCM），
 * 所以坏帧续解、混音、重采样、时间轴完全一致——历史上这里用的是 `AudioBufferSink`，
 * 换掉的原因是它内部要 `new AudioBuffer`（Worker 里没有 Web Audio），两套实现没法共用。
 */
export async function extractAudio16k(
  blob: Blob,
  knownDuration: number,
  onProgress?: (ratio: number) => void,
  onRecover?: (info: RecoverInfo) => void,
): Promise<ExtractedAudio> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('未找到音轨：该文件可能没有声音，或格式不受支持（建议转为 MP4）');

    return await extractAudio16kFromTrack(track, { duration: knownDuration, onProgress, onRecover });
  } finally {
    input.dispose();
  }
}
