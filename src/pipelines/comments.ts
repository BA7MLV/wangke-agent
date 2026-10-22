import { remoteTasks } from '../cloud/state';
import { runCloudTask } from '../cloud/tasks';
import { getSettings, targetOfSlot } from '../store/settings';
import { db } from '../store/db';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import type { CommentThreadDraft } from '../harness/comments';
import { generateText } from './textGeneration';

export interface CommentsProgress {
  done: number;
  total: number;
  message: string;
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
  if (remoteTasks()) return runCloudTask('comments', `course:${videoId}`, { videoId }, onProgress);
  const target = targetOfSlot(getSettings(), 'chat');

  const video = await db.videos.get(videoId);
  if (!video) throw new Error('视频不存在');
  const segments = await db.segments.where('videoId').equals(videoId).sortBy('idx');
  const doneSegs = segments.filter((s) => s.status === 1 && s.text);
  if (doneSegs.length < 3) throw new Error('请先在「字幕」页生成字幕');

  await acquireWakeLock();
  try {
    const threads = await generateText('comments', video.name, doneSegs, target, onProgress);
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
