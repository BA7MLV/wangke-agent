#!/usr/bin/env node
/**
 * Markdown 阅读材料抽取的单元测试（无需 API key / 无需起服务）。
 * 运行：node scripts/test-material-md.mjs
 *
 * 覆盖：标题切段、代码围栏不被误切、空段不占号、文件识别。
 */
import assert from 'node:assert/strict';
import {
  extractMdUnits,
  isMarkdownFile,
  MD_MIME,
} from '../src/materials/md.ts';

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

const SAMPLE = `# 矩阵

矩阵 A 与向量 b。

## 1.1 可逆

若存在可逆矩阵 P，则称 A 可对角化。

\`\`\`python
# 这不是标题
print("x")
\`\`\`

- 第一项
- 第二项

### 细节

正文。
`;

test('ATX 标题并进紧随其后的正文，不单独占段号', () => {
  const units = extractMdUnits(SAMPLE);
  assert.equal(units.filter((u) => u.text === '矩阵').length, 0, '标题不应单独成段');
  const body = units.find((u) => u.text.includes('矩阵 A'));
  assert.ok(body);
  assert.match(body.text, /^矩阵\n\n矩阵 A/);
  assert.equal(body.section, '矩阵');
  assert.equal(body.kind, 'title');
  const after = units.find((u) => u.text.includes('若存在可逆矩阵'));
  assert.match(after.text, /^1\.1 可逆\n\n若存在/);
  assert.equal(after.section, '1.1 可逆');
  assert.equal(units[0].unit, 1);
  assert.equal(after.unit, 2);
});

test('代码围栏里的 # 不当成标题，围栏跟前一段正文分开', () => {
  const units = extractMdUnits(SAMPLE);
  const fence = units.find((u) => u.text.includes('print'));
  assert.ok(fence, '应抽出代码围栏');
  assert.match(fence.text, /```python/);
  assert.match(fence.text, /这不是标题/, '围栏原文要保留');
  assert.equal(units.some((u) => u.text === '这不是标题'), false);
  assert.match(fence.text, /^```python/);
  assert.equal(fence.kind, 'body');
});

test('空行分开的正文各算一段，标题不另占号', () => {
  const units = extractMdUnits(SAMPLE);
  assert.deepEqual(
    units.map((u) => u.unit),
    units.map((_, i) => i + 1),
  );
  assert.equal(units.length, 5);
  assert.equal(units.filter((u) => u.text === '矩阵' || u.text === '1.1 可逆' || u.text === '细节').length, 0);
});

test('列表项合并成一段，不按行拆', () => {
  const units = extractMdUnits(SAMPLE);
  const list = units.find((u) => u.text.includes('第一项'));
  assert.ok(list);
  assert.match(list.text, /第一项/);
  assert.match(list.text, /第二项/);
  assert.equal(list.section, '1.1 可逆');
});

test('setext 标题并进下一段', () => {
  const units = extractMdUnits('概述\n===\n\n一段话。\n');
  assert.equal(units.length, 1);
  assert.equal(units[0].text, '概述\n\n一段话。');
  assert.equal(units[0].section, '概述');
  assert.equal(units[0].kind, 'title');
});

test('没有标题时整篇按空行分段，section 为空', () => {
  const units = extractMdUnits('第一段。\n\n第二段。\n');
  assert.equal(units.length, 2);
  assert.equal(units[0].text, '第一段。');
  assert.equal(units[1].text, '第二段。');
  assert.equal(units[0].section, undefined);
  assert.equal(units[0].kind, 'body');
});

test('空文档与纯空白返回空数组', () => {
  assert.deepEqual(extractMdUnits(''), []);
  assert.deepEqual(extractMdUnits('\n\n   \n'), []);
});

test('frontmatter 丢掉，不当正文', () => {
  const units = extractMdUnits('---\ntitle: 讲义\n---\n\n# 正文\n\n内容。\n');
  assert.equal(units.some((u) => u.text.includes('title:')), false);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, '正文\n\n内容。');
  assert.equal(units[0].unit, 1);
});

test('markdown 文件识别：扩展名与 MIME', () => {
  assert.equal(MD_MIME, 'text/markdown');
  assert.equal(isMarkdownFile({ name: '讲义.MD', type: '' }), true);
  assert.equal(isMarkdownFile({ name: 'a.markdown', type: '' }), true);
  assert.equal(isMarkdownFile({ name: 'a.txt', type: 'text/markdown' }), true);
  assert.equal(isMarkdownFile({ name: 'a.pdf', type: 'application/pdf' }), false);
  assert.equal(isMarkdownFile({ name: 'SKILL.md', type: '' }), true);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
