import { db, type MaterialBlockRow } from '../store/db';
import { lexicalSearch } from './lexical';
import { fmtUnitRef, type UnitKind } from '../materials/units.ts';

/**
 * 阅读材料的检索。
 *
 * 与 `search.ts` 的 `searchTranscript` 严格对称：同一套词法打分（复用 `lexicalSearch`）、
 * 同样的 topK 默认值。差异只有两处：外键是 `materialId`、命中返回的是
 * `MaterialBlockRow`（带页码 / 段落号而不是时间戳）。
 *
 * **与字幕分属两张平行的文本表**（`materialBlocks` vs `segments`），刻意不合并：
 * 字幕的 `start`/`end` 是**秒**，会被 `get_transcript_range`、字幕面板按时间轴消费；
 * 材料的 `unit` 是页 / 段。把页码塞进秒字段会让两套语义互相污染。
 * 检索打分本身是共用的，取数条件各写一份（`status === 1` vs 全部块），
 * 硬合并会变成一堆回调参数，反而更难读。
 *
 * 2026-09-24：原本的 `materialEmbeddings` 稠密检索已移除，同 `search.ts` 的理由。
 */

export interface MaterialHit {
  block: MaterialBlockRow;
  score: number;
}

/** topK 默认与字幕检索一致，便于两边的回答风格对齐 */
export const DEFAULT_MATERIAL_TOP_K = 6;

export async function searchMaterial(
  materialId: string,
  query: string,
  topK = DEFAULT_MATERIAL_TOP_K,
): Promise<MaterialHit[]> {
  const blocks = await db.materialBlocks.where('materialId').equals(materialId).sortBy('idx');
  if (blocks.length === 0) return [];
  return lexicalSearch(blocks, (b) => b.text, query, topK).map((h) => ({
    block: h.doc,
    score: h.score,
  }));
}

/** 按单元范围取原文（`get_material_range` 工具用）：闭区间 [from, to] */
export async function materialRange(
  materialId: string,
  from: number,
  to: number,
): Promise<MaterialBlockRow[]> {
  const lo = Math.max(1, Math.floor(from));
  const hi = Math.max(lo, Math.floor(to));
  const rows = await db.materialBlocks.where('materialId').equals(materialId).sortBy('idx');
  return rows.filter((r) => r.unit >= lo && r.unit <= hi);
}

/** 命中 → 给模型看的文本。格式与字幕检索的 `[mm:ss] 文本` 对齐，只把时间戳换成页/段号 */
export function formatMaterialHits(hits: MaterialHit[], kind: UnitKind): string {
  return hits.map((h) => `[${fmtUnitRef(kind, h.block.unit)}] ${h.block.text}`).join('\n');
}

/** 范围取数 → 给模型看的文本 */
export function formatMaterialRange(rows: MaterialBlockRow[], kind: UnitKind): string {
  return rows.map((r) => `[${fmtUnitRef(kind, r.unit)}] ${r.text}`).join('\n');
}
