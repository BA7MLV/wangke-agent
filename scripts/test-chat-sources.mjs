#!/usr/bin/env node
/**
 * 来源解析契约测试（src/utils/chatSources.ts）。
 *
 * 这份逻辑守的是**来源列表的账**：它一旦错账，用户会照着它去核对课程与时间点，
 * 然后对不上 —— 比没有来源更糟。所以覆盖点集中在「宁缺勿错」那一侧：
 * - 段落归属：段内的课程链接与时间标记互相归属，跨段不串门
 * - 段里只有时间标记、没有课程链接时，不归属任何来源
 * - 同一门课跨段被引用时合并，位置去重保序并封顶
 * - 非课程链接（外链、普通文字、裸课程名）不算来源
 * - URI 编码的 courseId 还原；非法 % 序列不抛
 *
 * 运行：node scripts/test-chat-sources.mjs
 */
import assert from 'node:assert/strict';
import { extractChatSources, MAX_SOURCE_REFS } from '../apps/web/src/utils/chatSources.ts';

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

/** 与 harness/libraryAssistant.ts 的 courseLink() 同构，避免测试里手抄格式走样 */
const link = (name, id) => `[《${name}》](#/player/${encodeURIComponent(id)})`;

test('空输入返回空数组', () => {
  assert.deepEqual(extractChatSources(''), []);
  assert.deepEqual(extractChatSources('   \n\n  '), []);
});

test('没有课程链接的回答没有来源', () => {
  assert.deepEqual(extractChatSources('这是一段纯文字回答，提到了 12:34 这个时间点。'), []);
});

test('裸写课程名不算来源（必须是链接）', () => {
  assert.deepEqual(extractChatSources('《高等数学（上）》里讲过这个，第 3 页。'), []);
});

test('外链不算来源', () => {
  assert.deepEqual(extractChatSources('参考 [维基](https://example.com/player/x) 的说法。'), []);
});

test('同一段里的时间点归属该段的课程', () => {
  const md = `这个结论出自 ${link('高等数学（上）', 'c-math')} 的 12:34 与 1:02:03，另外第 3 页也有。`;
  assert.deepEqual(extractChatSources(md), [
    { courseId: 'c-math', courseName: '高等数学（上）', refs: ['12:34', '1:02:03', '第 3 页'] },
  ]);
});

test('段落归属：A 段的时间点不会挂到 B 段的课程上', () => {
  const md = [
    `先看 ${link('行测判断推理', 'c-xingce')} 的 03:10。`,
    '',
    `再看 ${link('申论归纳概括', 'c-shenlun')} 的 21:45。`,
  ].join('\n');
  assert.deepEqual(extractChatSources(md), [
    { courseId: 'c-xingce', courseName: '行测判断推理', refs: ['03:10'] },
    { courseId: 'c-shenlun', courseName: '申论归纳概括', refs: ['21:45'] },
  ]);
});

test('段里只有时间标记、没有课程链接时不归属任何来源', () => {
  const md = [
    `结论见 ${link('高等数学（上）', 'c-math')}。`,
    '',
    '顺带一提，07:07 那里说得更清楚。',
  ].join('\n');
  const [source] = extractChatSources(md);
  assert.deepEqual(source.refs, [], '孤立段落里的时间点不该被算进来源');
});

test('同一门课跨段引用时合并，位置去重保序', () => {
  const md = [
    `第一部分见 ${link('高等数学（上）', 'c-math')} 的 01:00。`,
    '',
    `第二部分还是 ${link('高等数学（上）', 'c-math')}，位置 01:00 与 09:30。`,
  ].join('\n');
  assert.deepEqual(extractChatSources(md), [
    { courseId: 'c-math', courseName: '高等数学（上）', refs: ['01:00', '09:30'] },
  ]);
});

test('多门课共处一段时，段内位置同时归给它们', () => {
  const md = `${link('高等数学（上）', 'c-math')} 与 ${link('线性代数', 'c-linalg')} 在 05:20 讲的是同一件事。`;
  assert.deepEqual(extractChatSources(md), [
    { courseId: 'c-math', courseName: '高等数学（上）', refs: ['05:20'] },
    { courseId: 'c-linalg', courseName: '线性代数', refs: ['05:20'] },
  ]);
});

test('来源顺序 = 首次出现顺序，不是字母序', () => {
  const md = [
    `先 ${link('申论归纳概括', 'c-shenlun')}`,
    '',
    `后 ${link('高等数学（上）', 'c-math')}`,
    '',
    `又 ${link('申论归纳概括', 'c-shenlun')}`,
  ].join('\n');
  assert.deepEqual(
    extractChatSources(md).map((s) => s.courseId),
    ['c-shenlun', 'c-math'],
  );
});

test('courseId 会被 URI 解码（含中文与斜杠）', () => {
  const id = 'bilibili/BV1xx411c7mD 第 3 讲';
  const md = `见 ${link('课程', id)} 的 00:30。`;
  assert.equal(extractChatSources(md)[0].courseId, id);
});

test('courseId 里出现非法 % 序列时不抛，按原样保留', () => {
  // `100%25` 正常解码成 `100%`，与直接手写的 `100%`（decodeURIComponent 会抛）撞成同一条来源 ——
  // 这里要的是「不抛异常」且两门课各自成条，所以用两个不同的非法串。
  const md = '[《课程》](#/player/100%) 与 [《另一个》](#/player/50%)';
  const sources = extractChatSources(md);
  assert.deepEqual(
    sources.map((s) => s.courseId),
    ['100%', '50%'],
  );
});

test('正常编码的 courseId 与手写的裸 courseId 会合并成同一条来源', () => {
  const md = `见 [《课程》](#/player/${encodeURIComponent('100%')})，另见 [《课程》](#/player/100%)。`;
  assert.deepEqual(
    extractChatSources(md).map((s) => s.courseId),
    ['100%'],
  );
});

test('书名号缺失或 # 缺失的链接也能认出来', () => {
  const md = `见 [高等数学](/player/c-math) 的 02:00。`;
  assert.deepEqual(extractChatSources(md), [
    { courseId: 'c-math', courseName: '高等数学', refs: ['02:00'] },
  ]);
});

test('位置数量封顶，不会把回答又抄一遍', () => {
  const marks = Array.from({ length: 12 }, (_, i) => `0${i}:1${i}`).join('、');
  const md = `见 ${link('高等数学（上）', 'c-math')} 的 ${marks}。`;
  const refs = extractChatSources(md)[0].refs;
  assert.equal(refs.length, MAX_SOURCE_REFS);
  assert.equal(refs[0], '00:10');
});

test('`1:02:03` 不会被切成 `02:03`', () => {
  const md = `见 ${link('课程', 'c-1')} 的 1:02:03。`;
  assert.deepEqual(extractChatSources(md)[0].refs, ['1:02:03']);
});

test('课程名里的转义方括号被还原', () => {
  const md = `见 [《数学\\[上\\]》](#/player/c-math) 的 01:00。`;
  assert.equal(extractChatSources(md)[0].courseName, '数学[上]');
});

test('列表类回答（每行一门课）逐行归属', () => {
  const md = [
    `- ${link('高等数学（上）', 'c-math')} · 已学 40% · 06:00 处讲到极限`,
    `- ${link('行测判断推理', 'c-xingce')} · 尚未开始`,
  ].join('\n');
  // 这是一个段落（没有空行），所以 06:00 会同时归给两门课 —— 保守规则下的已知取舍
  assert.deepEqual(extractChatSources(md), [
    { courseId: 'c-math', courseName: '高等数学（上）', refs: ['06:00'] },
    { courseId: 'c-xingce', courseName: '行测判断推理', refs: ['06:00'] },
  ]);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
