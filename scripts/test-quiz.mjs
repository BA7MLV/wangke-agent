#!/usr/bin/env node
/**
 * present_quiz 题卡校验的单元测试。
 * 运行：node scripts/test-quiz.mjs
 * Node ≥22.18 原生运行 TS（类型擦除），无需额外依赖。
 */
import assert from 'node:assert/strict';
import { validateQuiz } from '../src/harness/quiz.ts';

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

const GOOD_Q = {
  stem: '  进程与线程的区别是什么？  ',
  options: [' A ', 'B', 'C', 'D'],
  answer: 2,
  explanation: ' 进程是资源分配单位 [03:25] ',
  time: '03:25',
};

test('合法单题通过并清洗（trim）', () => {
  const r = validateQuiz({ questions: [GOOD_Q] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.quiz.questions[0], {
    stem: '进程与线程的区别是什么？',
    options: ['A', 'B', 'C', 'D'],
    answer: 2,
    explanation: '进程是资源分配单位 [03:25]',
    time: '03:25',
  });
});

test('合法多题通过；无 time 字段则不输出 time', () => {
  const q2 = { ...GOOD_Q };
  delete q2.time;
  const r = validateQuiz({ questions: [GOOD_Q, q2] });
  assert.equal(r.ok, true);
  assert.equal(r.quiz.questions.length, 2);
  assert.equal('time' in r.quiz.questions[1], false);
});

test('questions 缺失/非数组/空数组均失败', () => {
  for (const raw of [{}, { questions: 'x' }, { questions: [] }, null]) {
    assert.equal(validateQuiz(raw).ok, false);
  }
});

test('超过 5 题失败', () => {
  const r = validateQuiz({ questions: Array(6).fill(GOOD_Q) });
  assert.equal(r.ok, false);
});

test('题干为空失败', () => {
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, stem: '  ' }] }).ok, false);
  const noStem = { ...GOOD_Q };
  delete noStem.stem;
  assert.equal(validateQuiz({ questions: [noStem] }).ok, false);
});

test('选项必须恰好 4 个', () => {
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, options: ['A', 'B', 'C'] }] }).ok, false);
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, options: ['A', 'B', 'C', 'D', 'E'] }] }).ok, false);
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, options: 'ABCD' }] }).ok, false);
});

test('选项不能为空或重复', () => {
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, options: ['A', ' ', 'C', 'D'] }] }).ok, false);
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, options: ['A', 'A', 'C', 'D'] }] }).ok, false);
});

test('answer 必须是 0~3 整数', () => {
  for (const answer of [-1, 4, 1.5, '2', null]) {
    assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, answer }] }).ok, false, `answer=${answer}`);
  }
});

test('解析为空失败', () => {
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, explanation: '' }] }).ok, false);
});

test('time 格式非法时静默丢弃（不报错）', () => {
  const r = validateQuiz({ questions: [{ ...GOOD_Q, time: '3分25秒' }] });
  assert.equal(r.ok, true);
  assert.equal('time' in r.quiz.questions[0], false);
});

test('h:mm:ss 时间戳合法保留', () => {
  const r = validateQuiz({ questions: [{ ...GOOD_Q, time: '1:03:25' }] });
  assert.equal(r.ok, true);
  assert.equal(r.quiz.questions[0].time, '1:03:25');
});

test('多余字段被忽略', () => {
  const r = validateQuiz({ questions: [{ ...GOOD_Q, foo: 1 }], bar: 2 });
  assert.equal(r.ok, true);
  assert.equal('foo' in r.quiz.questions[0], false);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
