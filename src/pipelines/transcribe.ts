import { transcribe } from '../api/siliconflow';
import { getSettings } from '../store/settings';
import { db, type SegmentRow } from '../store/db';
import { getVideoFile } from '../store/fileStore';
import { extractAudio16k } from '../media/audio';
import { segmentAudio } from '../media/vad';
import { wavBlob } from '../media/wav';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { AdaptiveLimit, withAdaptiveRetry, adaptivePool } from '../utils/concurrency';

export interface TranscribeProgress {
  phase: 'extract' | 'vad' | 'asr' | 'done';
  done: number;
  total: number;
  message: string;
}

/**
 * 字幕转写流水线：抽音频 → VAD 分段 → 自适应并发调硅基流动 ASR → 写入 segments 表。
 * 支持断点续做：已完成的段（status=1）会跳过；并发按 AIMD 调节，遇限流自动降速。
 */
export async function runTranscription(
  videoId: string,
  onProgress: (p: TranscribeProgress) => void,
): Promise<void> {
  const settings = getSettings();
  if (!settings.apiKey) throw new Error('请先在「设置」中填写硅基流动 API Key');

  const blob = await getVideoFile(videoId);
  const video = await db.videos.get(videoId);
  if (!blob || !video) throw new Error('视频文件不存在');

  await db.videos.update(videoId, { status: 'transcribing' });
  await acquireWakeLock();
  try {
    // 1. 抽取音频
    const { pcm } = await extractAudio16k(blob, video.duration, (ratio) =>
      onProgress({ phase: 'extract', done: ratio, total: 1, message: `抽取音频 ${Math.round(ratio * 100)}%` }),
    );

    // 2. VAD 分段
    onProgress({ phase: 'vad', done: 0, total: 1, message: '语音端点检测中…' });
    const vadSegs = await segmentAudio(pcm);
    if (vadSegs.length === 0) throw new Error('未检测到语音内容');

    // 3. 生成转写计划（保留已完成段，支持续做）
    const doneRows = await db.segments.where('videoId').equals(videoId).filter((r) => r.status === 1).toArray();
    const doneByIdx = new Map(doneRows.map((r) => [r.idx, r]));
    const planMismatch = doneRows.length > 0 && Math.abs(doneRows.length - vadSegs.length) > vadSegs.length * 0.2;

    if (planMismatch) {
      // VAD 结果与已有数据差异过大，清空重来
      await db.segments.where('videoId').equals(videoId).delete();
      doneByIdx.clear();
    }

    const pendingIdx: number[] = [];
    await db.transaction('rw', db.segments, async () => {
      for (let i = 0; i < vadSegs.length; i++) {
        if (doneByIdx.has(i)) continue;
        const existing = await db.segments.where('videoId').equals(videoId).filter((r) => r.idx === i).first();
        const row = { videoId, idx: i, start: vadSegs[i].start, end: vadSegs[i].end, text: '', status: 0 as const };
        if (existing?.id != null) await db.segments.update(existing.id, row);
        else await db.segments.add(row);
        pendingIdx.push(i);
      }
    });

    // 4. 并发转写（AIMD 自适应：初始值来自设置，遇 429 自动降速）
    const limiter = new AdaptiveLimit(settings.asrConcurrency);
    const total = vadSegs.length;
    let done = total - pendingIdx.length;
    const report = () =>
      onProgress({ phase: 'asr', done, total, message: `转写中 ${done}/${total}（并发 ${limiter.current}）` });
    report();

    await adaptivePool(pendingIdx, limiter, async (idx) => {
      const seg = vadSegs[idx];
      const startSample = Math.floor(seg.start * 16000);
      const endSample = Math.min(pcm.length, Math.ceil(seg.end * 16000));
      const blob = wavBlob(pcm.subarray(startSample, endSample));
      const result = await withAdaptiveRetry(() => transcribe(settings, settings.asrModel, blob, `seg-${idx}.wav`), limiter);
      const text = result.text.trim();
      // 句级时间戳（模型返回 verbose_json segments 时）：段内相对 → 媒体绝对时间，clamp 在段区间内
      const cues = result.segments
        ?.map((c) => ({
          start: Math.max(seg.start, seg.start + c.start),
          end: Math.min(seg.end, seg.start + c.end),
          text: c.text,
        }))
        .filter((c) => c.end > c.start);
      const patch: Partial<SegmentRow> = { text, status: 1 };
      if (cues?.length) patch.cues = cues;
      await db.segments
        .where('videoId')
        .equals(videoId)
        .filter((r) => r.idx === idx)
        .modify(patch);
      done++;
      report();
    });

    await db.videos.update(videoId, { status: 'transcribed' });
    onProgress({ phase: 'done', done: total, total, message: '字幕生成完成' });
  } catch (e) {
    await db.videos.update(videoId, { status: 'error' });
    throw e;
  } finally {
    await releaseWakeLock();
  }
}
