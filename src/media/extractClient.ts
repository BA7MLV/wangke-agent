/**
 * 「抽音频 + VAD」的调用入口：优先丢给 Worker，Worker 不可用就退回主线程。
 *
 * 选择权只在这一层：上层（转写流水线）拿到的永远是同一个结果形状，
 * 不需要关心这次到底跑在哪个线程上。
 */
import { extractAudio16k } from './audio';
import { segmentAudio, type VadSegment } from './vad';
import type { ExtractRequest, ExtractResponse } from './extractWorker';
import { CancelError } from '../utils/cancel';

export interface ExtractResult {
  pcm: Int16Array;
  segments: VadSegment[];
  /** 这次跑在哪个线程上（诊断用：Worker 挂了会静默降级，得能查出来） */
  via: 'worker' | 'main';
}

interface Pending {
  resolve: (r: ExtractResult) => void;
  reject: (e: unknown) => void;
  onProgress?: (phase: 'extract' | 'vad', ratio: number) => void;
}

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('./extractWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<ExtractResponse>) => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') {
        p.onProgress?.(msg.phase, msg.ratio);
        return;
      }
      pending.delete(msg.id);
      if (msg.type === 'done') {
        p.resolve({ pcm: new Int16Array(msg.pcm), segments: msg.segments, via: 'worker' });
        return;
      }
      const err = new Error(msg.message) as Error & { retryable?: boolean };
      err.retryable = msg.retryable;
      p.reject(err);
    };
    w.onerror = () => {
      // Worker 起不来（脚本解析失败 / import 报错）：标记降级，之后一律走主线程
      workerBroken = true;
      failAll(new Error('转写 Worker 启动失败，已回退到主线程'));
      w.terminate();
      worker = null;
    };
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

function failAll(err: unknown) {
  for (const [, p] of pending) p.reject(err);
  pending.clear();
}

/** 取消：抽音频/VAD 阶段只能靠 terminate 打断（这两个阶段在 Worker 里是同步密集循环） */
export function terminateExtractor(): void {
  if (!worker) return;
  failAll(new CancelError());
  worker.terminate();
  worker = null;
}

export function resetExtractor(): void {
  workerBroken = false;
}

export async function extractAndSegment(
  blob: Blob,
  duration: number,
  onProgress?: (phase: 'extract' | 'vad', ratio: number) => void,
): Promise<ExtractResult> {
  const w = ensureWorker();
  if (!w) {
    const { pcm } = await extractAudio16k(blob, duration, (r) => onProgress?.('extract', r));
    onProgress?.('vad', 0);
    const segments = await segmentAudio(pcm);
    return { pcm, segments, via: 'main' };
  }

  const id = ++seq;
  const req: ExtractRequest = { id, type: 'extract', blob, duration };
  return new Promise<ExtractResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage(req);
  }).catch((e: unknown) => {
    if (e instanceof CancelError) throw e;
    // 业务错误（没音轨之类）换线程也一样失败，别白跑一遍解码；环境问题才回退
    if ((e as { retryable?: boolean }).retryable === false) throw e;
    console.debug('[extract] worker 路径失败，回退主线程：', e);
    workerBroken = true;
    return extractAndSegment(blob, duration, onProgress);
  });
}
