#!/usr/bin/env node
/**
 * 材料的分块与归一化单元测试（无需 API key / 无需起服务）。
 * 运行：node scripts/test-material-chunk.mjs
 * Node ≥22.18 原生运行 TS（类型擦除），无需额外依赖。
 */
import assert from 'node:assert/strict';
import {
  collapseCjkSpaces,
  normalizeBlockText,
  joinPdfLines,
  looksScanned,
  judgeMaterialText,
  splitLongText,
  chunkUnits,
  countChars,
  MAX_BLOCK_CHARS,
  SCAN_CHARS_PER_UNIT_MIN,
} from '../src/materials/chunk.ts';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL - ${name}\n    ${e.message}`);
  }
}

// ---------- 中文排版空格修正 ----------

test('汉字之间的空格被吃掉', () => {
  assert.equal(collapseCjkSpaces('方 阵 的 秩'), '方阵的秩');
  assert.equal(collapseCjkSpaces('可 对 角 化'), '可对角化');
});

test('汉字与拉丁之间的空格保留（中文排版惯例）', () => {
  assert.equal(collapseCjkSpaces('设 A 为 n 阶方阵'), '设 A 为 n 阶方阵');
});

test('拉丁词之间的空格不受影响', () => {
  assert.equal(collapseCjkSpaces('rank of matrix'), 'rank of matrix');
});

test('多个连续空格一次吃掉', () => {
  assert.equal(collapseCjkSpaces('矩   阵'), '矩阵');
});

// ---------- 通用归一化 ----------

test('去掉 \\u0000 与零宽字符', () => {
  assert.equal(normalizeBlockText('矩\u0000阵\u200b的\u200d秩'), '矩阵的秩');
});

test('折叠多余换行到最多一个空行', () => {
  assert.equal(normalizeBlockText('第一段\n\n\n\n第二段'), '第一段\n\n第二段');
});

test('全角空格与制表符折叠为单个空格', () => {
  assert.equal(normalizeBlockText('a\u3000\u3000b\t\tc'), 'a b c');
});

// ---------- PDF 拼接（这是抽取质量的关键） ----------

test('汉字行接汉字行：不留空格', () => {
  assert.equal(joinPdfLines(['若存在可逆矩阵', '使之为对角阵']), '若存在可逆矩阵使之为对角阵');
});

test('拉丁行接拉丁行：补单个空格', () => {
  assert.equal(joinPdfLines(['A matrix is', 'diagonalizable']), 'A matrix is diagonalizable');
});

test('行尾连字符 + 小写字母：删连字符直接接', () => {
  assert.equal(joinPdfLines(['diagonaliz-', 'able matrix']), 'diagonalizable matrix');
});

test('行尾连字符 + 大写字母：不当作断词（保留连字符）', () => {
  assert.equal(joinPdfLines(['A-', 'B 两点']), 'A- B 两点');
});

test('汉字行接拉丁行：补空格', () => {
  assert.equal(joinPdfLines(['设 A 是矩阵', 'rank(A)=n']), '设 A 是矩阵 rank(A)=n');
});

test('空行 → 段落分隔（保留一个空行）', () => {
  assert.equal(joinPdfLines(['第一段', '', '', '第二段']), '第一段\n\n第二段');
});

test('PDF 逐字 item 拼出来的行（汉字间带空格）被修正', () => {
  assert.equal(joinPdfLines(['设 A 为 可 逆 矩 阵']), '设 A 为可逆矩阵');
});

test('全空行输入返回空串', () => {
  assert.equal(joinPdfLines(['', '   ', '\t']), '');
});

// ---------- 扫描件判定 ----------

test('页均字数过低 → 判定扫描件', () => {
  assert.equal(looksScanned(0, 300), true);
  assert.equal(looksScanned(20 * 300, 300), true); // 页均 20 字
  assert.equal(SCAN_CHARS_PER_UNIT_MIN, 50);
});

test('页均字数正常 → 不是扫描件', () => {
  assert.equal(looksScanned(600 * 300, 300), false);
  assert.equal(looksScanned(51, 1), false);
});

test('单元数为 0 → 视为扫描件（没有可索引内容）', () => {
  assert.equal(looksScanned(0, 0), true);
});

// ---------- 能否参与检索：格式感知判定 ----------
//
// 回归锁：Word 是结构化 XML，正文必然以文本存在，「扫描件」这条规则**只对 PDF 成立**。
// 曾经把 PDF 的「页均 50 字」直接套到 Word 上，于是段均 25 字的短段落文档
// （大纲 / 讲稿 / 条目式笔记）被整体误判成扫描件 —— 库页标签写「扫描件·不可检索」，
// 阅读器谎称「没有文本层」，materialJob 还会跳过建索引，
// 与「材料与字幕同等对待、要进问答检索索引」的决策直接冲突。

test('Word 短段落不被判成扫描件（取真实 docx fixture 的数值）', () => {
  // scripts/fixtures/sample.docx：250 字 ÷ 10 段 = 25，远低于 50 的阈值
  assert.deepEqual(judgeMaterialText('docx', 250, 10), { scanned: false, empty: false });
});

test('同一组数值换成 PDF 仍是扫描件（阈值只对「页均」有意义）', () => {
  assert.deepEqual(judgeMaterialText('pdf', 250, 10), { scanned: true, empty: false });
});

test('Word 空文档 → 无正文，而不是扫描件', () => {
  assert.deepEqual(judgeMaterialText('docx', 0, 0), { scanned: false, empty: true });
});

test('PDF 零页 / 整本空白 → 扫描件，而不是无正文', () => {
  assert.deepEqual(judgeMaterialText('pdf', 0, 0), { scanned: true, empty: false });
  assert.deepEqual(judgeMaterialText('pdf', 0, 300), { scanned: true, empty: false });
});

test('正常 PDF 与正常 Word 都能参与检索', () => {
  assert.deepEqual(judgeMaterialText('pdf', 600 * 300, 300), { scanned: false, empty: false });
  assert.deepEqual(judgeMaterialText('docx', 600 * 10, 10), { scanned: false, empty: false });
});

test('scanned 与 empty 互斥（不能同时为真）', () => {
  const cases = [
    ['pdf', 0, 0],
    ['pdf', 0, 300],
    ['pdf', 250, 10],
    ['pdf', 600 * 300, 300],
    ['docx', 0, 0],
    ['docx', 250, 10],
    ['docx', 600 * 10, 10],
  ];
  for (const [format, chars, units] of cases) {
    const v = judgeMaterialText(format, chars, units);
    assert.ok(!(v.scanned && v.empty), `${format} ${chars}字/${units}单元 同时判为扫描件与无正文`);
  }
});

// ---------- 长文本切分 ----------

test('短文本不切', () => {
  assert.deepEqual(splitLongText('短句。'), ['短句。']);
});

test('长文本按句边界切，每块不超过上限', () => {
  const sentence = '这是一个用于测试切分的中文句子。';
  const long = sentence.repeat(200); // 3200 字
  const parts = splitLongText(long);
  assert.ok(parts.length > 1, '应该被切成多块');
  for (const p of parts) assert.ok(p.length <= MAX_BLOCK_CHARS, `块长 ${p.length} 超过上限`);
  assert.equal(parts.join(''), long, '切分不应丢字符');
});

test('单句本身超长 → 硬切且不丢字符', () => {
  const one = 'a'.repeat(MAX_BLOCK_CHARS * 2 + 7);
  const parts = splitLongText(one);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(''), one);
});

test('拉丁句点后也断开', () => {
  const t = 'First sentence here. '.repeat(60);
  const parts = splitLongText(t);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= MAX_BLOCK_CHARS);
});

// ---------- 单元 → 块 ----------

test('一页一块：unit 与 unitLabel 正确', () => {
  const blocks = chunkUnits([{ unit: 3, text: '第三页的内容。' }], 'page');
  assert.deepEqual(blocks, [
    { idx: 0, unit: 3, unitLabel: '第 3 页', text: '第三页的内容。', kind: 'body' },
  ]);
});

test('超长页切成多块但 unit 不漂移（引用不能指错页）', () => {
  const long = '这是很长的一段。'.repeat(400);
  const blocks = chunkUnits([{ unit: 7, text: long }], 'page');
  assert.ok(blocks.length > 1);
  for (const b of blocks) assert.equal(b.unit, 7, '所有切片的 unit 必须都还是 7');
  assert.match(blocks[0].unitLabel, /^第 7 页（1\/\d+）$/);
  assert.match(blocks[1].unitLabel, /^第 7 页（2\/\d+）$/);
});

test('空单元被跳过，idx 保持连续', () => {
  const blocks = chunkUnits(
    [
      { unit: 1, text: '有内容。' },
      { unit: 2, text: '   ' },
      { unit: 3, text: '也有内容。' },
    ],
    'page',
  );
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.idx), [0, 1]);
  assert.deepEqual(blocks.map((b) => b.unit), [1, 3]);
});

test('Word：章节标题进 unitLabel，kind 原样带出', () => {
  const blocks = chunkUnits(
    [
      { unit: 1, text: '第二章 矩阵', kind: 'title', section: '第二章 矩阵' },
      { unit: 2, text: '正文内容。', kind: 'body', section: '第二章 矩阵' },
      { unit: 3, text: 'A | B\n1 | 2', kind: 'table', section: '第二章 矩阵' },
    ],
    'para',
  );
  assert.equal(blocks[0].unitLabel, '第二章 矩阵 第 1 段');
  assert.equal(blocks[0].kind, 'title');
  assert.equal(blocks[1].kind, 'body');
  assert.equal(blocks[2].kind, 'table');
});

test('countChars 累加块字数', () => {
  assert.equal(countChars([{ text: 'abc' }, { text: '中文字' }]), 6);
  assert.equal(countChars([]), 0);
});

// ---------- 汇总 ----------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
