import { embed } from '../api/siliconflow';
import { getSettings } from '../store/settings';
import { db, type MaterialBlockRow } from '../store/db';
import { cosine } from './search';
import { fmtUnitRef, type UnitKind } from '../materials/units.ts';

/**
 * 阅读材料的语义检索。
 *
 * 与 `search.ts` 的 `searchTranscript` 严格对称：同样的余弦打分（复用 `cosine`）、
 * 同样的 topK 默认值、同样的「向量 → 原文」两步取数。差异只有两处：
 * 外键是 `materialId`、命中返回的是 `MaterialBlockRow`（带页码/段落号而不是时间戳）。
 *
 * **刻意不复用 `embeddings` 表**：那张表的 `segmentId` 是外键，且检索结果会被
 * `get_transcript_range`、字幕面板按「秒」消费；混进材料会让「秒」与「页」两套语义
 * 相互污染。平行表 + 平行函数，换来的是视频链路一行不用改。
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
  const settings = getSettings();
  const [qv] = await embed(settings, settings.embedModel, [query]);
  const queryVec = new Float32Array(qv);

  const rows = await db.materialEmbeddings.where('materialId').equals(materialId).toArray();
  if (rows.length === 0) return [];
  const blocks = await db.materialBlocks.bulkGet(rows.map((r) => r.blockId));

  const hits: MaterialHit[] = [];
  for (let i = 0; i < rows.length; i++) {
    const b = blocks[i];
    if (!b || !b.text) continue;
    hits.push({ block: b, score: cosine(queryVec, new Float32Array(rows[i].vector)) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
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
