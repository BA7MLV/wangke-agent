#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  MAX_COURSE_CONTEXT,
  normalizeCourseContextIds,
  resolveCourseSearchScope,
} from '../src/harness/courseContext.ts';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL - ${name}\n    ${error.message}`);
  }
}

test('上下文去空白、去重并保留首次出现顺序', () => {
  assert.deepEqual(normalizeCourseContextIds([' course-a ', 'course-b', 'course-a']), ['course-a', 'course-b']);
});

test(`上下文最多保留 ${MAX_COURSE_CONTEXT} 门`, () => {
  assert.deepEqual(
    normalizeCourseContextIds(['a', 'b', 'c', 'd', 'e', 'f']),
    ['a', 'b', 'c', 'd', 'e'],
  );
});

test('合法空数组表示恢复自动选择', () => {
  assert.deepEqual(normalizeCourseContextIds([]), []);
});

test('缺失或包含非字符串时拒绝，不能误清除上下文', () => {
  assert.equal(normalizeCourseContextIds(undefined), null);
  assert.equal(normalizeCourseContextIds('course-a'), null);
  assert.equal(normalizeCourseContextIds(['course-a', 2]), null);
});

test('显式 courseId 优先于当前上下文和全库 scope', () => {
  assert.deepEqual([...resolveCourseSearchScope('course-b', true, ['course-a'])], ['course-b']);
});

test('scope=all 绕过旧上下文，供话题变化时重新找课', () => {
  assert.equal(resolveCourseSearchScope('', true, ['course-a']), null);
});

test('默认检索限定在当前课程上下文', () => {
  assert.deepEqual([...resolveCourseSearchScope('', false, ['course-a', 'course-b'])], ['course-a', 'course-b']);
});

test('没有上下文时默认检索全课程库', () => {
  assert.equal(resolveCourseSearchScope('', false, []), null);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
