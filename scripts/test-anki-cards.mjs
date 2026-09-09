#!/usr/bin/env node
/**
 * Anki 问答卡清洗/去重的单元测试。
 * 运行：node scripts/test-anki-cards.mjs
 * Node ≥22.18 原生运行 TS（类型擦除），无需额外依赖。
 */
import assert from 'node:assert/strict';
import { cleanCard, dedupeCards, extractJsonArray, CARD_LIMITS } from '../src/harness/ankiCard.ts';

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

const RANGE = { start: 600, end: 1200 };
const GOOD = { q: '  光合作用发生在什么细胞器中？ ', a: ' 叶绿体 ', time: '10:25' };

test('合法卡片通过并清洗（trim）', () => {
  const c = cleanCard(GOOD, RANGE);
  assert.deepEqual(c, { q: '光合作用发生在什么细胞器中？', a: '叶绿体', time: 625 });
});

test('h:mm:ss 时间戳解析', () => {
  const c = cleanCard({ ...GOOD, time: '1:03:25' });
  assert.equal(c.time, 3805);
});

test('q/a 为空或过短返回 null', () => {
  assert.equal(cleanCard({ ...GOOD, q: '  ' }, RANGE), null);
  assert.equal(cleanCard({ ...GOOD, q: '是啥' }, RANGE), null); // < qMin
  assert.equal(cleanCard({ ...GOOD, a: '' }, RANGE), null);
  const noQ = { a: '叶绿体', time: '10:25' };
  assert.equal(cleanCard(noQ, RANGE), null);
});

test('time 缺失/非法返回 null', () => {
  assert.equal(cleanCard({ q: GOOD.q, a: GOOD.a }, RANGE), null);
  assert.equal(cleanCard({ ...GOOD, time: '3分25秒' }, RANGE), null);
  assert.equal(cleanCard({ ...GOOD, time: 'abc' }, RANGE), null);
});

test('time 超出块范围（±30s 容差）返回 null', () => {
  assert.equal(cleanCard({ ...GOOD, time: '09:29' }, RANGE), null); // 569 < 600-30
  assert.notEqual(cleanCard({ ...GOOD, time: '09:31' }, RANGE), null); // 571 ≥ 570
  assert.equal(cleanCard({ ...GOOD, time: '20:31' }, RANGE), null); // 1231 > 1200+30
  assert.notEqual(cleanCard({ ...GOOD, time: '20:29' }, RANGE), null);
});

test('无 range 时不做范围钳制', () => {
  assert.notEqual(cleanCard({ ...GOOD, time: '00:01' }), null);
});

test('超长 q/a 截断到上限', () => {
  const c = cleanCard({ ...GOOD, q: '问'.repeat(200), a: '答'.repeat(300) }, RANGE);
  assert.equal(c.q.length, CARD_LIMITS.qMax);
  assert.equal(c.a.length, CARD_LIMITS.aMax);
});

test('多余字段被忽略', () => {
  const c = cleanCard({ ...GOOD, foo: 1 }, RANGE);
  assert.equal('foo' in c, false);
});

test('extractJsonArray：剥围栏 + 截取首个 [ 到末个 ]', () => {
  const raw = '前言\n```json\n[{"q":"a","a":"b","time":"01:00"}]\n```\n后记';
  assert.equal(extractJsonArray(raw).length, 1);
});

test('extractJsonArray：无数组/坏 JSON 返回空数组', () => {
  assert.deepEqual(extractJsonArray('没有数组'), []);
  assert.deepEqual(extractJsonArray('[{bad json]'), []);
  assert.deepEqual(extractJsonArray('{"not":"array"}'), []);
});

test('dedupeCards：按时间排序', () => {
  const out = dedupeCards([
    { q: '问题乙？', a: 'x', time: 300 },
    { q: '问题甲？', a: 'x', time: 100 },
  ]);
  assert.equal(out[0].q, '问题甲？');
  assert.equal(out[1].q, '问题乙？');
});

test('dedupeCards：规范化问题去重（忽略标点/空白/大小写），保留先出现的', () => {
  const out = dedupeCards([
    { q: '光合作用发生在什么细胞器中？', a: '叶绿体', time: 100 },
    { q: '光合作用发生在什么细胞器中', a: '叶绿体（重复）', time: 200 },
    { q: '光 合作用发生在什么细胞器中？', a: '叶绿体（重复2）', time: 50 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].a, '叶绿体（重复2）'); // 排序后 time=50 的最先
});

test('dedupeCards：空问题文本（规范化后为空）被丢弃', () => {
  const out = dedupeCards([{ q: '？？？', a: 'x', time: 1 }]);
  assert.equal(out.length, 0);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
