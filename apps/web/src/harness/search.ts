import { db, type SegmentRow } from '../store/db';
import { lexicalSearch } from './lexical';

export interface SearchHit {
  segment: SegmentRow;
  score: number;
}

/** 默认召回条数。与原稠密检索的 topK 一致，回答风格不变 */
const DEFAULT_TOP_K = 6;

/**
 * 字幕检索（词法 / BM25）。
 *
 * **2026-09-24：稠密向量检索已整体移除。** 这里原来会向量化 query、与库内
 * `embeddings` 逐条算余弦。去掉的理由与取舍见
 * docs/plans/2026-09-23-context-engineering-design.md §1.6 —— 一句话是：
 * 消费检索结果的是工具循环里的强 LLM，词汇鸿沟搬到了它身上，不再需要检索器预筛。
 *
 * 副作用有两处，都是好的：
 * 1. **不需要 API key 也不需要索引。** 原来没有 key 就直接抛错、完全无法检索；
 *    现在扫描即可，离线可用。那条「等待索引就绪」的门禁也随之消失。
 * 2. **不存在索引过期。** 没有索引就没有「索引与内容不一致」这一整类 bug。
 *
 * ⚠️ 词法检索的召回质量**取决于查询里的用词是否出现在原文**。所以工具描述里
 * 要求模型传关键词而不是整句（见 `tools.ts` 的 `search_transcript`）——
 * 传一整句自然语言会退化成「命中了几个常用字」的噪声排序。
 */
export async function searchTranscript(
  videoId: string,
  query: string,
  topK = DEFAULT_TOP_K,
): Promise<SearchHit[]> {
  const rows = await db.segments
    .where('videoId')
    .equals(videoId)
    // 只检索转写完成且有正文的段（与字幕面板、格式化层的口径一致）
    .filter((r) => r.status === 1 && !!r.text)
    .sortBy('idx');
  if (rows.length === 0) return [];
  return lexicalSearch(rows, (r) => r.text, query, topK).map((h) => ({
    segment: h.doc,
    score: h.score,
  }));
}
