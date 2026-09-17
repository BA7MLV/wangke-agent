#!/usr/bin/env node
/**
 * 材料定位单元（页/段）与引用 linkify 的单元测试（无需 API key / 无需起服务）。
 * 运行：node scripts/test-material-units.mjs
 */
import assert from 'node:assert/strict';
import {
  fmtUnitRef,
  fmtUnitLabel,
  parseUnitRef,
  extractUnitRefs,
  unitRefRe,
  unitNoun,
  clampUnit,
} from '../src/materials/units.ts';
import { linkifyUnits, linkifyTimestamps, UNIT_LINK_PREFIX } from '../src/utils/linkify.ts';

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

// ---------- 格式化 ----------

test('量词与引用标记', () => {
  assert.equal(unitNoun('page'), '页');
  assert.equal(unitNoun('para'), '段');
  assert.equal(fmtUnitRef('page', 3), '第3页');
  assert.equal(fmtUnitRef('para', 12), '第12段');
});

test('位置描述带空格，可选章节前缀', () => {
  assert.equal(fmtUnitLabel('page', 3), '第 3 页');
  assert.equal(fmtUnitLabel('para', 4), '第 4 段');
  assert.equal(fmtUnitLabel('para', 4, '§2.1'), '§2.1 第 4 段');
});

// ---------- 反解 ----------

test('反解引用标记，容忍空格', () => {
  assert.equal(parseUnitRef('第3页', 'page'), 3);
  assert.equal(parseUnitRef('第 3 页', 'page'), 3);
  assert.equal(parseUnitRef('  第12页  ', 'page'), 12);
});

test('类型不匹配 → null（不能把「第3段」当成第 3 页）', () => {
  assert.equal(parseUnitRef('第3段', 'page'), null);
  assert.equal(parseUnitRef('第3页', 'para'), null);
});

test('非引用文本 → null', () => {
  assert.equal(parseUnitRef('03:25', 'page'), null);
  assert.equal(parseUnitRef('', 'page'), null);
  assert.equal(parseUnitRef('第0页', 'page'), null, '0 不是合法页号');
  assert.equal(parseUnitRef('第12345页', 'page'), null, '超过 4 位不认');
});

test('抽取文本里的全部单元号', () => {
  assert.deepEqual(extractUnitRefs('见[第3页]与[第 12 页]，另外[03:25]是时间戳', 'page'), [3, 12]);
  assert.deepEqual(extractUnitRefs('没有引用', 'page'), []);
});

test('每次调用返回新的正则（各自独立，不被上一次的 lastIndex 串味）', () => {
  assert.notEqual(unitRefRe('page'), unitRefRe('page'));
  // 每次都新建 → 各自的 lastIndex 都从 0 开始，同一段文本每次都能命中
  assert.equal(unitRefRe('page').test('[第3页]'), true);
  assert.equal(unitRefRe('page').test('[第3页]'), true);
  // 反过来：复用一个带 g 的实例连续 test，第二次就因 lastIndex 残留而失败
  // —— 这正是 unitRefRe 必须每次新建、不能导出一个共享实例的原因
  const shared = unitRefRe('page');
  assert.equal(shared.test('[第3页]'), true);
  assert.equal(shared.test('[第3页]'), false, 'g 标志的 lastIndex 会跨调用残留');
});

test('夹取范围', () => {
  assert.equal(clampUnit(0), 1);
  assert.equal(clampUnit(-5), 1);
  assert.equal(clampUnit(3.7), 3);
  assert.equal(clampUnit(999, 10), 10);
  assert.equal(clampUnit(5, 10), 5);
  assert.equal(clampUnit(5, 0), 5, 'max 未知时只保证下界');
});

// ---------- linkify ----------

/**
 * ⚠️ 期望值是**双括号**，这是既定约定不是 bug：
 * markdown `[[第3页]](#unit-3)` 的链接**显示文本**就是 `[第3页]`（含方括号），
 * 与模型原文/时间戳引用 `[[03:25]](#seek-205)` 的呈现完全一致。
 * 别把它「修」成单括号，那会让材料引用看起来和视频引用不是一套东西。
 */
test('材料引用转成 #unit-N 链接（显示文本保留方括号）', () => {
  assert.equal(linkifyUnits('见[第3页]所述', 'page'), '见[[第3页]](#unit-3)所述');
  assert.equal(linkifyUnits('[第 12 段]是重点', 'para'), '[[第 12 段]](#unit-12)是重点');
  assert.equal(UNIT_LINK_PREFIX, '#unit-');
});

test('与既有 linkifyTimestamps 的括号约定一致（防回归）', () => {
  assert.equal(linkifyTimestamps('见[03:25]所述'), '见[[03:25]](#seek-205)所述');
  assert.equal(linkifyUnits('见[第3页]所述', 'page'), '见[[第3页]](#unit-3)所述');
});

test('代码围栏与行内代码里不动（否则会把示例代码改坏）', () => {
  const fenced = '```\n引用写法 [第3页]\n```';
  assert.equal(linkifyUnits(fenced, 'page'), fenced);
  assert.equal(linkifyUnits('用 `[第3页]` 表示引用', 'page'), '用 `[第3页]` 表示引用');
});

test('材料引用不碰时间戳，时间戳也不碰材料引用', () => {
  assert.equal(linkifyUnits('见[03:25]和[第2段]', 'para'), '见[03:25]和[[第2段]](#unit-2)');
  assert.equal(linkifyTimestamps('见[第3页]'), '见[第3页]');
});

test('页/段两种类型各认各的', () => {
  assert.equal(linkifyUnits('[第3页]', 'para'), '[第3页]');
  assert.equal(linkifyUnits('[第3段]', 'page'), '[第3段]');
});

test('链接由 fmtUnitRef 往返一致', () => {
  const n = 42;
  const md = linkifyUnits(`[${fmtUnitRef('page', n)}]`, 'page');
  assert.equal(md, '[[第42页]](#unit-42)');
  // 链接显示文本 → 单元号，能原路反解回来（跳页依赖这条）。
  // 注意用 [^[\]]+ 取「最内层」方括号内容：外层还有一层 markdown 链接括号。
  assert.equal(parseUnitRef(md.match(/\[([^[\]]+)\]/)[1], 'page'), n);
});

// ---------- 汇总 ----------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
