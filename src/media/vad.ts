import { NonRealTimeVAD } from '@ricky0123/vad-web';

let vadPromise: Promise<NonRealTimeVAD> | null = null;

export function getVAD(): Promise<NonRealTimeVAD> {
  if (!vadPromise) {
    vadPromise = NonRealTimeVAD.new({
      modelURL: '/vad/silero_vad_legacy.onnx',
      ortConfig: (ort) => {
        // 自托管 wasm（public/ort/，dev 由 vite 中间件直发，prod 原样拷贝）
        ort.env.wasm.wasmPaths = '/ort/';
      },
      minSpeechMs: 200,
      // 默认 redemptionMs 偏大，800ms 停顿都不会切段；调小以获得更细的字幕粒度
      redemptionMs: 300,
    });
  }
  return vadPromise;
}

export interface VadSegment {
  start: number; // 秒
  end: number;
}

/** 单段上限：8s 约 2 行字幕，避免条内堆叠过多文本（ASR 免费，无需靠大段省请求） */
const MAX_SEG_SECONDS = 8;

/** 合并过短/过密的 VAD 段：间隔 <0.4s 合并，单段最长 8s，最短 0.5s */
export function mergeSegments(raw: VadSegment[]): VadSegment[] {
  const out: VadSegment[] = [];
  for (const seg of raw) {
    const last = out[out.length - 1];
    if (last && seg.start - last.end < 0.4 && seg.end - last.start <= MAX_SEG_SECONDS) {
      last.end = seg.end;
    } else {
      out.push({ ...seg });
    }
  }
  // 过短的段并入前一段
  const merged: VadSegment[] = [];
  for (const seg of out) {
    const last = merged[merged.length - 1];
    if (seg.end - seg.start < 0.5 && last && last.end - last.start + (seg.end - seg.start) <= MAX_SEG_SECONDS) {
      last.end = seg.end;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/**
 * 对 16kHz s16 PCM 做语音端点检测，返回带时间戳的语音段。
 */
export async function segmentAudio(pcm16k: Int16Array): Promise<VadSegment[]> {
  const f32 = new Float32Array(pcm16k.length);
  for (let i = 0; i < pcm16k.length; i++) f32[i] = pcm16k[i] / 32768;
  const vad = await getVAD();
  const raw: VadSegment[] = [];
  for await (const seg of vad.run(f32, 16000)) {
    raw.push({ start: seg.start / 1000, end: seg.end / 1000 }); // ms → s
  }
  return mergeSegments(raw);
}
