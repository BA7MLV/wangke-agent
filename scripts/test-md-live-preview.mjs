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
/**
 * 第 p 个字符有没有被某个 hide 区间盖住。
 *
 * 刻意**不看区间长度**：隐藏区间的边界（要不要连带吃掉标记后的空白）是可以调的，
 * 而「这个符号此刻是藏着的」这件事是不变量。断言绑死坐标，以后每调一次边界就得改一遍测试，
 * 改着改着就把断言改弱了 —— 这里只问「盖没盖住」。
 */
const hiddenAt = (specs, p) => specs.some((s) => s.kind === 'hide' && s.from <= p && p < s.to);
/**
 * [from, to) 是否被这些 spec 首尾相接地恰好盖满。
 *
 * 「恰好」是这里的关键：RangeSetBuilder 不许重叠，所以容器样式只能**让开**叶子样式；
 * 但让开不等于整段丢弃 —— 少一段就意味着那截文字既没有容器样式也没有叶子样式，
 * 视觉上直接掉出标题。两种错法都要靠这条断言堵住。
 *
 * hide/collapse 也算「有人管」：被藏起来的语法符号留下的空档是设计要的，
 * 把它们算进来，这条断言就变成「每个字符都有且只有一个 spec 负责」。
 */
const tiled = (specs, from, to) => {
  let p = from;
  const inside = specs.filter((s) => s.from >= from && s.to <= to)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  for (const s of inside) {
    assert.equal(s.from, p, `位置 ${p} 处有缝（有 spec 没人管）或与前一段重叠`);
    p = s.to;
  }
  return p === to;
};

test('ATX 标题的 # 在无光标时隐藏', () => {
  const src = '# 标题\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  assert.ok(hiddenAt(specs, 0), '# 必须藏');
});

test('光标落在标题行内时 # 必须露出', () => {
  const src = '# 标题\n';
  // 光标在 `#` 上、紧跟 `#` 的空隙里、或标题文字中间，结果都必须一样：整行一个 hide 都不该有。
  // 这比「[0,1) 处没有 spec」更强，也不受隐藏区间长度变化的影响
  for (const pos of [0, 1, 3]) {
    const specs = planDecorations(parser.parse(src), src, cursor(pos));
    assert.deepEqual(specs.filter((s) => s.kind === 'hide'), [], `光标在 ${pos} 时 # 必须露出`);
  }
});

test('光标在另一段时标题 # 照藏', () => {
  const src = '# 标题\n\n正文。\n';
  const specs = planDecorations(parser.parse(src), src, cursor(at(src, '正文') + 1));
  assert.ok(hiddenAt(specs, 0), '光标不在标题行，# 照藏');
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
  assert.ok(hiddenAt(specs, at(src, '- 甲')), '无序的 - 是语法');
  const p = at(src, '1.');
  assert.deepEqual(kindsAt(specs, p, p + 2), [], '有序序号是信息，不藏');
  assert.equal(
    specs.some((s) => s.kind === 'hide' && s.from >= p),
    false,
    '有序列表整段一个字符都不该藏（序号与后面的点都是信息）',
  );
});

test('引用块 > 隐藏', () => {
  const src = '> 引用一句话\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  assert.ok(hiddenAt(specs, 0), '> 必须藏');
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

// ── 嵌套样式的归属 ─────────────────────────────────────────────────────────
// 整行样式（标题 / 代码块）是**容器**，行内样式是**叶子**，两者可以套在一起。
// 之前只挖了「藏起来的语法符号」，没挖行内样式，于是 `标题里的行内代码` 那段
// 被外层整行样式整个吞掉 —— 输出上看不出错，但行内代码的底色就没了。

test('标题里的行内代码拿 inlinecode 样式，同时标题样式让开而不是整段丢失', () => {
  const src = '# 用 `code` 做标题\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  const b = at(src, '`');
  const seg = specs.filter((s) => s.kind === 'mark' && s.from <= b + 1 && s.to >= b + 4);
  assert.equal(seg.length, 1, '行内代码那一段只能有一个样式');
  assert.equal(seg[0].cls, 'cm-md-inlinecode', '行内代码不能被整行标题样式吞掉');
  // 让开 ≠ 放弃：标题其余文字仍要是 h1，且整行除了语法符号外不留白。
  // 起点取第一个**可见**字符（而不是写死 1）：隐藏区间的右边界一挪，这条断言不该失效
  assert.ok(tiled(specs, at(src, '用'), src.indexOf('\n')), '标题行剩下的部分没被样式盖满');
  const h1 = specs.filter((s) => s.kind === 'mark' && s.cls === 'cm-md-h1');
  assert.equal(h1.length, 2, 'h1 应在行内代码两侧各留一段');
});

test('标题里同时有行内代码和粗体：两处样式都保住，标题样式仍覆盖剩余部分', () => {
  const src = '# 用 `code` 和 **粗体** 做标题\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  const c = at(src, 'code');
  const inline = specs.find((s) => s.kind === 'mark' && s.from <= c && s.to >= c + 4);
  assert.ok(inline, '行内代码要有样式');
  assert.equal(inline.cls, 'cm-md-inlinecode');
  // v1 不给强调加样式类（没有 cm-md-strong），只藏标记：加粗体进来不能把行内样式挤掉
  const p = at(src, '**');
  assert.deepEqual(kindsAt(specs, p, p + 2), ['hide']);
  assert.deepEqual(kindsAt(specs, p + 4, p + 6), ['hide']);
  const b = at(src, '粗体');
  const bold = specs.find((s) => s.kind === 'mark' && s.from <= b && s.to >= b + 2);
  assert.ok(bold, '粗体那两个字也得有样式');
  assert.equal(bold.cls, 'cm-md-h1', '强调没有独立样式类时仍归整行标题样式');
  assert.ok(tiled(specs, at(src, '用'), src.indexOf('\n')), '两种嵌套混在一起时标题行仍要盖满');
});

// ── 隐藏区间要连带吃掉标记后的水平空白 ─────────────────────────────────────
// 只藏符号本身的话，`# 标题` 会剩下「 标题」、`- 甲` 会剩下「 甲」，
// 渲染出来每个标题、每个列表项都向右偏一格 —— 编辑态看着像整体没对齐。

test('块级标记连带吃掉其后的水平空白，但一个字都不多吃', () => {
  const src = '# 标题\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  assert.ok(hiddenAt(specs, 0), '# 要藏');
  assert.ok(hiddenAt(specs, 1), '# 后面的空格也要藏，否则每个标题都右偏一格');
  assert.equal(hiddenAt(specs, at(src, '标')), false, '正文字符不能被多吃');
});

test('标记后连续的多个空格全吃掉', () => {
  const src = '#  标题\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  assert.ok(hiddenAt(specs, 0));
  assert.ok(hiddenAt(specs, 1) && hiddenAt(specs, 2), '两个空格都要吃掉');
  assert.equal(hiddenAt(specs, at(src, '标')), false, '正文字符不能被多吃');
});

test('嵌套列表只吃「标记 + 其后空格」，缩进必须保留（层级是信息）', () => {
  const src = '# 标题\n\n- 甲\n  - 乙\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  const inner = at(src, '- 乙');
  assert.ok(hiddenAt(specs, inner), '内层的 - 要藏');
  assert.ok(hiddenAt(specs, inner + 1), '- 后面的空格也要藏');
  // 往前扩就把缩进也吃了，嵌套列表会整个塌成一级 —— 这是防「修过头」的关键断言
  assert.equal(hiddenAt(specs, inner - 1), false, '缩进是列表层级，不能被吃掉');
  assert.equal(hiddenAt(specs, inner - 2), false, '缩进是列表层级，不能被吃掉');
  assert.ok(hiddenAt(specs, at(src, '- 甲')), '外层的 - 也要藏');
});

test('标记后没有空白时只藏标记本身：不越界、不跨行', () => {
  for (const src of ['#\n尾\n', '正文\n\n#']) {
    for (const s of planDecorations(parser.parse(src), src, idle)) {
      assert.ok(s.from >= 0 && s.to <= src.length, `区间越界：${s.from}-${s.to}`);
      assert.equal(src.slice(s.from, s.to).includes('\n'), false, '隐藏区间不能跨行');
    }
  }
  // `#` 后直接换行、`#` 是文档最后一个字符：两种都得正好停在标记末尾
  assert.deepEqual(
    planDecorations(parser.parse('#\n尾\n'), '#\n尾\n', idle).filter((s) => s.kind === 'hide').map((s) => [s.from, s.to]),
    [[0, 1]],
  );
  assert.deepEqual(
    planDecorations(parser.parse('正文\n\n#'), '正文\n\n#', idle).filter((s) => s.kind === 'hide').map((s) => [s.from, s.to]),
    [[4, 5]],
  );
});

test('行内标记不扩区间：符号后面跟的是正文，扩了就吃掉用户一个字', () => {
  const bold = '这是**粗体** 文字\n';
  const p = at(bold, '**');
  const boldSpecs = planDecorations(parser.parse(bold), bold, idle);
  // 收尾的 `**` 后面紧跟一个空格：扩了就等于删掉正文里的间距
  assert.deepEqual(kindsAt(boldSpecs, p + 4, p + 6), ['hide'], '收尾的 ** 只藏两个星号');
  assert.equal(hiddenAt(boldSpecs, p + 6), false, '** 后面的空格是正文间距，不能藏');

  const code = '调用 `foo()` 完成\n';
  const b = at(code, '`');
  const codeSpecs = planDecorations(parser.parse(code), code, idle);
  assert.deepEqual(kindsAt(codeSpecs, b + 6, b + 7), ['hide'], '收尾的反引号只藏一个');
  assert.equal(hiddenAt(codeSpecs, b + 7), false, '反引号后面的空格不能藏');
  // 开头的反引号后面紧跟 f：多藏一个字母就直接把代码内容吃掉一截
  assert.deepEqual(kindsAt(codeSpecs, b, b + 1), ['hide'], '开头的反引号只藏一个');
  assert.equal(hiddenAt(codeSpecs, b + 1), false, 'foo 的第一个字母不能被吃掉');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length === 0) console.log(`全部通过：${passed} 个用例`);
if (failures.length > 0) process.exit(1);