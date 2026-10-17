#!/usr/bin/env node
/**
 * Markdown 表格纯逻辑测试：
 * - 复制为 Markdown：管道符 / 反斜杠 / 换行转义，列对齐标记，行列数归一
 * - 复制为 CSV：逗号 / 引号 / 换行转义
 * - 流式列宽：表头保底、长短列的上下限
 * 运行：node scripts/test-markdown-table.mjs
 */
import assert from 'node:assert/strict';
import {
  columnWidthsPx,
  escapeMarkdownCell,
  tableToCsv,
  tableToMarkdown,
  visualLength,
} from '../src/utils/markdownTable.ts';

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

test('Markdown：表头 / 分隔行 / 数据行，保留作者写的对齐', () => {
  assert.equal(
    tableToMarkdown(
      ['课程', '时长', '进度'],
      [['高数', '45', '80%']],
      [null, 'right', 'center'],
    ),
    '| 课程 | 时长 | 进度 |\n| --- | ---: | :---: |\n| 高数 | 45 | 80% |',
  );
});

test('Markdown：管道符、反斜杠、换行都转义', () => {
  assert.equal(escapeMarkdownCell('a|b'), 'a\\|b');
  assert.equal(escapeMarkdownCell('c\\d'), 'c\\\\d');
  assert.equal(escapeMarkdownCell('x\ny'), 'x<br>y');
  assert.equal(escapeMarkdownCell('  x  '), 'x');
  assert.equal(
    tableToMarkdown(['a|b', 'c'], [['x\\y', 'z']]),
    '| a\\|b | c |\n| --- | --- |\n| x\\\\y | z |',
  );
});

test('Markdown：行多一列裁掉、少一列补空', () => {
  assert.equal(
    tableToMarkdown(['a', 'b'], [['1', '2', '3'], ['4']]),
    '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 4 |  |',
  );
});

test('Markdown：空表头返回空串', () => {
  assert.equal(tableToMarkdown([], [['x']]), '');
});

test('CSV：逗号 / 引号 / 换行按 RFC 4180 转义，行尾 CRLF', () => {
  assert.equal(
    tableToCsv(['a,b', 'say "hi"', 'line\nbreak'], [['1', '2', '3']]),
    '"a,b","say ""hi""","line\nbreak"\r\n1,2,3',
  );
});

test('CSV：列数与表头对齐', () => {
  assert.equal(
    tableToCsv(['a', 'b'], [['1'], ['2', '3', '4']]),
    'a,b\r\n1,\r\n2,3',
  );
});

test('视觉宽度：CJK / 全角按 2，ASCII 按 1', () => {
  assert.equal(visualLength('abc'), 3);
  assert.equal(visualLength('中文'), 4);
  assert.equal(visualLength('a中'), 3);
});

test('流式列宽：短列有下限、长列有上限', () => {
  const widths = columnWidthsPx(
    ['#', '说明'],
    [['1', '这是一段非常非常长的说明文字，用来测试长列封顶']],
  );
  assert.equal(widths.length, 2);
  assert.ok(widths[0] >= 64, JSON.stringify(widths));
  assert.ok(widths[1] <= 320, JSON.stringify(widths));
  assert.ok(widths[1] > widths[0], JSON.stringify(widths));
});

test('流式列宽：两字表头也保得住，不依赖数据行', () => {
  const widths = columnWidthsPx(['课程名称', '时长', '进度'], []);
  assert.equal(widths.length, 3);
  assert.ok(widths[1] >= 64, JSON.stringify(widths));
  assert.ok(widths[2] >= 64, JSON.stringify(widths));
});

test('流式列宽：空表头返回空数组', () => {
  assert.deepEqual(columnWidthsPx([], []), []);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
