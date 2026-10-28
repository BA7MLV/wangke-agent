import type { PdfRegion } from './imageRefs.ts';

export interface PdfTextBox { text: string; x: number; y: number; width: number; height: number }
export interface QuestionRegion { region: PdfRegion; label: string }

/** Conservative numbered-question segmentation. Never OCR or redraw; uncertain layouts retain full pages. */
export function detectQuestionRegions(boxes: PdfTextBox[], width: number, height: number): QuestionRegion[] {
  if (!(width > 0 && height > 0)) return [];
  const rows: PdfTextBox[] = [];
  for (const box of [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (!box.text.trim() || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) continue;
    const row = rows.find((r) => Math.abs(r.y - box.y) < Math.max(2, box.height * .3) && box.x >= r.x && box.x - (r.x + r.width) < width * .045);
    if (row) { row.text += box.text; row.width = Math.max(row.width, box.x + box.width - row.x); row.height = Math.max(row.height, box.height); }
    else rows.push({ ...box });
  }
  // Do not split bracketed subquestions, decimals, answer lists or page numbers.
  const starts = rows.filter((r) => /^\s*(?:\d{1,3}\s*[、．.]\s*(?!\d)|第\s*\d{1,3}\s*题\s*[:：]?|(?:例题?|题)\s*\d{1,3}\s*[:：])\S/.test(r.text) && r.y > height * .025 && r.y < height * .94);
  if (!starts.length || starts.length > 60) return [];
  const columns: PdfTextBox[][] = [];
  for (const row of [...starts].sort((a, b) => a.x - b.x)) {
    const column = columns.find((c) => Math.abs(c[0].x - row.x) < width * .08);
    if (column) column.push(row); else columns.push([row]);
  }
  // Unsupported indentation/3+ columns: false certainty is worse than a full-page fallback.
  if (columns.length > 2 || columns.length === 2 && columns[1][0].x - columns[0][0].x < width * .3) return [];
  const out: QuestionRegion[] = [];
  for (let ci = 0; ci < columns.length; ci++) {
    const column = columns[ci].sort((a, b) => a.y - b.y);
    const left = Math.max(0, column[0].x - width * .025);
    const right = ci + 1 < columns.length ? columns[ci + 1][0].x - width * .025 : width * .985;
    if (columns.length === 2 && rows.some((r) => r.x < right && r.x + r.width > right + width * .04 && r.y >= column[0].y)) return [];
    for (let i = 0; i < column.length; i++) {
      const top = Math.max(0, column[i].y - Math.max(3, column[i].height * .3));
      const bottom = i + 1 < column.length ? column[i + 1].y - Math.max(3, column[i + 1].height * .3) : height * .985;
      if (bottom - top < column[i].height * 1.4) return [];
      const x = Math.floor(left / width * 1000), y = Math.floor(top / height * 1000);
      const x2 = Math.min(1000, ci + 1 < columns.length ? Math.floor(right / width * 1000) : Math.ceil(right / width * 1000)), y2 = Math.min(1000, Math.ceil(bottom / height * 1000));
      out.push({ region: { x, y, width: x2 - x, height: y2 - y }, label: column[i].text.trim().slice(0, 100) });
    }
  }
  return out;
}
