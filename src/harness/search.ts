import { embed } from '../api/siliconflow';
import { getSettings } from '../store/settings';
import { db, type SegmentRow } from '../store/db';

export interface SearchHit {
  segment: SegmentRow;
  score: number;
}

/**
 * 余弦相似度。导出给 `searchMaterial` 复用 —— 材料检索与字幕检索走**同一套打分**，
 * 免得两边各写一份、日后调参只改一处。
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** 语义检索：query 向量化后与库内字幕向量算余弦相似度，返回 top-K 字幕段 */
export async function searchTranscript(videoId: string, query: string, topK = 6): Promise<SearchHit[]> {
  const settings = getSettings();
  const [qv] = await embed(settings, settings.embedModel, [query]);
  const queryVec = new Float32Array(qv);

  const rows = await db.embeddings.where('videoId').equals(videoId).toArray();
  if (rows.length === 0) return [];
  const segs = await db.segments.bulkGet(rows.map((r) => r.segmentId));

  const hits: SearchHit[] = [];
  for (let i = 0; i < rows.length; i++) {
    const seg = segs[i];
    if (!seg || !seg.text) continue;
    hits.push({ segment: seg, score: cosine(queryVec, new Float32Array(rows[i].vector)) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}
