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
const { CallLedger, answerReserve, callKey, CONTEXT_BUFFER, resolveMaxRounds, roundMaxTokens, UNLIMITED_ROUNDS } = await import('../src/harness/loopGuard.ts');

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

test('输出预算：给到模型自己的输出上限（max_tokens 是天花板不是预留，给足不花钱）', () => {
  // DeepSeek-V4-Pro：输出上限 384k、窗口 1049k → 给满 384k
  assert.equal(roundMaxTokens(384000, 1049000, 1000), 384000);
  assert.equal(roundMaxTokens(262000, 1049000, 5000), 262000, 'Kimi-K3 / GLM-5.2 是 262k');
  // 逐模型取上限，不能取全局最大：Qwen2.5-72B 只有 4k，给 384k 会被网关拒
  assert.equal(roundMaxTokens(4000, 131072, 1000), 4000);
  // 窗口未知 → 只按模型上限给，不去猜一个可能是错的剩余量
  assert.equal(roundMaxTokens(8192, null, null), 8192);
  assert.equal(roundMaxTokens(384000, null, null), 384000);
});

test('输出预算：绝不越过模型输出上限（超限网关直接拒）', () => {
  assert.equal(roundMaxTokens(2048, 131072, 1000), 2048);
  // 上限缺失 / 脏数据 → 用假定值 8192，而不是 0 或 NaN
  assert.equal(roundMaxTokens(null, 131072, 1000), 8192);
  assert.equal(roundMaxTokens(0, 131072, 1000), 8192);
  assert.equal(roundMaxTokens(-1, 131072, 1000), 8192);
  // 窗口远大于上限时，也不能因为「还有余量」就突破上限
  assert.equal(roundMaxTokens(8192, 1049000, 1000), 8192);
});

test('输出预算：输入吃掉窗口时才收紧（不能顶满窗口，要给输入留缓冲）', () => {
  // 官方明确要求 reserve ~10k：CONTEXT_BUFFER 就是那个量
  assert.equal(CONTEXT_BUFFER, 10000);
  // 上限 384k 但窗口只有 131072 → 此时余量才是那个更小的约束
  assert.equal(roundMaxTokens(384000, 131072, 1000), 120072, '窗口比输出上限还小时按窗口算');
  assert.equal(roundMaxTokens(384000, 131072, 31072), 90000);
  // 输入更多 → 额度更少，单调不增
  assert.ok(roundMaxTokens(384000, 131072, 100000) < 90000);
  // 上限更小的时候才轮到上限生效
  assert.equal(roundMaxTokens(8192, 131072, 1000), 8192);
});

test('输出预算：任何输入都不返回 0 / 负数（0 会被服务端当成不限制）', () => {
  assert.ok(roundMaxTokens(384000, 131072, 999999) > 0, '窗口被占满时也要留一点');
  assert.equal(roundMaxTokens(384000, 131072, 999999), 256, '只剩缓冲时降到最小额度');
  assert.ok(roundMaxTokens(null, null, null) > 0);
  assert.ok(roundMaxTokens(0, 0, 0) > 0);
});

test('token 闸的预留必须放得下真正的回答（否则是我们自己把答案挤没）', () => {
  // 预留 = 缓冲 + 窗口/4：扣掉缓冲后仍剩窗口/4 可用
  assert.equal(answerReserve(131072), CONTEXT_BUFFER + 32768);
  // 小窗口也要留够，不能只剩缓冲
  assert.equal(answerReserve(32768), CONTEXT_BUFFER + 8192);
  assert.ok(answerReserve(8192) > CONTEXT_BUFFER);
  assert.ok(answerReserve(null) > CONTEXT_BUFFER, '窗口未知时按缺省 131072 算');
  assert.ok(answerReserve(0) > CONTEXT_BUFFER);
  // 关键不变量：闸放行那一刻，真正能用的 max_tokens 必须还有值（不是被缓冲吃光的最小额度）
  for (const win of [32768, 131072, 1049000]) {
    const reserve = answerReserve(win);
    // 闸放行时输入已占满窗口 - reserve
    const inputAtGate = win - reserve;
    const usable = roundMaxTokens(384000, win, inputAtGate);
    assert.ok(usable > 256, `窗口 ${win}：闸放行时只剩 ${usable} token，不够写回答`);
    assert.equal(usable, win / 4, `窗口 ${win}：闸放行时应正好剩窗口的 1/4 可用`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
