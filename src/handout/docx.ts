/** DOCX 组装层：封面 / 目录 / 正文三节结构 + 页眉页脚 + 打包后补丁 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  TableOfContents,
  TextRun,
  type Table,
} from 'docx';
import { unzipSync, zipSync } from 'fflate';
import type { SegmentRow } from '../store/db';
import { fmtTime } from '../utils/vtt';
import type { Block } from './ir';
import { renderSectionBlocks, type HandoutImages } from './render';
import {
  FIRSTLINE_CHARS_XML,
  FIRSTLINE_PLACEHOLDER,
  FONT,
  INDENT_2CH,
  LINE_EXACT_28,
  PAGE_SETUP,
  SIZE,
  h1Num,
} from './styles';

export interface HandoutSection {
  heading: string;
  blocks: Block[];
}

export interface HandoutDoc {
  title: string;
  /** 课程名（封面用） */
  courseName: string;
  /** 成文日期，如「2026年9月7日」 */
  date: string;
  summary: string;
  sections: HandoutSection[];
  /** ts(秒) → 图片数据 */
  images: HandoutImages;
}

function infoPara(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: LINE_EXACT_28,
    children: [new TextRun({ text, font: FONT.coverInfo, size: SIZE.body })],
  });
}

/** 公文页码段落：四号宋体「— n —」，奇页居右空一字、偶页居左空一字 */
function pageNumPara(odd: boolean): Paragraph {
  const num = () => new TextRun({ children: [PageNumber.CURRENT], font: FONT.pageNum, size: SIZE.pageNum });
  const dash = (t: string) => new TextRun({ text: t, font: FONT.pageNum, size: SIZE.pageNum });
  return new Paragraph({
    alignment: odd ? AlignmentType.RIGHT : AlignmentType.LEFT,
    children: odd ? [dash('— '), num(), dash(' —'), dash('　')] : [dash('　'), dash('— '), num(), dash(' —')],
  });
}

/** 页眉：讲义标题五号宋体居中 + 下细线（版记线风格） */
function headerPara(title: string): Header {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } },
        children: [new TextRun({ text: title, font: FONT.header, size: SIZE.header })],
      }),
    ],
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * TOC 域占位内容（域结果缓存，Word 自身保存 docx 时的做法）：
 * separate..end 之间预放章节清单 + 提示行——docx-preview / Quick Look / Pages 等
 * 不执行域的查看器也能看到目录；Word/WPS 打开时更新域，占位被真目录（带页码）替换。
 */
function tocPlaceholderXml(doc: HandoutDoc): string {
  const entry = (text: string) =>
    `<w:p><w:pPr><w:widowControl/><w:spacing w:line="560" w:lineRule="exact"/><w:ind w:firstLineChars="200"/></w:pPr>` +
    `<w:r><w:rPr><w:sz w:val="32"/><w:szCs w:val="32"/><w:rFonts w:ascii="Times New Roman" w:eastAsia="仿宋_GB2312" w:hAnsi="Times New Roman"/></w:rPr>` +
    `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
  const hint =
    `<w:p><w:pPr><w:spacing w:before="240"/><w:jc w:val="center"/></w:pPr>` +
    `<w:r><w:rPr><w:color w:val="808080"/><w:sz w:val="21"/><w:szCs w:val="21"/>` +
    `<w:rFonts w:ascii="Times New Roman" w:eastAsia="楷体_GB2312" w:hAnsi="Times New Roman"/></w:rPr>` +
    `<w:t xml:space="preserve">（页码将在 Word / WPS 中打开后自动生成）</w:t></w:r></w:p>`;
  return doc.sections.map((s, i) => entry(`${h1Num(i)}、${s.heading}`)).join('') + hint;
}

/** 把占位段落注入 TOC 域的 separate 之后（end 之前）；结构不符时静默降级 */
function injectTocPlaceholder(xml: string, placeholder: string): string {
  const m = xml.match(/<w:instrText[^>]*>TOC [^<]*<\/w:instrText><w:fldChar w:fldCharType="separate"\/><\/w:r><\/w:p>/);
  if (!m) return xml;
  return xml.replace(m[0], m[0] + placeholder);
}

/**
 * 打包后处理：
 * ① 首行缩进补丁——docx 库不支持 OOXML 的 w:firstLineChars（字符单位），
 *   生成时用 640 缇占位，此处替换为 firstLineChars="200"（= 2 字符），字号变化时缩进依然精确；
 * ② TOC 域占位注入——非 Word 查看器也能看到目录章节清单。
 */
async function postProcessDocx(blob: Blob, doc: HandoutDoc): Promise<Blob> {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const key = 'word/document.xml';
  let xml = new TextDecoder().decode(files[key]);
  xml = xml.replace(FIRSTLINE_PLACEHOLDER, FIRSTLINE_CHARS_XML);
  xml = injectTocPlaceholder(xml, tocPlaceholderXml(doc));
  files[key] = new TextEncoder().encode(xml);
  const zipped = zipSync(files);
  return new Blob([zipped as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

/** 生成公文格式讲义 DOCX 并打包为 Blob */
export async function buildHandoutDocx(doc: HandoutDoc): Promise<Blob> {
  // 第一节：封面（不编页码）
  const cover = {
    properties: { page: PAGE_SETUP },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 2240, after: 960 },
        children: [new TextRun({ text: doc.title, font: FONT.title, size: SIZE.title })],
      }),
      infoPara(`课程：${doc.courseName}`),
      infoPara(doc.date),
    ],
  };

  // 第二节：目录（不编页码；TOC 域在 Word/WPS 打开时自动生成页码）
  const toc = {
    properties: { page: PAGE_SETUP },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 480 },
        children: [new TextRun({ text: '目　录', font: FONT.tocTitle, size: SIZE.tocTitle })],
      }),
      new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-1' }),
    ],
  };

  // 第三节：正文（页码从 1 起编，单右双左）
  const bodyChildren: (Paragraph | Table)[] = [];
  if (doc.summary.trim()) {
    bodyChildren.push(
      new Paragraph({
        children: [new TextRun({ text: doc.summary.trim(), font: FONT.body, size: SIZE.body })],
        spacing: LINE_EXACT_28,
        indent: INDENT_2CH,
        widowControl: true,
      }),
    );
  }
  doc.sections.forEach((sec, i) => {
    bodyChildren.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 240, after: 120, ...LINE_EXACT_28 },
        indent: INDENT_2CH,
        widowControl: true,
        children: [
          new TextRun({ text: `${h1Num(i)}、${sec.heading}`, font: FONT.h1, size: SIZE.h1 }),
        ],
      }),
      ...renderSectionBlocks(sec.blocks, doc.images, i + 1),
    );
  });
  // 文末成文日期：右空四字
  bodyChildren.push(
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 480, ...LINE_EXACT_28 },
      children: [new TextRun({ text: `${doc.date}　　`, font: FONT.body, size: SIZE.body })],
    }),
  );

  const file = new Document({
    creator: '网课学习助手',
    title: doc.title,
    evenAndOddHeaderAndFooters: true,
    features: { updateFields: true },
    styles: {
      default: {
        document: { run: { font: FONT.body, size: SIZE.body } },
      },
    },
    sections: [
      cover,
      toc,
      {
        properties: { page: { ...PAGE_SETUP, pageNumbers: { start: 1 } } },
        headers: { default: headerPara(doc.title), even: headerPara(doc.title) },
        footers: {
          default: new Footer({ children: [pageNumPara(true)] }),
          even: new Footer({ children: [pageNumPara(false)] }),
        },
        children: bodyChildren,
      },
    ],
  });

  return postProcessDocx(await Packer.toBlob(file), doc);
}

/** 把 segments 切成带时间戳的 transcript 文本 */
export function segmentsToTranscript(segments: SegmentRow[]): string {
  return segments.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n');
}
