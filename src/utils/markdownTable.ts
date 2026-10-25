/**
 * Markdown 表格的纯文本工具：复制导出 + 流式列宽估算。
 *
 * 这些函数刻意不碰 React / DOM：
 *   - `tableToMarkdown` / `tableToCsv` 是「表格 → 剪贴板」的唯一口径，Node 单测直接跑；
 *   - `columnWidthsPx` 只按文字长度估算，给流式期间的 `table-layout: fixed`
 *     一份**首帧就能定下来**的列宽，避免每来一行都重新分配宽度。
 *
 * 真正的单元格内容仍由 `MdTable.tsx` 从渲染后的 React 树里取 —— 那里才拿得到
 * 行内代码、链接、加粗这些结构。
 */

export type TableAlign = 'left' | 'center' | 'right' | null;

const CJK =
  /[\u1100-\u115f\u2e80-\u303e\u3040-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

/** 视觉宽度：CJK / 全角按 2 计，其余按 1 计。只用来排相对比例，不追求像素级准确。 */
export function visualLength(text: string): number {
  let n = 0;
  for (const ch of text) n += CJK.test(ch) ? 2 : 1;
  return n;
}

function normalizeCell(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

/**
 * Markdown 表格单元格转义。
 *
 * 顺序不能反：先转义反斜杠，再转义管道符。否则 `\|` 里的反斜杠会被再转一次，
 * 复制出去的内容和屏幕上看到的不是一回事。
 */
export function escapeMarkdownCell(value: string): string {
  return normalizeCell(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, '<br>');
}

function normalizeRow(cells: string[], width: number): string[] {
  const row = cells.slice(0, width);
  while (row.length < width) row.push('');
  return row;
}

/**
 * 生成可直接粘回 Markdown 的表格。
 *
 * 行数按表头列数对齐：多出来的单元格丢弃、缺的补空。Markdown 表格本身不允许
 * 一行多一列 —— 复制出来再粘回去如果列数对不上，渲染器会直接不认这张表。
 */
export function tableToMarkdown(
  headers: string[],
  rows: string[][],
  aligns?: TableAlign[],
  options?: { serializedCells?: boolean },
): string {
  const width = headers.length;
  if (width === 0) return '';

  const cell = options?.serializedCells ? (value: string) => value : escapeMarkdownCell;
  const line = (cells: string[]) =>
    `| ${normalizeRow(cells, width).map(cell).join(' | ')} |`;

  const separator = headers.map((_, i) => {
    const align = aligns?.[i] ?? null;
    if (align === 'left') return ':---';
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    return '---';
  });

  return [line(headers), line(separator), ...rows.map(line)].join('\n');
}

function csvCell(value: string): string {
  const v = value.replace(/\r\n?/g, '\n');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 生成 CSV。用 CRLF：Excel / Numbers / 剪贴板粘贴三边都认。 */
export function tableToCsv(headers: string[], rows: string[][]): string {
  const width = headers.length;
  if (width === 0) return '';
  return [headers, ...rows]
    .map((cells) => normalizeRow(cells, width).map(csvCell).join(','))
    .join('\r\n');
}

/**
 * 流式期的列宽（px）。取「表头 + 当前已经完整的前几行」里每列最长的那段文字：
 *   - 每列至少 64px：两字表头（「时长」）加上单元格内边距、再留一点字号缩放余量，
 *     不会再被挤成竖排；
 *   - 长文本列封顶 320px：再宽就该让表格横向滚动，而不是让一列吃掉大半屏；
 *   - 表头本身也参与估算：表头文字比数据长时，列宽跟着表头走。
 *
 * 这个函数只在表格**第一次出现**时算一次（见 `MdTable.tsx` 的 `frozenWidths`），
 * 流式期间不再重算 —— 这就是「列宽只增不减」的落地方式：干脆不重新分配。
 *
 * 用 px 而不是百分比，是因为百分比在窄屏上会把「时长」「进度」压到 8%（约 29px），
 * 连两个字都放不下；px 下限 + 表格总宽下限（各列之和）才能保证表头不竖排，
 * 宽度不够就让外层横向滚动。
 */
export function columnWidthsPx(
  headers: string[],
  rows: string[][],
): number[] {
  const width = headers.length;
  if (width === 0) return [];

  // 15px 字号下一单位约 7.5px；单元格左右内边距合计约 24px（0.75em × 2）
  const CHAR_PX = 7.5;
  const PAD_PX = 24;
  const MIN_PX = 64;
  const MAX_PX = 320;

  return headers.map((header, i) => {
    let longest = visualLength(header);
    for (const row of rows) {
      longest = Math.max(longest, visualLength(row[i] ?? ''));
    }
    const px = longest * CHAR_PX + PAD_PX;
    return Math.round(Math.max(MIN_PX, Math.min(px, MAX_PX)));
  });
}
