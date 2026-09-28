#!/usr/bin/env node
/**
 * agent 循环护栏的纯逻辑断言：调用指纹（循环检测）+ 轮次档位翻译。
 *
 * 重点不在「重复了能认出来」（那太简单），在几条**边界**：
 *   - 只判**完全相同**的调用是刻意的：换关键词的多轮检索是有意为之，不能被当成打转
 *   - 参数键序不同要算同一个调用（模型两次给 `{a,b}` 与 `{b,a}` 是同一件事）
 *   - 非法 JSON 也要能记指纹（否则一次崩溃的调用会变成「无指纹」，谁都能重复进账）
 *   - 0 必须翻译成 Infinity，「不限」这一档不能被 `|| 12` 之类的写法吃掉
 *
 * 运行：node scripts/test-agent-guard.mjs
 */
import assert from 'node:assert/strict';

// 只导入纯模块：agent.ts 本身带运行时依赖（api / store），Node 里解析不了
const { CallLedger, callKey, resolveMaxRounds, UNLIMITED_ROUNDS } = await import('../src/harness/loopGuard.ts');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.error(`  FAIL - ${name}\n        ${e.message}`);
  }
}

test('轮次档位：正数照传，0（不限）翻成 Infinity', () => {
  assert.equal(UNLIMITED_ROUNDS, 0);
  assert.equal(resolveMaxRounds(3), 3);
  assert.equal(resolveMaxRounds(20), 20);
  assert.equal(resolveMaxRounds(UNLIMITED_ROUNDS), Infinity);
  // 负数没有意义，一律当「不限」处理（用户手改成 -1 时不该变成 0 轮死循环）
  assert.equal(resolveMaxRounds(-1), Infinity);
});

test('同一工具 + 同一参数：第二次判为重复', () => {
  const ledger = new CallLedger();
  assert.equal(ledger.record('search_material', '{"query":"贝叶斯"}'), false);
  assert.equal(ledger.record('search_material', '{"query":"贝叶斯"}'), true);
});

test('换关键词的多轮检索不算打转', () => {
  const ledger = new CallLedger();
  assert.equal(ledger.record('search_material', '{"query":"贝叶斯"}'), false);
  assert.equal(ledger.record('search_material', '{"query":"贝叶斯定理"}'), false);
  assert.equal(ledger.record('search_material', '{"query":"先验概率"}'), false);
  assert.equal(ledger.record('get_material_range', '{"from":3}'), false, '换个工具当然不是重复');
});

test('参数键序不同算同一个调用', () => {
  assert.equal(
    callKey('set_course_context', '{"courseIds":["a"],"scope":"all"}'),
    callKey('set_course_context', '{"scope":"all","courseIds":["a"]}'),
  );
  const ledger = new CallLedger();
  assert.equal(ledger.record('set_course_context', '{"a":1,"b":2}'), false);
  assert.equal(ledger.record('set_course_context', '{"b":2,"a":1}'), true);
});

test('无参数与空对象是同一个调用', () => {
  assert.equal(callKey('get_learning_overview', ''), callKey('get_learning_overview', '{}'));
});

test('非法 JSON 也留得下指纹（不能变成「谁都能重复进账」）', () => {
  const ledger = new CallLedger();
  assert.equal(ledger.record('ask_user', '{坏掉的 json'), false);
  assert.equal(ledger.record('ask_user', '{坏掉的 json'), true);
  // 不同的坏字符串仍算不同调用
  assert.equal(ledger.record('ask_user', '{另一段'), false);
});

test('指纹不跨轮次累积（账本是本轮问答内的事）', () => {
  const ledger = new CallLedger();
  ledger.record('list_courses', '{}');
  // 同一问答的下一轮是新账本：新的 CallLedger 就是干净的
  const next = new CallLedger();
  assert.equal(next.record('list_courses', '{}'), false);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
