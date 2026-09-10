/// <reference lib="webworker" />
/**
 * 抽音频 + VAD 的 Worker：把转写里最吃 CPU 的两步挪出页面线程，
 * 这样「后台转写 A 视频」不会卡住「正在播放的 B 视频」。
 *
 * 为什么不用主线程那套 `AudioBufferSink`：它内部 `new AudioBuffer(...)`，
 * 而 Web Audio 在 Worker 里根本不存在。这里改用 `AudioSampleSink` +
 * `copyTo({ format: 'f32-planar' })` 直接拿平面 PCM，绕开 Web Audio。
 *
 * Worker 常驻（不每任务重建）：VAD 的 ONNX 会话只加载一次。
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import { getVAD, mergeSegments } from './vad';
import { concatS16, mixPlanarToMono, resampleTo16kS16 } from './pcm';

export interface ExtractRequest {
  id: number;
  type: 'extract';
  blob: Blob;
  duration: number;
}

export type ExtractResponse =
  | { id: number; type: 'progress'; phase: 'extract' | 'vad'; ratio: number }
  | { id: number; type: 'done'; pcm: ArrayBuffer; segments: { start: number; end: number }[] }
  /** retryable：Worker 环境问题（解码器不可用等）值得回退主线程重试；业务问题（没音轨）重试没意义 */
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

    const sink = new AudioSampleSink(track);
    const chunks: Int16Array[] = [];
    let total = 0;
    let lastEnd = 0;

    for await (const sample of sink.samples()) {
      const ch = sample.numberOfChannels;
      const planes: Float32Array[] = [];
      for (let p = 0; p < ch; p++) {
        const bytes = sample.allocationSize({ planeIndex: p, format: 'f32-planar' });
        const buf = new Float32Array(bytes / 4);
        sample.copyTo(buf, { planeIndex: p, format: 'f32-planar' });
        planes.push(buf);
      }
      const s16 = resampleTo16kS16(mixPlanarToMono(planes), sample.sampleRate);
      chunks.push(s16);
      total += s16.length;
      lastEnd = sample.timestamp + sample.duration;
      sample.close();
      if (req.duration > 0) {
        post({ id: req.id, type: 'progress', phase: 'extract', ratio: Math.min(0.99, lastEnd / req.duration) });
      }
    }

    const pcm = concatS16(chunks, total);
    post({ id: req.id, type: 'progress', phase: 'vad', ratio: 0 });

    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
    const vad = await getVAD();
    const raw: { start: number; end: number }[] = [];
    for await (const seg of vad.run(f32, 16000)) {
      raw.push({ start: seg.start / 1000, end: seg.end / 1000 }); // ms → s
    }
    const segments = mergeSegments(raw);

    post({ id: req.id, type: 'done', pcm: pcm.buffer as ArrayBuffer, segments }, [pcm.buffer]);
  } finally {
    input.dispose();
  }
}

self.onmessage = (e: MessageEvent<ExtractRequest>) => {
  const req = e.data;
  if (req?.type !== 'extract') return;
  extract(req).catch((err: unknown) => {
    post({
      id: req.id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      retryable: !(err instanceof BizError),
    });
  });
};
