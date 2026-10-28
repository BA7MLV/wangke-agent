/** IR 渲染器：Block[] → docx 段落/表格。排版样式全部来自 styles.ts，本层不做内容判断。 */
import {
  AlignmentType,
  BorderStyle,
  ImageRun,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import type { Block } from './ir';
import {
  CONTENT_WIDTH_DXA,
  FIGURE_MAX_WIDTH,
  FONT,
  INDENT_2CH,
  LINE_EXACT_28,
  SIZE,
  h2Num,
} from './styles';

export type HandoutImages = Map<number, { data: Uint8Array; width: number; height: number; caption: string }>;

interface RenderCtx {
  images: HandoutImages;
  /** 章节序号（从 1 起），用于图/表编号「图 2-1」 */
  secNo: number;
  figNo: number;
  tblNo: number;
  h2No: number;
}

/** 正文风格段落：仿宋三号、固定行距 28 磅、首行缩进 2 字符、孤行控制 */
function bodyPara(runs: TextRun[]): Paragraph {
  return new Paragraph({
    children: runs,
    spacing: LINE_EXACT_28,
    indent: INDENT_2CH,
    widowControl: true,
  });
}

function bodyRun(text: string, bold = false): TextRun {
  return new TextRun({ text, font: FONT.body, size: SIZE.body, ...(bold ? { bold } : {}) });
}

function renderFigure(block: Extract<Block, { type: 'figure' }>, ctx: RenderCtx): Paragraph[] {
  const img = ctx.images.get(block.ts);
  if (!img) return []; // 帧已被过滤（如非教学画面）：静默跳过
  const scale = Math.min(1, FIGURE_MAX_WIDTH / img.width);
  const caption = block.caption ?? img.caption;
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 60 },
      children: [
        new ImageRun({
          data: img.data,
          transformation: { width: Math.round(img.width * scale), height: Math.round(img.height * scale) },
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 180 },
      children: [
        new TextRun({
          text: `图 ${ctx.secNo}-${ctx.figNo++} ${caption}`,
          font: FONT.caption,
          size: SIZE.caption,
        }),
      ],
    }),
  ];
}

function renderTable(block: Extract<Block, { type: 'table' }>, ctx: RenderCtx): (Paragraph | Table)[] {
  const cols = block.header.length;
  const colWidth = Math.floor(CONTENT_WIDTH_DXA / cols);
  const border = (size: number) => ({ style: BorderStyle.SINGLE, size, color: '000000' });
  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'auto' };

  const cell = (text: string, isHeader: boolean) =>
    new TableCell({
      width: { size: colWidth, type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      children: [
        new Paragraph({
          alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
          children: [
            new TextRun({
              text,
              font: isHeader ? FONT.tableHead : FONT.tableBody,
              size: SIZE.tableBody,
            }),
          ],
        }),
      ],
    });

  const table = new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: Array.from({ length: cols }, () => colWidth),
    borders: {
      // 三线表：顶/底线 1.5 磅（sz 单位 1/8 磅 → 12），栏目线 0.5 磅（→ 4），无竖线
      top: border(12),
      bottom: border(12),
      left: noBorder,
      right: noBorder,
      insideHorizontal: border(4),
      insideVertical: noBorder,
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: block.header.map((h) => cell(h, true)),
      }),
      ...block.rows.map(
        (r) =>
          new TableRow({
            children: r.map((c) => cell(c, false)),
          }),
      ),
    ],
  });

  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 180, after: 60 },
      children: [
        new TextRun({
          text: `表 ${ctx.secNo}-${ctx.tblNo++} ${block.caption ?? '数据对比'}`,
          font: FONT.tableHead,
          size: SIZE.tableTitle,
        }),
      ],
    }),
    table,
    new Paragraph({ spacing: { after: 120 } }), // 表后空一行，与下文分隔
  ];
}

/** 渲染一节的全部块（图/表编号按节内顺序递增，二级标题编号各节独立） */
export function renderSectionBlocks(
  blocks: Block[],
  images: HandoutImages,
  secNo: number,
): (Paragraph | Table)[] {
  const ctx: RenderCtx = { images, secNo, figNo: 1, tblNo: 1, h2No: 0 };
  const out: (Paragraph | Table)[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'lead':
      case 'para':
        out.push(bodyPara([bodyRun(block.text)]));
        break;
      case 'note':
        out.push(
          new Paragraph({
            children: [new TextRun({ text: block.text, font: FONT.h2, size: SIZE.body })],
            spacing: LINE_EXACT_28,
            indent: INDENT_2CH,
            widowControl: true,
          }),
        );
        break;
      case 'h2':
        out.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${h2Num(ctx.h2No++)}${block.text}`, font: FONT.h2, size: SIZE.h2 }),
            ],
            spacing: LINE_EXACT_28,
            indent: INDENT_2CH,
            widowControl: true,
          }),
        );
        break;
      case 'list':
        block.items.forEach((item, i) => {
          out.push(
            block.ordered
              ? bodyPara([bodyRun(`${i + 1}. `, true), bodyRun(item)])
              : bodyPara([bodyRun(`● ${item}`)]),
          );
        });
        break;
      case 'figure':
        out.push(...renderFigure(block, ctx));
        break;
      case 'table':
        out.push(...renderTable(block, ctx));
        break;
    }
  }
  return out;
}
