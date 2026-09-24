import { chatOnce, textOf } from '../api/siliconflow';
import { getSettings } from '../store/settings';
import { db, type SegmentRow } from '../store/db';
import { PROMPTS } from '../harness/prompts';
import { segmentsToTranscript } from '../handout/docx';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { AdaptiveLimit, adaptivePool, withAdaptiveRetry } from '../utils/concurrency';
import { dedupeThreads, parseCommentThreads, type CommentThreadDraft } from '../harness/comments';

export interface CommentsProgress {
  done: number;
  total: number;
  message: string;
}

/** 切块跨度（秒）。与弹幕一致，方便两边的「这段讲了什么」对齐 */
const CHUNK_SPAN_SEC = 600;

/** 并发初值。评论区每块要出的内容比弹幕长（一条串含 2~4 条发言），压到 2 更稳 */
const CONCURRENCY = 2;

/**
 * 按时间跨度切块，保持字幕顺序。
 *
 * ⚠️ 这是**第三份**同名实现（另两份在 `pipelines/danmaku.ts` 与 `pipelines/cards.ts`）。
 * 本次没有一并收敛到公共模块，是刻意的取舍：那两条链路已各自回归过，为一个 15 行的纯函数
 * 去动它们，风险和收益不成比例。哪天要收敛，落点建议 `pipelines/jobKit.ts`
 * （连同那两份里的 `withRetry` / `pool` 一起搬 —— 新版评论流水线已经改用
 * `utils/concurrency` 的 AIMD 版本，不再需要那对函数）。
 */
function chunkSegments(segs: SegmentRow[], spanSec = CHUNK_SPAN_SEC): SegmentRow[][] {
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
 * 评论区流水线：字幕切块（带上文回顾）→ LLM 产出讨论串 → 清洗去重 → 落库。
 * 前提：字幕已生成。整片重生成（不做断点续做，与弹幕一致）。
 *
 * 单块失败**不阻断整片**：评论区是锦上添花，为了一个块失败让两小时的课一条都看不到
 * 是本末倒置。所以捕获写在 fn 内部（而不是用 `adaptivePool` 的 failFast:false ——
 * 那条路会在池排空后把首个错误抛出来，等于照样整片失败）。
 */
export async function runComments(
  videoId: string,
  onProgress: (p: CommentsProgress) => void,
): Promise<{ threads: number; posts: number }> {
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
    const results: CommentThreadDraft[][] = new Array(chunks.length);
    const limiter = new AdaptiveLimit(CONCURRENCY, 1, 4);
    let done = 0;

    await adaptivePool(chunks, limiter, async (chunk, i) => {
      results[i] = [];
      const chunkStart = chunk[0].start;
      const chunkEnd = chunk[chunk.length - 1].end;
      // 上一块末尾作为上文回顾，帮助模型跨知识点串联（但不针对它生成讨论）
      const prev = i > 0 ? chunks[i - 1].slice(-3) : [];
      const context = prev.length > 0 ? segmentsToTranscript(prev) : undefined;

      try {
        const msg = await withAdaptiveRetry(
          () =>
            chatOnce(getSettings(), {
              model: getSettings().llmModel,
              max_tokens: 1600,
              messages: [
                {
                  role: 'user',
                  content: PROMPTS.comments(video.name, segmentsToTranscript(chunk), context),
                },
              ],
            }),
          limiter,
        );
        results[i] = parseCommentThreads(textOf(msg), { start: chunkStart, end: chunkEnd });
      } catch {
        // 单块失败不阻断整片（弹幕同款）：该块跳过，其余照常
      }
      done++;
      onProgress({ done, total: chunks.length, message: `生成讨论 ${done}/${chunks.length} 段` });
    });

    const threads = dedupeThreads(results.flat());
    const stats = await saveComments(videoId, threads);
    return stats;
  } finally {
    await releaseWakeLock();
  }
}

/**
 * 整体替换某视频的评论。
 *
 * 两阶段写入（先主贴拿自增 id、再写回复）而不是 `bulkAdd` + `allKeys: true`：
 * 评论总量只有几十行，顺序 `add` 的代价可以忽略，但「父 id 一定拿得到」是硬保证 ——
 * 拿不到的话回复会变成孤儿（展示层会把它们提升为主贴，白白打乱结构）。
 */
async function saveComments(
  videoId: string,
  threads: readonly CommentThreadDraft[],
): Promise<{ threads: number; posts: number }> {
  const now = Date.now();
  let posts = 0;
  await db.transaction('rw', db.comments, async () => {
    await db.comments.where('videoId').equals(videoId).delete();
    let seq = 0;
    for (const t of threads) {
      const parentId = await db.comments.add({
        videoId,
        time: t.time,
        author: t.author,
        role: t.role,
        text: t.text,
        createdAt: now + seq++,
      });
      posts++;
      for (const r of t.replies) {
        await db.comments.add({
          videoId,
          time: t.time,
          author: r.author,
          role: r.role,
          text: r.text,
          parentId,
          createdAt: now + seq++,
        });
        posts++;
      }
    }
  });
  return { threads: threads.length, posts };
}
