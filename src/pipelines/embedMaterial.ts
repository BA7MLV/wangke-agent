import { embed } from '../api/siliconflow';
import { getSettings } from '../store/settings';
import { db } from '../store/db';
import type { EmbedProgress } from './embedIndex';

/**
 * 材料的问答 embedding 索引。
 *
 * 与 `pipelines/embedIndex.ts` 的 `ensureEmbeddingIndex` 严格对称（同样的批大小、
 * 同样的指数退避重试、同样的断点续做与孤儿清理），只把「已完成字幕段」换成
 * 「材料文本块」。**没有抽成一个泛型函数**是因为两者的取数条件与去重键不同
 * （`status===1` vs 全部块；`segmentId` vs `blockId`），硬合并会变成一堆回调参数，
 * 反而比两份直白的实现更难读。这里保持「形式对称、各自独立」。
 */

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

/** 扫描件没有块，索引会「成功但为 0」，上层据此别提示「索引已就绪」 */
export async function ensureMaterialIndex(
  materialId: string,
  onProgress?: (p: EmbedProgress) => void,
): Promise<number> {
  const settings = getSettings();
  if (!settings.apiKey) throw new Error('请先在「设置」中填写硅基流动 API Key');

  const blocks = await db.materialBlocks.where('materialId').equals(materialId).sortBy('idx');
  if (blocks.length === 0) {
    throw new Error('这份材料没有可检索的文本（可能是扫描件），无法建立问答索引');
  }

  // 清理孤儿向量（材料重新解析后 blockId 已失效）
  const validIds = new Set(blocks.map((b) => b.id!));
  const existing = await db.materialEmbeddings.where('materialId').equals(materialId).toArray();
  const orphanIds = existing.filter((e) => !validIds.has(e.blockId)).map((e) => e.id!);
  if (orphanIds.length > 0) await db.materialEmbeddings.bulkDelete(orphanIds);

  const doneIds = new Set(existing.filter((e) => validIds.has(e.blockId)).map((e) => e.blockId));
  const pending = blocks.filter((b) => !doneIds.has(b.id!));

  const total = blocks.length;
  let done = total - pending.length;
  onProgress?.({ done, total, message: `建立材料索引 ${done}/${total}` });

  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const vectors = await withRetry(() =>
      embed(settings, settings.embedModel, batch.map((b) => b.text)),
    );
    await db.materialEmbeddings.bulkAdd(
      batch.map((b, j) => ({
        materialId,
        blockId: b.id!,
        vector: new Float32Array(vectors[j]).buffer as ArrayBuffer,
      })),
    );
    done += batch.length;
    onProgress?.({ done, total, message: `建立材料索引 ${done}/${total}` });
  }

  return total;
}

/** 已有多少块建好了向量（ChatPanel 判断「问答索引就绪」用，与字幕的 indexReady 对称） */
export async function materialIndexCount(materialId: string): Promise<number> {
  return db.materialEmbeddings.where('materialId').equals(materialId).count();
}
