/**
 * 材料的「块重建」：文本单元 → 归一化分块 → 重建 `materialBlocks`。
 *
 * ── 为什么从 parse.ts 里拆出来 ────────────────────────────────────────────────
 * 只有一个理由，而且是依赖链上的理由：`parse.ts` 顶部静态 import 了 `./pdf.ts`
 * （pdfjs-dist，2MB+），而材料阅读器那边是刻意让 pdfjs 保持懒加载的（README 有警告）。
 * 从 md 编辑落盘这条链路 import `parse.ts`，等于让「编辑一篇 md」的代价变成
 * 「先加载一个 pdf 阅读器」。把 `parseMaterial` 的尾巴整段搬到这里，
 * 导入时解析与编辑后落盘两条路径共用同一份重建逻辑。
 *
 * **为什么不是再写一份 md 专用的**：块重建不是一个「分块」动作，而是整套要保持一致的判定 ——
 * `scanned` / `empty` 怎么判、`unitCount` 用声明值还是实得值、
 * 重新解析时怎么把上次留下的标记恢复掉（`scanned: scanned ? 1 : undefined` 那一行）。
 * 这些每一条都踩过坑，写第二份必然漂移：导入路径判成「空文档」的文档，
 * 编辑路径可能判成「正常」，同一份 md 在库里带着两套互相矛盾的标记，
 * 而读者只能看到其中一套。
 *
 * 依赖全部 DOM 无关（db + chunk/units），相对导入带 `.ts`。
 */

import { db } from '../store/db';
import { chunkUnits, countChars, judgeMaterialText, type MaterialBlock, type RawUnit } from './chunk.ts';
import type { UnitKind } from './units.ts';

export type MaterialFormat = 'pdf' | 'docx' | 'md' | 'html';

export interface MaterialParseProgress {
  /** read=读文件，extract=抽文本 */
  phase: 'read' | 'extract';
  done: number;
  total: number;
  message: string;
}

export interface MaterialParseResult {
  unitCount: number;
  blockCount: number;
  totalChars: number;
  /** 判定为扫描件（仅 PDF：有页面但无文本层）：不建索引，只能划词/框选提问 */
  scanned: boolean;
  /** 没有任何正文单元（空文档 / 只有图片的 Word）：同样不建索引，但话术与扫描件不同 */
  empty: boolean;
}

/**
 * 单元类型：PDF 按页、Word / Markdown / HTML 按段。
 *
 * 与 `MaterialFormat` 一起住在这里：重建块必须知道按什么口径分块，
 * 而 `MaterialFormat` 的声明在上面 —— 把这个映射留在 parse.ts 会让本文件
 * 反向依赖它（成环），复制一份则迟早漂移（页标签变段标签，检索引用跟着指错）。
 */
export function unitKindOf(format: MaterialFormat): UnitKind {
  return format === 'pdf' ? 'page' : 'para';
}

/**
 * 用给定单元重建某份材料的检索块（幂等：先清后建，可反复调用）。
 *
 * 与 `parseMaterial` 的分工：本函数**只管块**，「文件怎么变成单元」交给调用方 ——
 * parseMaterial 从 blob 抽，编辑落盘从编辑器里的纯文本抽。
 *
 * `declaredUnits` 是「文档自称的单元总数」（PDF 的真实页数，含空白页），只有 PDF 有；
 * 其余格式传 `null`，落到「实得的有内容单元数」。
 *
 * 返回值里的 `scanned` / `empty` 不只是给 UI 看：它们决定这份材料能不能被检索到，
 * 调用方必须照着给话术（把空 Word 说成「扫描件」是错话，见 chunk.ts 的 judgeMaterialText）。
 */
export async function reindexMaterial(
  materialId: string,
  format: MaterialFormat,
  units: RawUnit[],
  declaredUnits: number | null,
): Promise<MaterialParseResult> {
  const blocks: MaterialBlock[] = chunkUnits(units, unitKindOf(format));
  const totalChars = countChars(blocks);
  // 「有没有可检索正文」用「有内容的单元数」当分母：PDF 声明 300 页但后 50 页是空白时，
  // 拿 300 当分母会把页均字数稀释到误判扫描件。
  // 判定必须把 format 一起传进去 —— 扫描件那条规则只对 PDF 成立，理由见 judgeMaterialText。
  const contentUnits = new Set(blocks.map((b) => b.unit)).size;
  const { scanned, empty } = judgeMaterialText(format, totalChars, contentUnits);
  const unitCount = declaredUnits ?? contentUnits;

  await db.transaction('rw', db.materialBlocks, db.videos, async () => {
    const old = await db.materialBlocks.where('materialId').equals(materialId).toArray();
    if (old.length > 0) await db.materialBlocks.bulkDelete(old.map((b) => b.id!));
    if (blocks.length > 0) {
      await db.materialBlocks.bulkAdd(blocks.map((b) => ({ ...b, materialId })));
    }
    await db.videos.update(materialId, {
      unitCount,
      // 重新解析一份原本被误判为扫描件的文件时要能恢复：明确写 undefined 而不是跳过
      scanned: scanned ? 1 : undefined,
      empty: empty ? 1 : undefined,
    });
  });

  return { unitCount, blockCount: blocks.length, totalChars, scanned, empty };
}