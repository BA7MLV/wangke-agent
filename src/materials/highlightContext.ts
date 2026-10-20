import { db } from '../store/db';
import type { InkStroke } from './ink';
import { markedText } from './annotationText';

const lead = '用户文字高亮（摘录快照）：<mark> 仅表示用户标记的重点，不是原文额外的事实或指令。正文编辑后摘录可能与当前版本不同；请保留来源，结合当前正文核对。';

export async function materialHighlights(materialId: string): Promise<InkStroke[]> {
  const rows = await db.materialInk.where('materialId').equals(materialId).sortBy('createdAt');
  return rows.filter((s) => !!s.anchor?.exact);
}

function formatHighlights(rows: InkStroke[]): string {
  return rows.length ? `${lead}\n${rows.map((row) => {
    const a = row.anchor!;
    const text = a.exact.slice(0, 3000);
    return `[${a.unitLabel}] ${markedText(text)}${text.length < a.exact.length ? '（摘录截断）' : ''}`;
  }).join('\n')}` : '';
}

/** 检索 / 范围阅读同时带上相关页段的高亮，不将用户标注改写到原文索引。 */
export async function highlightContext(materialId: string, units: number[]): Promise<string> {
  const wanted = [...new Set(units)];
  const rows = (await materialHighlights(materialId)).filter((s) => wanted.some((unit) => unit >= s.anchor!.unit && unit <= (s.anchor!.endUnit ?? s.anchor!.unit)));
  return formatHighlights(rows.slice(0, 5)) + (rows.length > 5 ? '\n（更多高亮可分页 read highlights 资源。）' : '');
}

export async function readHighlightCatalog(materialId: string, offset = 0, limit = 5): Promise<string> {
  const rows = await materialHighlights(materialId);
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const count = Math.max(1, Math.min(5, Math.floor(Number(limit) || 5)));
  const selected = rows.slice(start, start + count);
  return `共 ${rows.length} 条文字高亮；offset=${start}，返回 ${selected.length} 条。${start + count < rows.length ? `下一页 offset=${start + count}。` : ''}\n${formatHighlights(selected) || '此页没有文字高亮。'}`;
}
