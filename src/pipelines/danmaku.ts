import { chatOnce, textOf } from '../api/siliconflow';
import { getSettings } from '../store/settings';
import { db, type SegmentRow } from '../store/db';
import { PROMPTS } from '../harness/prompts';
import { segmentsToTranscript } from '../handout/docx';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';

export interface DanmakuProgress {
  done: number;
  total: number;
  message: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number }).status;
      if (status === 400 || status === 401 || status === 403) throw e;
      await sleep(1000 * 2 ** i + Math.random() * 500);
    }
  }
  throw lastErr;
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    }),
  );
}

function parseTimeToSec(t: string): number {
  const parts = t.trim().split(':').map(Number);
  if (parts.some(isNaN)) return -1;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return -1;
}

/** 从 LLM 输出中稳健提取 JSON 数组 */
function extractJsonArray(text: string): unknown[] {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
  return Array.isArray(parsed) ? parsed : [];
}

/** 按时间跨度切块（每块约 spanSec 秒），保持字幕顺序 */
function chunkSegments(segs: SegmentRow[], spanSec = 600): SegmentRow[][] {
  const chunks: SegmentRow[][] = [];
  let cur: SegmentRow[] = [];
  let curStart = 0;
  for (const s of segs) {
    if (cur.length === 0) curStart = s.start;
    cur.push(s);
    if (s.end - curStart >= spanSec) {
      chunks.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

interface RawItem {
  time?: unknown;
  text?: unknown;
}

/**
 * 思考题弹幕流水线：字幕切块（带上文回顾）→ LLM 出题 → 校验去重 → 落库。
 * 前提：字幕已生成。整片重生成（数量小、成本低，不做断点续做）。
 */
export async function runDanmaku(
  videoId: string,
  onProgress: (p: DanmakuProgress) => void,
): Promise<number> {
  const settings = getSettings();
  if (!settings.apiKey) throw new Error('请先在「设置」中填写硅基流动 API Key');

  const video = await db.videos.get(videoId);
  if (!video) throw new Error('视频不存在');
  const segments = await db.segments.where('videoId').equals(videoId).sortBy('idx');
  const doneSegs = segments.filter((s) => s.status === 1 && s.text);
  if (doneSegs.length < 3) throw new Error('请先在「字幕」页生成字幕');

  await acquireWakeLock();
  try {
    const chunks = chunkSegments(doneSegs);
    const results: { time: number; text: string }[][] = new Array(chunks.length);
    let done = 0;

    await pool(chunks, 2, async (chunk, i) => {
      results[i] = [];
      const chunkStart = chunk[0].start;
      const chunkEnd = chunk[chunk.length - 1].end;
      // 上一块末尾作为上文回顾，帮助模型跨知识点串联（但不针对它出题）
      const prev = i > 0 ? chunks[i - 1].slice(-3) : [];
      const context = prev.length > 0 ? segmentsToTranscript(prev) : undefined;

      try {
        const msg = await withRetry(() =>
          chatOnce(getSettings(), {
            model: getSettings().llmModel,
            max_tokens: 1200,
            messages: [
              { role: 'user', content: PROMPTS.danmaku(video.name, segmentsToTranscript(chunk), context) },
            ],
          }),
        );
        const raw = extractJsonArray(textOf(msg)) as RawItem[];
        for (const item of raw) {
          const time = parseTimeToSec(String(item.time ?? ''));
          const text = String(item.text ?? '').trim().slice(0, 60);
          if (time < 0 || text.length < 4) continue;
          // 时间戳钳制：必须落在本块范围内（±30s 容差）
          if (time < chunkStart - 30 || time > chunkEnd + 30) continue;
          results[i].push({ time, text });
        }
      } catch {
        // 单块失败不阻断整片：该块跳过（弹幕是锦上添花）
      }
      done++;
      onProgress({ done, total: chunks.length, message: `生成思考题 ${done}/${chunks.length} 段` });
    });

    // 汇总排序 + 最小间隔去重（块边界可能各出一条挨得很近的；与上一条已保留的比较）
    const sorted = results.flat().sort((a, b) => a.time - b.time);
    const all: { time: number; text: string }[] = [];
    for (const item of sorted) {
      if (all.length === 0 || item.time - all[all.length - 1].time >= 45) all.push(item);
    }

    await db.danmakus.where('videoId').equals(videoId).delete();
    await db.danmakus.bulkAdd(all.map((d) => ({ videoId, time: d.time, text: d.text })));
    return all.length;
  } finally {
    await releaseWakeLock();
  }
}
