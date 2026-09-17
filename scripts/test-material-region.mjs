#!/usr/bin/env node
/**
 * 框选区域相关的纯逻辑单元测试（无需 API key / 无需起服务）。
 * 运行：node scripts/test-material-region.mjs
 *
 * 只覆盖**不依赖 DOM** 的部分（矩形规范化、可用性判定、选区文本清洗）。
 * `cropCanvasRegion` / `textInRect` 需要真实 canvas 与布局，放在 e2e 里验。
 */
import assert from 'node:assert/strict';
import {
  normalizeRect,
  isUsableRegion,
  isUsableSelection,
  cleanSelectionText,
  MIN_REGION_SIDE,
  MIN_SELECTION_CHARS,
} from '../src/materials/region.ts';

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

// ---------- 矩形规范化 ----------

test('向右下拖：矩形从起点展开', () => {
  assert.deepEqual(normalizeRect({ x: 10, y: 20 }, { x: 60, y: 80 }), { x: 10, y: 20, w: 50, h: 60 });
});

test('向左上拖：结果与向右下拖一致（支持任意方向）', () => {
  assert.deepEqual(normalizeRect({ x: 60, y: 80 }, { x: 10, y: 20 }), { x: 10, y: 20, w: 50, h: 60 });
});

test('混合方向（左下 → 右上）', () => {
  assert.deepEqual(normalizeRect({ x: 60, y: 20 }, { x: 10, y: 80 }), { x: 10, y: 20, w: 50, h: 60 });
});

test('零位移 → 零尺寸矩形', () => {
  assert.deepEqual(normalizeRect({ x: 5, y: 5 }, { x: 5, y: 5 }), { x: 5, y: 5, w: 0, h: 0 });
});

// ---------- 可用性判定 ----------

test('太小的框判为误触', () => {
  assert.equal(isUsableRegion({ x: 0, y: 0, w: MIN_REGION_SIDE - 1, h: 100 }), false);
  assert.equal(isUsableRegion({ x: 0, y: 0, w: 100, h: MIN_REGION_SIDE - 1 }), false);
});

test('恰好达到下限可用（边界包含）', () => {
  assert.equal(isUsableRegion({ x: 0, y: 0, w: MIN_REGION_SIDE, h: MIN_REGION_SIDE }), true);
});

test('细长的框也算可用（框一行公式是常见用法）', () => {
  assert.equal(isUsableRegion({ x: 0, y: 0, w: 300, h: 16 }), true);
});

// ---------- 选区文本清洗 ----------

test('折叠空白并去首尾', () => {
  assert.equal(cleanSelectionText('  矩阵   的 秩  '), '矩阵的秩');
});

test('汉字间多余空格被吃掉（PDF 文本层的常见噪声）', () => {
  assert.equal(cleanSelectionText('可 逆 矩 阵'), '可逆矩阵');
});

test('超长选区截断并明确标注', () => {
  const long = '甲'.repeat(2000);
  const out = cleanSelectionText(long);
  assert.ok(out.length < long.length);
  assert.match(out, /（已截断）$/);
  // 默认上限 1200：留出省略号的余量
  assert.ok(out.length <= 1200 + 6);
});

test('自定义上限生效', () => {
  assert.equal(cleanSelectionText('abcdef', 3), 'abc…（已截断）');
});

test('空输入返回空串', () => {
  assert.equal(cleanSelectionText('   \n\t  '), '');
});

test('短选区不弹浮层（误触或多选一个字）', () => {
  assert.equal(isUsableSelection(''), false);
  assert.equal(isUsableSelection(' '), false);
  assert.equal(isUsableSelection('甲'), false, `少于 ${MIN_SELECTION_CHARS} 个非空白字符不算`);
  assert.equal(isUsableSelection('矩阵'), true);
});

test('只看非空白字符数（"a b" 算 2 个）', () => {
  assert.equal(isUsableSelection('a b'), true);
});

test('英文单词可提问', () => {
  assert.equal(isUsableSelection('matrix'), true);
});

// ---------- 汇总 ----------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
