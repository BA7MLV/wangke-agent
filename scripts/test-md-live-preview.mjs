#!/usr/bin/env node
/**
 * md 编辑态装饰规则的单元测试（无需 API key / 无需起服务）。
 * 运行：node scripts/test-md-live-preview.mjs
 *
 * @lezer/markdown 是纯 JS，可在 node 里解析，因此「语法符号该不该藏」
 * 这条最容易写错的规则能被直接断言。
 */
import assert from 'node:assert/strict';
import { parser } from '@lezer/markdown';
import { planDecorations } from '../src/md-editor/hideRanges.ts';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`  FAIL - ${name}\n    ${e.message}`); }
}

/** 光标落在一个位置上（编辑器里 selection 就是这样表示的） */
const cursor = (pos) => [{ from: pos, to: pos }];
/** 不在任何位置（等价于「没有焦点」） */
const idle = [];
/** 从 text 里找子串位置，断言用 */
const at = (text, sub) => {
  const i = text.indexOf(sub);
  assert.notEqual(i, -1, `测试样本里找不到 ${JSON.stringify(sub)}`);
  return i;
};
const kindsAt = (specs, from, to) =>
  specs.filter((s) => s.from === from && s.to === to).map((s) => s.kind);

test('ATX 标题的 # 在无光标时隐藏', () => {
  const src = '# 标题\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  assert.deepEqual(kindsAt(specs, 0, 1), ['hide']);
});

test('光标落在标题行内时 # 必须露出', () => {
  const src = '# 标题\n';
  const specs = planDecorations(parser.parse(src), src, cursor(3));
  assert.deepEqual(kindsAt(specs, 0, 1), [], '光标在标题里就该露出 #');
});

test('光标在另一段时标题 # 照藏', () => {
  const src = '# 标题\n\n正文。\n';
  const specs = planDecorations(parser.parse(src), src, cursor(at(src, '正文') + 1));
  assert.deepEqual(kindsAt(specs, 0, 1), ['hide']);
});

test('非光标处的 ** 被隐藏', () => {
  const src = '这是**粗体**文字\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  const p = at(src, '**');
  assert.deepEqual(kindsAt(specs, p, p + 2), ['hide']);
  assert.deepEqual(kindsAt(specs, p + 4, p + 6), ['hide']);
});

test('光标在粗体内部时 ** 露出（否则没法编辑）', () => {
  const src = '这是**粗体**文字\n';
  const specs = planDecorations(parser.parse(src), src, cursor(at(src, '粗体') + 1));
  const p = at(src, '**');
  assert.deepEqual(kindsAt(specs, p, p + 2), [], '在粗体里打字就必须看得见 **');
});

test('行内代码加样式类 CodeMark 且光标处露出', () => {
  const src = '调用 `foo()` 完成\n';
  const b = at(src, '`');
  assert.deepEqual(kindsAt(planDecorations(parser.parse(src), src, idle), b, b + 1), ['hide']);
  assert.deepEqual(kindsAt(planDecorations(parser.parse(src), src, cursor(b + 2)), b, b + 1), []);
});

test('无序列表符号隐藏、有序列表序号保留', () => {
  const src = '- 甲\n- 乙\n\n1. 丙\n2. 丁\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  assert.deepEqual(kindsAt(specs, 0, 1), ['hide'], '无序的 - 是语法');
  const p = at(src, '1.');
  assert.deepEqual(kindsAt(specs, p, p + 2), [], '有序序号是信息，不藏');
});

test('引用块 > 隐藏', () => {
  const src = '> 引用一句话\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  assert.deepEqual(kindsAt(specs, 0, 1), ['hide']);
});

test('围栏代码块首尾行折叠、正文行加代码块样式', () => {
  const src = '```js\nconst a = 1;\n```\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  const close = src.lastIndexOf('```');
  assert.deepEqual(
    specs.filter((s) => s.kind === 'collapse').map((s) => [s.from, s.to]),
    [[0, 5], [close, close + 3]],
  );
  const body = specs.find((s) => s.kind === 'mark' && s.cls === 'cm-md-codeblock');
  assert.ok(body, '代码正文要加块样式');
  assert.equal(body.from, at(src, 'const'));
});

test('光标在围栏内时首尾行不折叠（否则进不去编辑）', () => {
  const src = '```js\nconst a = 1;\n```\n';
  const specs = planDecorations(parser.parse(src), src, cursor(at(src, 'const') + 2));
  assert.equal(specs.filter((s) => s.kind === 'collapse').length, 0);
});

test('结果按 from 升序且无重叠（RangeSetBuilder 的硬要求）', () => {
  const src = [
    '# 大标题',
    '',
    '> 引用一句',
    '',
    '- 甲',
    '- 乙',
    '',
    '这段有**粗体**与 `code`。',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '1. 丙',
    '2. 丁',
    '',
  ].join('\n');
  for (const [label, active] of [
    ['idle', idle],
    ['cursor(5)', cursor(5)],
    ['光标在粗体里', cursor(at(src, '粗体'))],
  ]) {
    const specs = planDecorations(parser.parse(src), src, active);
    assert.ok(specs.length > 0, `${label} 应该有装饰`);
    for (let i = 1; i < specs.length; i++) {
      assert.ok(specs[i].from >= specs[i - 1].from, `${label} 第 ${i} 项 from 逆序`);
      assert.ok(specs[i - 1].to <= specs[i].from, `${label} 第 ${i} 项与前一项重叠`);
    }
  }
});

test('空文档不炸', () => {
  assert.ok(Array.isArray(planDecorations(parser.parse(''), '', idle)));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length === 0) console.log(`全部通过：${passed} 个用例`);
if (failures.length > 0) process.exit(1);