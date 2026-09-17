/**
 * Word（.docx）纯文本抽取。
 *
 * **刻意与渲染分离**：渲染走 `docxView.ts`（docx-preview，需要 DOM），
 * 这里只做「zip → word/document.xml → 段落/表格文本」的纯字符串处理，
 * 因此能被 `node scripts/test-material-docx.mjs` 直接 import 测试。
 * 这与 `anki/apkgCore.ts`（Node 可测核心）+ `anki/apkg.ts`（浏览器封装）的分工一致。
 *
 * 约束：不依赖 DOM，相对导入带 `.ts` 扩展名。
 */

import { unzipSync } from 'fflate';
import type { RawUnit } from './chunk.ts';

/** .docx 的 MIME */
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** OLE 复合文档魔数（旧版 .doc）：D0 CF 11 E0 A1 B1 1A E1 */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** ZIP 魔数（.docx 本质是 zip）：PK\x03\x04 */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function isDocxFile(file: { name: string; type?: string }): boolean {
  if (file.type === DOCX_MIME) return true;
  return file.name.toLowerCase().endsWith('.docx');
}

/** 旧版 .doc（OLE 复合文档）：解析要另写一套 OLE 读取，一期明确不支持，但要给出可操作的提示 */
export function looksLikeLegacyDoc(head: Uint8Array): boolean {
  return OLE_MAGIC.every((b, i) => head[i] === b);
}

function isZip(head: Uint8Array): boolean {
  if (OLE_MAGIC.every((b, i) => head[i] === b)) return false;
  return ZIP_MAGIC.every((b, i) => head[i] === b);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/** 解 XML 实体（`&amp;` / `&#x4e2d;` / `&#20013;`），Word 正文里的 `&`、引号都靠它还原 */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

/** 正文里一个「行内片段」：文本、制表符、换行 */
const INLINE_RE =
  /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:br(?:\s[^>]*)?\/>|<w:cr(?:\s[^>]*)?\/>|<w:noBreakHyphen(?:\s[^>]*)?\/>/g;

/** 取一个 `<w:p>` / `<w:tc>` 片段里的纯文本（`<w:tab/>`→制表符、`<w:br/>`→换行） */
function inlineText(fragment: string): string {
  let out = '';
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(fragment)) !== null) {
    const whole = m[0];
    if (m[1] !== undefined) out += decodeXmlEntities(m[1]);
    else if (whole.startsWith('<w:tab')) out += '\t';
    else if (whole.startsWith('<w:br') || whole.startsWith('<w:cr')) out += '\n';
    else if (whole.startsWith('<w:noBreakHyphen')) out += '-';
  }
  return out;
}

/**
 * 段落样式 → 标题层级。
 *
 * Word 的标题样式 id 取决于模板语言与版本，实测至少这三种写法都要认：
 * 英文模板 `Heading1`、中文模板 `标题 1`、以及把样式 id 直接写成 `1`~`9` 的模板。
 * 另有 `w:outlineLvl`（大纲级别）更可靠，优先用它。
 */
function headingLevel(p: string): number | null {
  const outline = /<w:outlineLvl\s+w:val="(\d)"/.exec(p);
  if (outline) {
    const lvl = Number(outline[1]);
    if (lvl >= 0 && lvl <= 8) return lvl + 1;
  }
  const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(p);
  if (!style) return null;
  const val = style[1].trim();
  const en = /^Heading\s*([1-9])$/i.exec(val);
  if (en) return Number(en[1]);
  const zh = /^标题\s*([1-9])$/.exec(val);
  if (zh) return Number(zh[1]);
  if (/^[1-9]$/.test(val)) return Number(val);
  return null;
}

/** 顶层块：表格（整体一块）或段落。表格放在前面，优先整体匹配 */
const BLOCK_RE =
  /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

const ROW_RE = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
const CELL_RE = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
const CELL_P_RE = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

/** 表格 → `A | B` 每行一条（整表仍算一个单元，`kind: 'table'`） */
function tableText(tbl: string): string {
  const rows: string[] = [];
  let rm: RegExpExecArray | null;
  ROW_RE.lastIndex = 0;
  while ((rm = ROW_RE.exec(tbl)) !== null) {
    const cells: string[] = [];
    let cm: RegExpExecArray | null;
    CELL_RE.lastIndex = 0;
    while ((cm = CELL_RE.exec(rm[0])) !== null) {
      // 一个单元格里可能有多段，拼成一行
      const parts: string[] = [];
      let pm: RegExpExecArray | null;
      CELL_P_RE.lastIndex = 0;
      while ((pm = CELL_P_RE.exec(cm[0])) !== null) {
        const t = inlineText(pm[0]).replace(/\s+/g, ' ').trim();
        if (t) parts.push(t);
      }
      cells.push(parts.join(' '));
    }
    if (cells.some((c) => c)) rows.push(cells.join(' | '));
  }
  return rows.join('\n');
}

/**
 * `word/document.xml` → 文本单元。
 *
 * `unit` 是**非空块**的序号（1 起），不是 XML 里的位置 —— 空段落不占号，
 * 这样「第 N 段」对用户可见的段落编号是连续的。
 */
export function extractDocxUnitsFromXml(xml: string): RawUnit[] {
  const body = /<w:body(?:\s[^>]*)?>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const units: RawUnit[] = [];
  let section: string | undefined;
  let m: RegExpExecArray | null;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(body)) !== null) {
    const block = m[0];
    if (block.startsWith('<w:tbl')) {
      const text = tableText(block);
      if (text) units.push({ unit: units.length + 1, text, kind: 'table', section });
      continue;
    }
    const text = inlineText(block).replace(/\n{2,}/g, '\n').trim();
    if (!text) continue;
    const level = headingLevel(block);
    if (level !== null) {
      section = text;
      units.push({ unit: units.length + 1, text, kind: 'title', section });
    } else {
      units.push({ unit: units.length + 1, text, kind: 'body', section });
    }
  }
  return units;
}

/**
 * 读 .docx 的文本单元。
 *
 * `filter` 只解 `word/document.xml` —— .docx 里图片能占 90% 体积，
 * 整包解压会白读几十 MB（fflate 的 filter 在 inflate 前就跳过，是真正省下来的）。
 */
export async function readDocxUnits(blob: Blob): Promise<RawUnit[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (looksLikeLegacyDoc(bytes)) {
    throw new Error('这是旧版 .doc 格式，暂不支持。请在 Word / WPS 里「另存为 .docx」后重新导入。');
  }
  if (!isZip(bytes)) throw new Error('文件不是有效的 .docx（不是 ZIP 包，可能已损坏）。');
  const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  const docXml = files['word/document.xml'];
  if (!docXml) {
    throw new Error('文件不是有效的 .docx（缺少 word/document.xml）。若是 .doc 请先另存为 .docx。');
  }
  const xml = new TextDecoder('utf-8').decode(docXml);
  return extractDocxUnitsFromXml(xml);
}
