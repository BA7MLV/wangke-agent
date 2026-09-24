/**
 * 阅读材料的识别与解析流水线。
 *
 * 解析 = 抽文本单元 → 归一化分块 → 落 `materialBlocks`。**不含向量化**
 * （那一步是 `pipelines/embedMaterial.ts`，需要 API Key，与解析解耦：
  没有 Key 也能正常阅读，只是问答检索不可用）。
 */

import { db } from '../store/db';
import { getMaterialFile } from '../store/fileStore';
import { chunkUnits, countChars, judgeMaterialText, type MaterialBlock, type RawUnit } from './chunk.ts';
import { isDocxFile, looksLikeLegacyDoc, readDocxUnits } from './docx.ts';
import { extractMdUnits, isMarkdownFile, readMdText } from './md.ts';
import { extractPdfUnits, openPdf } from './pdf.ts';
import type { UnitKind } from './units.ts';

export type MaterialFormat = 'pdf' | 'docx' | 'md';

const MATERIAL_EXTS = new Set(['pdf', 'docx', 'md', 'markdown']);
/** 旧版 .doc（OLE 复合文档）：明确不支持，但要在导入前就拦住并给出可操作的提示 */
const LEGACY_DOC_EXTS = new Set(['doc']);

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * 是不是可读的材料。
 *
 * 注意：**`doc` 也返回 true**，但导入流程要单独识别并拒绝 —— 见 `isLegacyDocFile`。
 * 这里把它当「材料」是为了让调用方能区分「这是文档类文件」与「这是个视频」，
 * 从而给出「请另存为 .docx」而不是「不支持的视频格式」这种驴唇不对马嘴的报错。
 */
export function isMaterialFile(file: { name: string; type?: string }): boolean {
  const ext = extOf(file.name);
  if (MATERIAL_EXTS.has(ext) || LEGACY_DOC_EXTS.has(ext)) return true;
  const t = file.type ?? '';
  return (
    t === 'application/pdf' ||
    isDocxFile({ name: file.name, type: t }) ||
    isMarkdownFile({ name: file.name, type: t }) ||
    t === 'application/msword'
  );
}

export function isLegacyDocFile(file: { name: string; type?: string }): boolean {
  return LEGACY_DOC_EXTS.has(extOf(file.name));
}

/** 从文件名/类型推断格式；`.doc` 会抛错（调用方应先拦） */
export function detectMaterialFormat(file: { name: string; type?: string }): MaterialFormat {
  if (file.type === 'application/pdf' || extOf(file.name) === 'pdf') return 'pdf';
  if (isDocxFile(file)) return 'docx';
  if (isMarkdownFile(file)) return 'md';
  throw new Error(`无法识别的材料格式：${file.name}`);
}

/** 单元类型：PDF 按页、Word 按段 */
export function unitKindOf(format: MaterialFormat): UnitKind {
  return format === 'pdf' ? 'page' : 'para';
}

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
 * 解析材料并落库。
 *
 * 幂等：会先清掉这份材料已存的块，因此「重新解析」是安全的。
 * 没有可检索正文时也会正常返回，`scanned` / `empty` 带出来供 UI 与任务层给话术。
 */
export async function parseMaterial(
  materialId: string,
  format: MaterialFormat,
  onProgress?: (p: MaterialParseProgress) => void,
): Promise<MaterialParseResult> {
  onProgress?.({ phase: 'read', done: 0, total: 1, message: '读取材料文件…' });
  const blob = await getMaterialFile(materialId);
  if (!blob) throw new Error('材料文件不存在（可能已被删除）');

  let units: RawUnit[];
  /** 文档声明的单元总数（PDF 页数 / Word 段落数）。PDF 用它而不是「非空页数」：
   *  阅读器能翻到空白页，库页标签写「120 页」也该是文件的真实页数。 */
  let declaredUnits: number | null = null;
  if (format === 'pdf') {
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    if (looksLikeLegacyDoc(head)) {
      throw new Error('这是旧版 .doc 格式，暂不支持。请在 Word / WPS 里「另存为 .docx」后重新导入。');
    }
    const url = URL.createObjectURL(blob);
    try {
      const doc = await openPdf(url);
      try {
        declaredUnits = doc.numPages;
        units = await extractPdfUnits(doc, ({ page, total }) =>
          onProgress?.({ phase: 'extract', done: page, total, message: `解析第 ${page}/${total} 页` }),
        );
      } finally {
        await doc.destroy();
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  } else if (format === 'md') {
    onProgress?.({ phase: 'extract', done: 0, total: 1, message: '解析 Markdown…' });
    units = extractMdUnits(await readMdText(blob));
  } else {
    onProgress?.({ phase: 'extract', done: 0, total: 1, message: '解析 Word 正文…' });
    units = await readDocxUnits(blob);
  }

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

/** 读某份材料已存好的块（阅读器与检索共用） */
export async function loadMaterialBlocks(materialId: string) {
  return db.materialBlocks.where('materialId').equals(materialId).sortBy('idx');
}
