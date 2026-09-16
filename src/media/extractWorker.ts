/// <reference lib="webworker" />
/**
 * 抽音频 + VAD 的 Worker：把转写里最吃 CPU 的两步挪出页面线程，
 * 这样「后台转写 A 视频」不会卡住「正在播放的 B 视频」。
 *
 * 抽音频走 `extractAudio16kFromTrack`（与主线程回退路径**同一份实现**）：
 * 它用 `AudioSampleSink` + `copyTo({ format: 'f32-planar' })` 直接拿平面 PCM，
 * 绕开 Web Audio（`AudioBufferSink` 在 Worker 里根本用不了），并自带坏帧续解。
 *
 * Worker 常驻（不每任务重建）：VAD 的 ONNX 会话只加载一次。
 */
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { extractAudio16kFromTrack } from './tolerantDecode';
import { getVAD, mergeSegments } from './vad';

export interface ExtractRequest {
  id: number;
  type: 'extract';
  blob: Blob;
  duration: number;
}

export type ExtractResponse =
  /** note：绕过损坏帧时的提示（可跟进度一起显示给用户） */
  | { id: number; type: 'progress'; phase: 'extract' | 'vad'; ratio: number; note?: string }
  | {
      id: number;
      type: 'done';
      pcm: ArrayBuffer;
      segments: { start: number; end: number }[];
      /** 音轨里有几处损坏帧被跳过，以及为此补了多少秒静音（诊断用） */
      recoveries: number;
      skipped: number;
    }
  /**
   * retryable：Worker 环境问题（解码器不可用等）值得回退主线程重试；
   * 业务问题（没音轨）与音频坏帧（文件问题）换线程也一样失败，给 false
   */
  | { id: number; type: 'error'; message: string; retryable: boolean };

/** 业务错误：与线程/环境无关，回退到主线程再跑一遍也是同样的结果 */
class BizError extends Error {}

const post = (msg: ExtractResponse, transfer?: Transferable[]) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? []);

async function extract(req: ExtractRequest): Promise<void> {
  const input = new Input({ source: new BlobSource(req.blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new BizError('未找到音轨：该文件可能没有声音，或格式不受支持（建议转为 MP4）');

    let lastRatio = 0;
    const { pcm, skipped, recoveries } = await extractAudio16kFromTrack(track, {
      duration: req.duration,
      onProgress: (ratio) => {
        lastRatio = ratio;
        post({ id: req.id, type: 'progress', phase: 'extract', ratio });
      },
      onRecover: (info) => {
        post({
          id: req.id,
          type: 'progress',
          phase: 'extract',
          ratio: lastRatio,
          note: `已跳过第 ${info.attempt} 处损坏帧`,
        });
      },
    });

    post({ id: req.id, type: 'progress', phase: 'vad', ratio: 0 });

    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
    const vad = await getVAD();
    const raw: { start: number; end: number }[] = [];
    for await (const seg of vad.run(f32, 16000)) {
      raw.push({ start: seg.start / 1000, end: seg.end / 1000 }); // ms → s
    }
    const segments = mergeSegments(raw);

    post({ id: req.id, type: 'done', pcm: pcm.buffer as ArrayBuffer, segments, recoveries, skipped }, [
      pcm.buffer,
    ]);
  } finally {
    input.dispose();
  }
}

self.onmessage = (e: MessageEvent<ExtractRequest>) => {
  const req = e.data;
  if (req?.type !== 'extract') return;
  extract(req).catch((err: unknown) => {
    // 坏帧绕不过去属于文件问题（AudioDecodeError），回退主线程只会把整个文件再解一遍、结果一样
    const decodeFailure = (err as { name?: string })?.name === 'AudioDecodeError';
    post({
      id: req.id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      retryable: !(err instanceof BizError) && !decodeFailure,
    });
  });
};
