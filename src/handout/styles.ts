/** 公文版式样式表：渲染器的唯一数据源（docx 库单位：字号=半磅，行距/缩进/页边距=缇） */
import { LineRuleType } from 'docx';

export const FONT = {
  title: { ascii: 'Times New Roman', eastAsia: '方正小标宋简体', hAnsi: 'Times New Roman' },
  tocTitle: { ascii: 'Times New Roman', eastAsia: '黑体', hAnsi: 'Times New Roman' },
  h1: { ascii: 'Times New Roman', eastAsia: '黑体', hAnsi: 'Times New Roman' },
  h2: { ascii: 'Times New Roman', eastAsia: '楷体_GB2312', hAnsi: 'Times New Roman' },
  body: { ascii: 'Times New Roman', eastAsia: '仿宋_GB2312', hAnsi: 'Times New Roman' },
  caption: { ascii: 'Times New Roman', eastAsia: '楷体_GB2312', hAnsi: 'Times New Roman' },
  tableHead: { ascii: 'Times New Roman', eastAsia: '黑体', hAnsi: 'Times New Roman' },
  tableBody: { ascii: 'Times New Roman', eastAsia: '仿宋_GB2312', hAnsi: 'Times New Roman' },
  coverInfo: { ascii: 'Times New Roman', eastAsia: '楷体_GB2312', hAnsi: 'Times New Roman' },
  pageNum: { ascii: 'Times New Roman', eastAsia: '宋体', hAnsi: 'Times New Roman' },
  header: { ascii: 'Times New Roman', eastAsia: '宋体', hAnsi: 'Times New Roman' },
} as const;

/** 二号 44 / 小二 36 / 三号 32 / 四号 28 / 小四 24 / 五号 21 */
export const SIZE = {
  title: 44,
  tocTitle: 36,
  h1: 32,
  h2: 32,
  body: 32,
  pageNum: 28,
  caption: 24,
  tableTitle: 24,
  header: 21,
  tableBody: 21,
} as const;

/** 固定行距 28 磅（公文版心网格：每页 22 行） */
export const LINE_EXACT_28 = { line: 560, lineRule: LineRuleType.EXACT } as const;

/**
 * 首行缩进 2 字符。docx 库只支持缇单位，生成时先写 640 缇占位，
 * 打包后由 docx.ts 补丁替换为 OOXML 标准的 w:firstLineChars="200"。
 */
export const INDENT_2CH = { firstLine: 640 } as const;
export const FIRSTLINE_PLACEHOLDER = /<w:ind w:firstLine="640"\s*\/>/g;
export const FIRSTLINE_CHARS_XML = '<w:ind w:firstLineChars="200"/>';

/** GB/T 9704 公文页面：A4 + 上 3.7cm / 下 3.5cm / 左 2.8cm / 右 2.6cm */
export const PAGE_SETUP = {
  size: { width: 11906, height: 16838 },
  margin: { top: 2098, bottom: 1984, left: 1587, right: 1474 },
} as const;

/** 版心宽（缇）：11906 - 1587 - 1474 */
export const CONTENT_WIDTH_DXA = 8845;

/** 插图最大宽度（像素 @96dpi）：不超过版心 15.6cm ≈ 590px，留余量取 560 */
export const FIGURE_MAX_WIDTH = 560;

export const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

/** 一级标题编号「一、」 */
export const h1Num = (i: number): string => CN_NUM[i] ?? String(i + 1);
/** 二级标题编号「（一）」 */
export const h2Num = (i: number): string => `（${CN_NUM[i] ?? String(i + 1)}）`;
