/**
 * 带「坏帧容忍」的音频抽取：把一条音轨解成 16kHz 单声道 s16 PCM。
 *
 * 为什么需要容忍：WebCodecs 的 `AudioDecoder` 按规范**只要有一帧解不出来就关闭整个解码器**
 * 并抛 `EncodingError`（Chrome 的文案就是 `Decoding error.`），mediabunny 把它原样抛出来。
 * 而现实里下载/录屏得到的课程文件常有极个别损坏帧——实测一个 91 分钟的文件里只有 1 帧坏
 * （ffmpeg 报 `invalid band type`），ffmpeg 和播放器都只是丢掉那一帧继续，浏览器却会让整条
 * 转写直接失败。所以这里自己续解：捕获解码错误后，从「最后一个成功样本的结束时间 + ∆」
 * 换一个新 sink 继续解，中间缺失的时间补零（静音），时间轴不会漂。
 *
 * 主线程回退路径与 Worker 路径**共用这一个实现**（见 `audio.ts` / `extractWorker.ts`），
 * 否则「走没走 Worker」会让字幕时间轴不一致。
 */
import { AudioSampleSink, InputDisposedError, type AudioSample, type InputAudioTrack } from 'mediabunny';
import { mixPlanarToMono, resampleTo16kS16, concatS16 } from './pcm';

/** 每次续解的跳过时长（秒）：先试最小的（实测一个坏帧 0.05 就够），连续失败就加大 */
const RESUME_GAPS = [0.05, 0.2, 0.5, 1, 2, 5, 10] as const;
/** 上限：续解次数、累计补零时长（防止文件尾部整片损坏时无限重试 / 时间轴被切碎） */
const MAX_RECOVERIES = 24;
const MAX_SILENCE_SECONDS = 30;
/** 小于一个采样点的空档不值得补（正常连续帧之间会有 1e-9 级误差） */
const SILENCE_EPSILON = 1 / 16000;

export interface RecoverInfo {
  /** 出问题的时间点（秒），即最后一个成功样本的结束时间 */
  at: number;
  /** 这次尝试跳过的时长（秒） */
  seconds: number;
  /** 第几次续解（从 1 开始） */
  attempt: number;
}

export interface ExtractAudioOptions {
  /** 媒体总时长（秒），只用于进度换算；0 或省略表示未知 */
  duration?: number;
  /** 进度（0~1），按已解到的媒体时间 / duration 估算 */
  onProgress?: (ratio: number) => void;
  /** 每次绕过损坏帧时回调（用于提示 / 诊断） */
  onRecover?: (info: RecoverInfo) => void;
}

export interface ExtractAudioResult {
  /** 16kHz 单声道 s16；时间轴与媒体一致（跳过的部分已补静音） */
  pcm: Int16Array;
  /** PCM 时长（秒），= pcm.length / 16000 */
  duration: number;
  /** 累计补了多少秒静音（跳过损坏帧的代价） */
  skipped: number;
  /** 触发了几次续解；0 表示音轨完好 */
  recoveries: number;
}

/** 音轨坏到连续解都绕不过去时抛出（区别于「没音轨」这类业务错误，它是文件问题、换线程也一样） */
export class AudioDecodeError extends Error {
  /** 出问题的时间点（秒） */
  readonly at: number;
  /** 已尝试的续解次数 */
  readonly recoveries: number;
  /** 浏览器抛出来的原始解码错误 */
  readonly cause: unknown;

  constructor(at: number, recoveries: number, cause: unknown) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    super(
      `音轨第 ${formatSeconds(at)} 处有损坏的音频帧（浏览器解码器：${detail}），` +
        `连续跳过 ${recoveries} 次仍无法越过。建议重新下载该视频，或先用 ffmpeg 转码音轨` +
        `（\`ffmpeg -i in.mp4 -c:v copy -c:a aac -b:a 128k out.mp4\`）`,
    );
    this.name = 'AudioDecodeError';
    this.at = at;
    this.recoveries = recoveries;
    this.cause = cause;
  }
}

/** 把一条音轨解成 16kHz 单声道 s16 PCM（带坏帧续解） */
export async function extractAudio16kFromTrack(
  track: InputAudioTrack,
  opts: ExtractAudioOptions = {},
): Promise<ExtractAudioResult> {
  const { duration = 0, onProgress, onRecover } = opts;

  const chunks: Int16Array[] = [];
  let total = 0;
  /** 已经写进 PCM 的媒体时间游标：`cursor` 之后到下一个样本之前一律补静音 */
  let cursor = 0;
  let resumeAt = 0;
  let gapIdx = 0;
  let recoveries = 0;
  let skipped = 0;
  /** 连续「一点进展都没有」的续解次数：递增到跳过时长上限还不行，就认定这段彻底废了 */
  let stuck = 0;

  for (;;) {
    // 每次尝试都换一个新的 sink（解码器出错后那一个已经废了）。同一个 Input / track 可以复用，
    // 已实测：第一个 sink 在 584.5s 报错的同时，第二个 sink 从 584.5s 起能一路解到底。
    const sink = new AudioSampleSink(track);
    let progressed = false;

    try {
      for await (const sample of sink.samples(resumeAt > 0 ? resumeAt : undefined)) {
        const start = sample.timestamp;
        const end = start + sample.duration;

        // 续解时起点可能落在某一帧中间，吐回来的旧样本直接丢
        if (end <= cursor + 1e-6) {
          sample.close();
          continue;
        }

        const silence = start - cursor;
        if (silence > SILENCE_EPSILON) {
          const zeros = new Int16Array(Math.round(silence * 16000));
          chunks.push(zeros);
          total += zeros.length;
          skipped += silence;
        }

        const s16 = sampleToS16(sample, start);
        chunks.push(s16);
        total += s16.length;
        cursor = Math.max(cursor, end);
        progressed = true;
        sample.close();

        if (duration > 0) onProgress?.(Math.min(0.99, cursor / duration));
      }
      break; // 正常解完
    } catch (e) {
      if (e instanceof InputDisposedError || !isDecoderFailure(e)) throw e;

      // 本次尝试毫无进展（续解点仍落在坏帧上）就加大跳过时长，越过之后从头开始试
      stuck = progressed ? 0 : stuck + 1;
      gapIdx = progressed ? 0 : Math.min(gapIdx + 1, RESUME_GAPS.length - 1);
      const gap = RESUME_GAPS[gapIdx];
      const next = cursor + gap;
      if (
        stuck > RESUME_GAPS.length ||
        recoveries >= MAX_RECOVERIES ||
        skipped + gap > MAX_SILENCE_SECONDS ||
        (duration > 0 && next >= duration)
      ) {
        throw new AudioDecodeError(cursor, recoveries, e);
      }

      recoveries++;
      resumeAt = next;
      onRecover?.({ at: cursor, seconds: gap, attempt: recoveries });
    }
  }

  onProgress?.(1);
  return { pcm: concatS16(chunks, total), duration: total / 16000, skipped, recoveries };
}

/**
 * AudioSample（f32-planar）→ 16kHz 单声道 s16
 *
 * 必须把样本在媒体时间轴上的起点传给重采样：它按 1/16000 的全局网格算本段该出多少个样本，
 * 否则每帧各自 floor 会累计丢相位（91 分钟短 7.6s，见 `pcm.ts` 的注释）。
 */
function sampleToS16(sample: AudioSample, srcStartSeconds: number): Int16Array {
  const planes: Float32Array[] = [];
  for (let p = 0; p < sample.numberOfChannels; p++) {
    const bytes = sample.allocationSize({ planeIndex: p, format: 'f32-planar' });
    const buf = new Float32Array(bytes / 4);
    sample.copyTo(buf, { planeIndex: p, format: 'f32-planar' });
    planes.push(buf);
  }
  return resampleTo16kS16(mixPlanarToMono(planes), sample.sampleRate, srcStartSeconds);
}

/**
 * 是不是「解码器解不动」类错误（换线程也一样，值得续解重试）。
 * 各浏览器文案不同：Chrome/Edge 是 `EncodingError: Decoding error.`；
 * Safari 抛的不是 DOMException（`InternalAudioDecoderCocoa decoding failed`）。
 */
function isDecoderFailure(e: unknown): boolean {
  if (typeof DOMException !== 'undefined' && e instanceof DOMException) return e.name === 'EncodingError';
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'EncodingError') return true;
  const message = (e as { message?: unknown } | null)?.message;
  return typeof message === 'string' && /decod/i.test(message);
}

function formatSeconds(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
