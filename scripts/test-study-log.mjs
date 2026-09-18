#!/usr/bin/env node
/**
 * 学习时长的纯逻辑断言（无需 API key / 无需起服务）。
 * 运行：node scripts/test-study-log.mjs
 *
 * 重点守三件最容易错的事：
 *   1. 日期键用**本地**日期（用 toISOString 会在东八区凌晨把记录算到前一天）；
 *   2. 跨零点的心跳要按本地零点切成两天，不能整段记在一边；
 *   3. 热力图网格的列数/行序/月份标签落点（列数不对整张图就错位）。
 */
import assert from 'node:assert/strict';
import {
  buildHeatmap,
  computeStats,
  dateKey,
  formatDayLabel,
  formatStudyDuration,
  heatLevel,
  HEAT_STEPS_MINUTES,
  mergeSeconds,
  relativeDayLabel,
  shiftDays,
  shortDayLabel,
  splitByDay,
  toSecondsMap,
  weekStart,
} from '../src/utils/studyLog.ts';

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

// ── 日期键与日期运算 ──────────────────────────────────────────────────────

test('dateKey 用本地日期：本地零点前后分属两天', () => {
  const midnight = new Date(2026, 8, 18, 0, 0, 1); // 2026-09-18 00:00:01 本地
  const before = new Date(2026, 8, 17, 23, 59, 59);
  assert.equal(dateKey(midnight.getTime()), '2026-09-18');
  assert.equal(dateKey(before.getTime()), '2026-09-17');
});

test('dateKey 不受 UTC 偏移影响（东八区凌晨不会被算成前一天）', () => {
  // 本地 2026-09-18 07:00 → UTC 是 2026-09-17T23:00Z。若用 toISOString 就会得到 17 号。
  const ts = new Date(2026, 8, 18, 7, 0, 0).getTime();
  assert.equal(dateKey(ts), '2026-09-18');
});

test('shiftDays 跨月跨年正确', () => {
  assert.equal(shiftDays('2026-09-18', 1), '2026-09-19');
  assert.equal(shiftDays('2026-09-30', 1), '2026-10-01');
  assert.equal(shiftDays('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDays('2024-02-28', 1), '2024-02-29'); // 闰年
});

test('weekStart 取所在周的周日', () => {
  // 2026-09-18 是周五
  assert.equal(new Date(2026, 8, 18).getDay(), 5);
  assert.equal(weekStart('2026-09-18'), '2026-09-13');
  assert.equal(weekStart('2026-09-13'), '2026-09-13'); // 周日自己是周首
});

// ── 跨天切分 ──────────────────────────────────────────────────────────────

test('splitByDay 不跨天时是一段', () => {
  const from = new Date(2026, 8, 18, 10, 0, 0).getTime();
  const out = splitByDay(from, from + 15_000);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { date: '2026-09-18', seconds: 15 });
});

test('splitByDay 跨零点切成两天（秒数不丢不重）', () => {
  const from = new Date(2026, 8, 18, 23, 59, 50).getTime();
  const to = from + 15_000; // 到 2026-09-19 00:00:05
  const out = splitByDay(from, to);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { date: '2026-09-18', seconds: 10 });
  assert.deepEqual(out[1], { date: '2026-09-19', seconds: 5 });
  assert.equal(
    out.reduce((s, d) => s + d.seconds, 0),
    15,
  );
});

test('splitByDay 异常输入返回空（不倒扣、不死循环）', () => {
  assert.deepEqual(splitByDay(1000, 1000), []);
  assert.deepEqual(splitByDay(2000, 1000), []);
  assert.deepEqual(splitByDay(NaN, 1000), []);
});

// ── 合并与热力档位 ────────────────────────────────────────────────────────

test('mergeSeconds 同日累加', () => {
  const map = new Map([['2026-09-18', 60]]);
  mergeSeconds(map, [
    { date: '2026-09-18', seconds: 15 },
    { date: '2026-09-19', seconds: 30 },
  ]);
  assert.equal(map.get('2026-09-18'), 75);
  assert.equal(map.get('2026-09-19'), 30);
});

test('toSecondsMap 把重复行合并（库里理论上不会重复，读的时候也不该被它带偏）', () => {
  const map = toSecondsMap([
    { date: '2026-09-18', seconds: 10 },
    { date: '2026-09-18', seconds: 5 },
  ]);
  assert.equal(map.get('2026-09-18'), 15);
});

test('heatLevel 按 15/45/90 分钟分档', () => {
  const [a, b, c] = HEAT_STEPS_MINUTES;
  assert.equal(heatLevel(0), 0);
  assert.equal(heatLevel(1), 1);
  assert.equal(heatLevel(a * 60 - 1), 1);
  assert.equal(heatLevel(a * 60), 2);
  assert.equal(heatLevel(b * 60 - 1), 2);
  assert.equal(heatLevel(b * 60), 3);
  assert.equal(heatLevel(c * 60), 4);
  assert.equal(heatLevel(c * 60 * 10), 4);
});

// ── 热力图网格 ────────────────────────────────────────────────────────────

test('buildHeatmap：列数 = weeks，每列 7 行，最后一列是本周', () => {
  const today = '2026-09-18';
  const { weeks } = buildHeatmap({ today, weeks: 53, seconds: new Map() });
  assert.equal(weeks.length, 53);
  for (const col of weeks) assert.equal(col.length, 7);
  // 行序：周日…周六
  assert.equal(weeks[0][0].date, weekStart(shiftDays(today, -(53 - 1) * 7)));
  // 最后一列的第一天是本周周日
  assert.equal(weeks[52][0].date, weekStart(today));
  // 今天在最后一列里，且不是 future
  const flat = weeks.flat();
  const todayCell = flat.find((c) => c.date === today);
  assert.ok(todayCell, '今天应该在网格里');
  assert.equal(todayCell.future, false);
});

test('buildHeatmap：本周内今天之后的格子标 future，且不取秒数', () => {
  const today = '2026-09-18'; // 周五
  const seconds = new Map([['2026-09-19', 600], ['2026-09-20', 600]]); // 周六 / 周日（未来）
  const { weeks } = buildHeatmap({ today, weeks: 2, seconds });
  const last = weeks[1];
  assert.equal(last[5].date, '2026-09-18');
  assert.equal(last[5].future, false);
  assert.equal(last[6].date, '2026-09-19');
  assert.equal(last[6].future, true);
  assert.equal(last[6].seconds, 0);
  assert.equal(last[6].level, 0);
});

test('buildHeatmap：月份标签落在含「1 号」的那一列上', () => {
  const { months, weeks } = buildHeatmap({ today: '2026-09-18', weeks: 53, seconds: new Map() });
  // 首列那个标签是「补」出来的（该列里没有 1 号，标的是它所属的月份）；
  // 其余每个标签都必须落在含 1 号的那一列上。
  for (const m of months.slice(1)) {
    const col = weeks[m.index];
    const hasFirst = col.some((c) => c.date.slice(-2) === '01');
    assert.ok(hasFirst, `第 ${m.index} 列的标签 ${m.label} 应该落在含 1 号的列上`);
  }
  assert.equal(months[0].label, `${Number(weeks[0][0].date.slice(5, 7))}月`);
  // 标签按列号升序，且首列一定有标签（否则最左边没有月份可参照）
  const idx = months.map((m) => m.index);
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  assert.equal(idx[0], 0);
});

test('buildHeatmap：档位跟着秒数走（用同一份 heatLevel）', () => {
  const today = '2026-09-18';
  const seconds = new Map([['2026-09-18', 46 * 60]]); // 46 分钟 → 3 档
  const { weeks } = buildHeatmap({ today, weeks: 1, seconds });
  const cell = weeks[0].find((c) => c.date === today);
  assert.equal(cell.level, 3);
  assert.equal(cell.seconds, 46 * 60);
});

// ── 统计 ──────────────────────────────────────────────────────────────────

test('computeStats：累计 / 活跃天 / 今日 / 近 7 天 / 最佳单日', () => {
  const rows = [
    { date: '2026-09-17', seconds: 3600 },
    { date: '2026-09-18', seconds: 600 },
    { date: '2026-09-01', seconds: 1800 },
  ];
  const s = computeStats(rows, '2026-09-18');
  assert.equal(s.totalSeconds, 6000);
  assert.equal(s.activeDays, 3);
  assert.equal(s.todaySeconds, 600);
  assert.equal(s.weekSeconds, 4200); // 17 日 + 18 日
  assert.equal(s.weekActiveDays, 2); // 窗口内只有 17、18 两天有记录
  assert.deepEqual(s.best, { date: '2026-09-17', seconds: 3600 });
  assert.equal(s.averageSeconds, 2000); // 全期口径：6000 / 3
});

test('computeStats：日均是全期口径、weekActiveDays 是窗口口径，两者不能混用', () => {
  // 造一份「很久以前学过很多、近 7 天只学了 10 分钟」的数据：
  // 一旦有人把全期的 averageSeconds 拿去配「近 7 天」那张卡，数字会差一个数量级。
  const rows = [
    { date: '2026-01-10', seconds: 7200 },
    { date: '2026-09-18', seconds: 600 },
  ];
  const s = computeStats(rows, '2026-09-18');
  assert.equal(s.totalSeconds, 7800);
  assert.equal(s.activeDays, 2);
  assert.equal(s.averageSeconds, 3900); // 全期：7800 / 2
  assert.equal(s.weekSeconds, 600); // 窗口：只有今天
  assert.equal(s.weekActiveDays, 1); // 窗口内活跃 1 天
  // 「近 7 天」卡上无论按活跃日均（600）还是按 7 天摊（约 86）都该是这个量级；
  // 全期的 3900 一旦出现在那里，就是标题与数字口径错位。
  const weekDaily = s.weekSeconds / s.weekActiveDays;
  assert.equal(weekDaily, 600);
  assert.ok(s.averageSeconds > weekDaily * 5, '全期日均应与窗口口径明显不同，否则这条守不住错位');
});

test('computeStats：连续天数按「还活着」算（今天没开始学不算断）', () => {
  const rows = [
    { date: '2026-09-14', seconds: 60 },
    { date: '2026-09-15', seconds: 60 },
    { date: '2026-09-16', seconds: 60 },
    { date: '2026-09-17', seconds: 60 },
  ];
  // 今天（18 日）还没有记录：连续天数从昨天往回数 = 4
  const s = computeStats(rows, '2026-09-18');
  assert.equal(s.currentStreak, 4);
  assert.equal(s.longestStreak, 4);
  assert.equal(s.todaySeconds, 0);
});

test('computeStats：断了一天就归零，最长连续单独记', () => {
  const rows = [
    { date: '2026-09-10', seconds: 60 },
    { date: '2026-09-11', seconds: 60 },
    { date: '2026-09-12', seconds: 60 },
    // 13 日缺
    { date: '2026-09-14', seconds: 60 },
    { date: '2026-09-15', seconds: 60 },
  ];
  const s = computeStats(rows, '2026-09-18');
  assert.equal(s.currentStreak, 0); // 今天、昨天都没有
  assert.equal(s.longestStreak, 3);
});

test('computeStats：0 秒的行不算「活跃」', () => {
  const rows = [
    { date: '2026-09-17', seconds: 0 },
    { date: '2026-09-18', seconds: 60 },
  ];
  const s = computeStats(rows, '2026-09-18');
  assert.equal(s.activeDays, 1);
  assert.equal(s.totalSeconds, 60);
});

test('computeStats：空数据不炸', () => {
  const s = computeStats([], '2026-09-18');
  assert.equal(s.totalSeconds, 0);
  assert.equal(s.activeDays, 0);
  assert.equal(s.best, null);
  assert.equal(s.currentStreak, 0);
  assert.equal(s.averageSeconds, 0);
});

// ── 格式化 ────────────────────────────────────────────────────────────────

test('formatStudyDuration', () => {
  assert.equal(formatStudyDuration(0), '0 分');
  assert.equal(formatStudyDuration(30), '不到 1 分钟');
  assert.equal(formatStudyDuration(60), '1 分');
  assert.equal(formatStudyDuration(59 * 60), '59 分');
  assert.equal(formatStudyDuration(3600), '1 小时');
  assert.equal(formatStudyDuration(3600 + 5 * 60), '1 小时 05 分');
  assert.equal(formatStudyDuration(2 * 3600 + 59 * 60), '2 小时 59 分');
});

test('formatDayLabel / relativeDayLabel', () => {
  assert.equal(formatDayLabel('2026-09-18'), '2026年9月18日 周五');
  assert.equal(shortDayLabel('2026-09-18'), '9月18日 周五');
  assert.equal(relativeDayLabel('2026-09-18', '2026-09-18'), '今天');
  assert.equal(relativeDayLabel('2026-09-17', '2026-09-18'), '昨天');
  assert.equal(relativeDayLabel('2026-09-10', '2026-09-18'), '9月10日 周四');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.map((f) => `  ✗ ${f.name}: ${f.error.message}`).join('\n'));
  process.exit(1);
}
