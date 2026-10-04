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
  mdCoverText,
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

// ── 封面文案（mdCoverText）────────────────────────────────────────────────
// 封面标题卡的唯一输入。规则刻意与 extractMdUnits 同源：阅读器看到的第一段
// 就是封面上的那段，两边不该各认一套「首段」。

test('封面取首个标题当标题、首段正文当预览', () => {
  const { title, preview } = mdCoverText(SAMPLE);
  assert.equal(title, '矩阵');
  assert.equal(preview, '矩阵 A 与向量 b。');
});

test('封面标题：setext 标题同样算数', () => {
  assert.equal(mdCoverText('概述\n===\n\n一段话。\n').title, '概述');
});

test('封面标题：没有标题时为 null，交给调用方回落文件名', () => {
  const c = mdCoverText('只有一段正文，没有标题。\n\n第二段。\n');
  assert.equal(c.title, null);
  assert.equal(c.preview, '只有一段正文，没有标题。');
});

test('封面标题：取全文首个标题，不要求是 H1', () => {
  assert.equal(mdCoverText('前面一段正文。\n\n## 真正的名字\n\n后面。\n').title, '真正的名字');
});

test('封面标题：frontmatter 里的 title 不算数（阅读器也不显示它）', () => {
  assert.equal(mdCoverText('---\ntitle: 讲义\n---\n\n# 正文\n\n内容。\n').title, '正文');
});

test('封面预览：剥掉行内标记与块标记', () => {
  const { preview } = mdCoverText(
    '# T\n\n这是**粗体**与*斜体*、`code`，还有[链接](http://a.b)与![图](x.png)。\n',
  );
  assert.equal(preview, '这是粗体与斜体、code，还有链接与图。');
});

test('封面预览：剥掉行内公式的美元符号，只留内容', () => {
  assert.equal(mdCoverText('# T\n\n设 $A$ 是 $n \\times n$ 方阵。\n').preview, '设 A 是 n \\times n 方阵。');
  // 美元符号当货币用时不能被吃掉：`$5` 没有配对的收尾 `$`
  assert.equal(mdCoverText('# T\n\n定价 $5 一份。\n').preview, '定价 $5 一份。');
});

test('封面预览：剥掉列表项、引用与围栏首行，并压成一行', () => {
  const { preview } = mdCoverText('# T\n\n- 第一项\n- 第二项\n\n> 引用一句\n\n```python\nprint(1)\n```\n');
  // 取的是**首段**正文，不是全文：列表整体算一段，引用与代码块是后面的段
  assert.equal(preview, '第一项 第二项');
  assert.equal(mdCoverText('# T\n\n> 引用一句\n').preview, '引用一句');
  assert.equal(mdCoverText('# T\n\n```python\nprint(1)\n```\n').preview, 'print(1)');
});

test('封面预览：首单元只有标题时往后找正文', () => {
  const c = mdCoverText('# 甲\n\n# 乙\n\n终于有正文了。\n');
  assert.equal(c.title, '甲');
  // 连续两个标题是一个单元里的**整块开头**，两个都得剥掉，不能漏第二个
  assert.equal(c.preview, '终于有正文了。');
});

test('封面文案：空文档两者都空', () => {
  assert.deepEqual(mdCoverText(''), { title: null, preview: '' });
  assert.deepEqual(mdCoverText('\n\n  \n'), { title: null, preview: '' });
  assert.deepEqual(mdCoverText('# 只有标题'), { title: '只有标题', preview: '' });
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
