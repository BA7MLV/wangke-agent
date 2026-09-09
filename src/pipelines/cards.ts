import { chatOnce, textOf } from '../api/siliconflow';
import { getSettings } from '../store/settings';
import { db, type SegmentRow } from '../store/db';
import { PROMPTS } from '../harness/prompts';
import { cleanCard, dedupeCards, extractJsonArray, type CardDraft } from '../harness/ankiCard';
import { segmentsToTranscript } from '../handout/docx';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';

export interface CardsProgress {
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

/**
 * Anki 制卡流水线：字幕切块（带上文回顾）→ LLM 出题 → 清洗去重 → 落库（全部待审）。
 * 前提：字幕已生成。整片重生成（与弹幕同款策略），调用方负责在覆盖前向用户确认。
 */
export async function runCards(
  videoId: string,
  onProgress: (p: CardsProgress) => void,
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
    const results: CardDraft[][] = new Array(chunks.length);
    let done = 0;

    await pool(chunks, 2, async (chunk, i) => {
      results[i] = [];
      const range = { start: chunk[0].start, end: chunk[chunk.length - 1].end };
      // 上一块末尾作为上文回顾，帮助模型理解语境（但不针对它制卡）
      const prev = i > 0 ? chunks[i - 1].slice(-3) : [];
      const context = prev.length > 0 ? segmentsToTranscript(prev) : undefined;

      try {
        const msg = await withRetry(() =>
          chatOnce(getSettings(), {
            model: getSettings().llmModel,
            max_tokens: 2000,
            messages: [
              { role: 'user', content: PROMPTS.ankiCards(video.name, segmentsToTranscript(chunk), context) },
            ],
          }),
        );
        for (const item of extractJsonArray(textOf(msg))) {
          const card = cleanCard(item, range);
          if (card) results[i].push(card);
        }
      } catch {
        // 单块失败不阻断整片：该块跳过
      }
      done++;
      onProgress({ done, total: chunks.length, message: `生成卡片 ${done}/${chunks.length} 段` });
    });

    const all = dedupeCards(results.flat());
    const now = Date.now();
    await db.cards.where('videoId').equals(videoId).delete();
    await db.cards.bulkAdd(all.map((c) => ({ videoId, ...c, status: 0 as const, createdAt: now })));
    return all.length;
  } finally {
    await releaseWakeLock();
  }
}
