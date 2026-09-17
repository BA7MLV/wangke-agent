// 一次性探针：确认 pdf.js 能在 Node（无浏览器）里抽出未内嵌字体的中文 PDF 文本。
// 用途：在写 e2e 之前先把「fixture 可解析」这件事确认掉，避免 e2e 失败时分不清是
// fixture 的问题还是阅读器的问题。不属于常规测试，用完即可删。
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const fs = await import('node:fs');

const data = new Uint8Array(fs.readFileSync('scripts/fixtures/sample-zh.pdf'));
const doc = await getDocument({
  data,
  useSystemFonts: false,
  disableFontFace: true,
  cMapUrl: 'node_modules/pdfjs-dist/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/',
}).promise;

console.log('页数:', doc.numPages);
const outline = await doc.getOutline();
console.log('书签:', JSON.stringify((outline ?? []).map((o) => o.title)));

for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const text = tc.items
    .filter((i) => 'str' in i)
    .map((i) => i.str)
    .join(' ');
  console.log('--- P' + p + ' items=' + tc.items.length + ' ---');
  console.log(text.slice(0, 140));
  const first = tc.items.find((i) => 'height' in i);
  if (first) console.log('  height=', first.height, ' hasEOL=', first.hasEOL);
  page.cleanup();
}
await doc.destroy();
