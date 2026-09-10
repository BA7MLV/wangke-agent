#!/usr/bin/env node
/**
 * 倍速档位纯逻辑断言（内置档位含 4x、自定义倍速归一/去重/循环）。
 * 运行：node scripts/test-rate.mjs
 */
import assert from 'node:assert/strict';

const { PRESET_RATES, MIN_RATE, MAX_RATE, normalizeRate, sameRate, formatRate, mergeRates, nextRateOf } =
  await import('../src/utils/rate.ts');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.error(`  FAIL - ${name}\n        ${e.message}`);
  }
}

test('内置档位最高为 4x', () => {
  assert.equal(Math.max(...PRESET_RATES), 4);
  assert.deepEqual(PRESET_RATES, [1, 1.5, 2, 3, 4]);
});

test('normalizeRate 夹进 [0.25, 4] 并归一到两位小数', () => {
  assert.equal(normalizeRate(0), MIN_RATE);
  assert.equal(normalizeRate(-3), MIN_RATE);
  assert.equal(normalizeRate(9), MAX_RATE);
  assert.equal(normalizeRate(4), MAX_RATE);
  assert.equal(normalizeRate(1.256), 1.26);
  assert.equal(normalizeRate(1.234), 1.23);
  // 浮点噪声被抹平
  assert.equal(normalizeRate(2.0000000001), 2);
});

test('formatRate 去掉尾零', () => {
  assert.equal(formatRate(1), '1x');
  assert.equal(formatRate(1.5), '1.5x');
  assert.equal(formatRate(1.25), '1.25x');
  assert.equal(formatRate(4), '4x');
});

test('sameRate 容忍浮点误差', () => {
  assert.ok(sameRate(2, 2.0000000001));
  assert.ok(!sameRate(2, 2.01));
});

test('mergeRates 升序去重（自定义与内置重复不产生第二个按钮）', () => {
  assert.deepEqual(mergeRates(PRESET_RATES, []), [1, 1.5, 2, 3, 4]);
  assert.deepEqual(mergeRates(PRESET_RATES, [2, 1.25]), [1, 1.25, 1.5, 2, 3, 4]);
  // 超界值被夹住后与内置 4x 合并成一条
  assert.deepEqual(mergeRates(PRESET_RATES, [99, 0.1]), [0.25, 1, 1.5, 2, 3, 4]);
  assert.deepEqual(mergeRates(PRESET_RATES, [2.5, 2.5]), [1, 1.5, 2, 2.5, 3, 4]);
});

test('nextRateOf 向上取下一档，最大档回到最小档', () => {
  const rates = mergeRates(PRESET_RATES, [1.25]);
  assert.equal(nextRateOf(rates, 1), 1.25);
  assert.equal(nextRateOf(rates, 1.25), 1.5);
  assert.equal(nextRateOf(rates, 4), 1);
  // 当前值不在档位里（如浏览器残留 2.2x）也能取到下一档
  assert.equal(nextRateOf(rates, 2.2), 3);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
