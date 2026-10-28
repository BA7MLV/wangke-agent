/** Runtime-neutral text generation shared by the browser and Node task executors. */
import { chatOnce, textOf } from '../api/modelClient.ts';
import type { ModelTarget } from '../api/modelTypes.ts';
import { PROMPTS } from '../harness/prompts.ts';
import { cleanCard, dedupeCards, extractJsonArray, type CardDraft } from '../harness/ankiCard.ts';
import { dedupeThreads, parseCommentThreads, type CommentThreadDraft } from '../harness/comments.ts';
import { AdaptiveLimit, adaptivePool, withAdaptiveRetry } from '../utils/concurrency.ts';
import { fmtTime } from '../utils/vtt.ts';

export interface TextSegment { idx: number; start: number; end: number; text: string; status: number }
export interface TextProgress { done: number; total: number; message: string }
export type TextKind = 'cards' | 'comments' | 'danmaku';
export interface TextResults {
  cards: CardDraft[];
  comments: CommentThreadDraft[];
  danmaku: Array<{ time: number; text: string }>;
}

function chunksOf(segments: TextSegment[]) {
  const chunks: TextSegment[][] = [];
  let chunk: TextSegment[] = [];
  for (const segment of segments) {
    chunk.push(segment);
    if (segment.end - chunk[0].start >= 600) { chunks.push(chunk); chunk = []; }
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

const transcript = (segments: TextSegment[]) => segments.map(s => `[${fmtTime(s.start)}] ${s.text}`).join('\n');

export async function generateText<K extends TextKind>(
  kind: K, name: string, segments: TextSegment[], target: ModelTarget,
  onProgress: (progress: TextProgress) => void, signal?: AbortSignal, fetcher?: typeof fetch,
): Promise<TextResults[K]> {
  const completed = segments.filter(s => s.status === 1 && s.text).sort((a, b) => a.idx - b.idx);
  if (completed.length < 3) throw new Error('请先在「字幕」页生成字幕');
  signal?.throwIfAborted();
  const chunks = chunksOf(completed);
  const results = chunks.map((): TextResults => ({ cards: [], comments: [], danmaku: [] }));
  const limiter = new AdaptiveLimit(2, 1, kind === 'comments' ? 4 : 2);
  let done = 0;
  await adaptivePool(chunks, limiter, async (chunk, i) => {
    signal?.throwIfAborted();
    const range = { start: chunk[0].start, end: chunk[chunk.length - 1].end };
    const previous = i > 0 ? transcript(chunks[i - 1].slice(-3)) : undefined;
    const prompt = kind === 'cards' ? PROMPTS.ankiCards(name, transcript(chunk), previous)
      : kind === 'comments' ? PROMPTS.comments(name, transcript(chunk), previous)
        : PROMPTS.danmaku(name, transcript(chunk), previous);
    try {
      const message = await withAdaptiveRetry(() => chatOnce(target, {
        max_tokens: kind === 'cards' ? 2000 : kind === 'comments' ? 1600 : 1200,
        messages: [{ role: 'user', content: prompt }], signal,
      }, fetcher), limiter, 3, () => !!signal?.aborted, signal);
      const text = textOf(message);
      const { cards, comments, danmaku } = results[i];
      if (kind === 'cards') {
        for (const item of extractJsonArray(text)) { const card = cleanCard(item, range); if (card) cards.push(card); }
      } else if (kind === 'comments') {
        comments.push(...parseCommentThreads(text, range));
      } else {
        for (const item of extractJsonArray(text) as Array<{ time?: unknown; text?: unknown }>) {
          if (!item || typeof item !== 'object') continue;
          const parts = String(item.time ?? '').split(':').map(Number);
          if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n))) continue;
          const time = parts.reduce((total, n) => total * 60 + n, 0);
          const content = String(item.text ?? '').trim().slice(0, 60);
          if (time < 0 || time < range.start - 30 || time > range.end + 30 || content.length < 4) continue;
          danmaku.push({ time, text: content });
        }
      }
    } catch (error) {
      // Preserve the existing partial-success policy, but never swallow cancellation.
      signal?.throwIfAborted();
      if ((error as Error | null)?.name === 'AbortError') throw error;
    }
    done++;
    const label = kind === 'cards' ? '卡片' : kind === 'comments' ? '讨论' : '思考题';
    onProgress({ done, total: chunks.length, message: `生成${label} ${done}/${chunks.length} 段` });
  }, { signal });
  signal?.throwIfAborted();
  const cards = results.flatMap(result => result.cards);
  const comments = results.flatMap(result => result.comments);
  const danmaku = results.flatMap(result => result.danmaku);
  const spaced: TextResults['danmaku'] = [];
  for (const item of danmaku.sort((a, b) => a.time - b.time)) {
    if (!spaced.length || item.time - spaced[spaced.length - 1].time >= 45) spaced.push(item);
  }
  return { cards: dedupeCards(cards), comments: dedupeThreads(comments), danmaku: spaced }[kind] as TextResults[K];
}
