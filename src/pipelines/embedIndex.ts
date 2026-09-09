import { embed } from '../api/siliconflow';
import { getSettings } from '../store/settings';
import { db } from '../store/db';

export interface EmbedProgress {
  done: number;
  total: number;
  message: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number }).status;
      if (status === 400 || status === 401 || status === 403) throw e; // 不可重试
      await sleep(1000 * 2 ** attempt + Math.random() * 500);
    }
  }
  throw lastErr;
}

const BATCH = 16;

/**
 * 问答 embedding 索引：对已完成字幕段批量向量化，存入 embeddings 表。
 * 断点续做：已有向量的段跳过；字幕重建后自动清理孤儿向量。
 * 返回已索引的总段数。
 */
export async function ensureEmbeddingIndex(
  videoId: string,
  onProgress?: (p: EmbedProgress) => void,
): Promise<number> {
  const settings = getSettings();
  if (!settings.apiKey) throw new Error('请先在「设置」中填写硅基流动 API Key');

  const segments = await db.segments
    .where('videoId')
    .equals(videoId)
    .filter((r) => r.status === 1 && !!r.text)
    .sortBy('idx');
  if (segments.length === 0) throw new Error('请先生成字幕');

  // 清理孤儿向量（字幕重建后旧 segmentId 已失效）
  const validIds = new Set(segments.map((s) => s.id!));
  const existing = await db.embeddings.where('videoId').equals(videoId).toArray();
  const orphanIds = existing.filter((e) => !validIds.has(e.segmentId)).map((e) => e.id!);
  if (orphanIds.length > 0) await db.embeddings.bulkDelete(orphanIds);

  const doneIds = new Set(existing.filter((e) => validIds.has(e.segmentId)).map((e) => e.segmentId));
  const pending = segments.filter((s) => !doneIds.has(s.id!));

  const total = segments.length;
  let done = total - pending.length;
  onProgress?.({ done, total, message: `建立问答索引 ${done}/${total}` });

  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const vectors = await withRetry(() =>
      embed(settings, settings.embedModel, batch.map((s) => s.text)),
    );
    await db.embeddings.bulkAdd(
      batch.map((s, j) => ({
        videoId,
        segmentId: s.id!,
        vector: new Float32Array(vectors[j]).buffer as ArrayBuffer,
      })),
    );
    done += batch.length;
    onProgress?.({ done, total, message: `建立问答索引 ${done}/${total}` });
  }

  return total;
}
