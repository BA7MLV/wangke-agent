#!/usr/bin/env node
/**
 * Markdown 表格纯逻辑测试：
 * - 复制为 Markdown：管道符 / 反斜杠 / 换行转义，列对齐标记，行列数归一
 * - 复制为 CSV：逗号 / 引号 / 换行转义
 * - 流式列宽：表头保底、长短列的上下限
 * 运行：node scripts/test-markdown-table.mjs
 */
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { Marked } from 'marked';
import { tableCellMarkdown, tableCellText } from '../apps/web/src/utils/tableCell.ts';
import { protectMath } from '../apps/web/src/components/markdown/math.ts';
import { tableExtension } from '../apps/web/src/components/markdown/table.ts';
import {
  columnWidthsPx,
  escapeMarkdownCell,
  tableToCsv,
  tableToMarkdown,
  visualLength,
} from '../apps/web/src/utils/markdownTable.ts';

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

test('公式与自定义图片组件的 CSV 保留语义，不丢成空格', () => {
  const Component = () => null;
  assert.equal(tableCellText(h(Component, { 'data-source': '\\frac{a}{b}' })), '\\frac{a}{b}');
  assert.equal(tableCellText(h(Component, { src: '/image.png', alt: '示意图' })), '示意图');
  assert.equal(tableCellText(h('td', null, '第一行', h('br'), '第二行')), '第一行\n第二行');
});

test('复制后重新解析：公式命令、代码反斜杠/反引号/竖线与转义文字保真', () => {
  const formula = '\\frac{a}{b} + P(A|B)';
  const cells = [
    h('span', { 'data-source': formula }),
    h('code', null, 'C:\\Users\\me'),
    h('code', null, '`a` and ``b``'),
    h('code', null, '$|x|$ \\(x\\)'),
    h('span', null, '*literal* [text] $20 &amp; <tag> a|b'),
  ];
  const copied = tableToMarkdown(['内容'], cells.map(cell => [tableCellMarkdown(cell)]), [], { serializedCells: true });
  const parser = new Marked();
  const protectedCopy = protectMath(copied, false);
  const token = parser.lexer(protectedCopy)[0];
  assert.equal(token.type, 'table');
  assert.equal(token.rows.length, cells.length);
  assert.ok(token.rows.every(row => row.length === 1));
  const html = parser.parse(protectedCopy);
  assert.match(html, /data-source="\\frac\{a\}\{b\} \+ P\(A&#124;B\)"/);
  assert.match(html, /<code>C:\\Users\\me<\/code>/);
  assert.match(html, /<code>`a` and ``b``<\/code>/);
  assert.doesNotMatch(html, /<em>|<strong>|<tag>/);
  assert.equal((html.match(/<math-formula/g) ?? []).length, 1, 'code and escaped dollars stay literal');
});

test('流式只隐藏尚未收到换行的最后一行，结束时完整放出', () => {
  const source = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3';
  const streaming = new Marked(tableExtension(true));
  assert.match(streaming.parse(source), /data-state="loading" data-pending="true"/);
  assert.match(streaming.parse(source + '\n'), /data-state="loading" data-pending="false"/);
  assert.match(new Marked(tableExtension(false)).parse(source), /data-state="done" data-pending="false"/);
  assert.match(streaming.parse(source + '\n\n继续输出'), /data-state="done"/);
  assert.match(streaming.parse(source + '\n\n'), /data-state="done"/);
  assert.match(streaming.parse(source.split('\n').map(line => `> ${line}`).join('\n')), /data-state="loading" data-pending="true"/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
