#!/usr/bin/env node
/**
 * 主页进度条的纯逻辑断言（该不该画、画多长）。
 *
 * 重点不在「比例算得对不对」（那太简单），而在几条**边界与顺序**：
 *   - 材料不走这套口径（它是 lastUnit / unitCount）
 *   - duration 非法时连「已看完」都不画（记录本身残缺）
 *   - finished 要能纠正 lastPosition = 0 的历史数据
 *   - 1% 阈值两侧的行为必须钉死，否则「看了 2 秒」会被画成一丝细线
 *
 * 运行：node scripts/test-video-progress.mjs
 */
import assert from 'node:assert/strict';

const { progressRatio, MIN_VISIBLE_RATIO } = await import('../src/utils/videoProgress.ts');

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

test('阈值契约：1%（改这个数会让 e2e 的播种数据失准）', () => {
  assert.equal(MIN_VISIBLE_RATIO, 0.01);
});

test('阅读材料恒为 null —— 它的进度是页/段，另一套口径', () => {
  assert.equal(progressRatio({ kind: 'material', duration: 0 }), null);
  // 就算带上视频那套字段也不画
  assert.equal(progressRatio({ kind: 'material', duration: 1200, lastPosition: 600 }), null);
  assert.equal(progressRatio({ kind: 'material', duration: 1200, finished: 1 }), null);
});

test('duration 非法 → null（时长都没探到，画什么都是错的）', () => {
  assert.equal(progressRatio({ duration: 0, lastPosition: 100 }), null);
  assert.equal(progressRatio({ duration: -1, lastPosition: 100 }), null);
  assert.equal(progressRatio({ duration: Number.NaN, lastPosition: 100 }), null);
  assert.equal(progressRatio({ duration: Number.POSITIVE_INFINITY, lastPosition: 100 }), null);
});

test('duration 非法时「已看完」也不画（顺序：duration 判定在 finished 之前）', () => {
  // 这条是刻意定的顺序：列表里连时长都显示成「—」，给它画满条只会更怪
  assert.equal(progressRatio({ duration: 0, finished: 1 }), null);
  assert.equal(progressRatio({ duration: Number.NaN, finished: 1 }), null);
});

test('finished === 1 → 满条', () => {
  assert.equal(progressRatio({ duration: 1200, finished: 1 }), 1);
  // 播完时 lastPosition 本来就停在结尾，两者一致
  assert.equal(progressRatio({ duration: 1200, lastPosition: 1200, finished: 1 }), 1);
});

test('finished 能纠正 lastPosition = 0 的历史数据', () => {
  // 改动前「播完归零」写下的记录：位置是 0、标记是 1（迁移后补的或新写的）
  assert.equal(progressRatio({ duration: 1200, lastPosition: 0, finished: 1 }), 1);
});

test('没看过 → null（缺失 / 0 / 负数 / NaN）', () => {
  assert.equal(progressRatio({ duration: 1200 }), null);
  assert.equal(progressRatio({ duration: 1200, lastPosition: 0 }), null);
  assert.equal(progressRatio({ duration: 1200, lastPosition: -5 }), null);
  assert.equal(progressRatio({ duration: 1200, lastPosition: Number.NaN }), null);
  assert.equal(progressRatio({ duration: 1200, finished: 0, lastPosition: 0 }), null);
});

test('正常比例', () => {
  assert.equal(progressRatio({ duration: 1200, lastPosition: 600 }), 0.5);
  assert.equal(progressRatio({ duration: 1200, lastPosition: 300 }), 0.25);
  assert.equal(progressRatio({ duration: 1200, lastPosition: 1199 }), 1199 / 1200);
});

test('1% 阈值：恰好 1% 画，略低不画', () => {
  const at = progressRatio({ duration: 1200, lastPosition: 12 });
  assert.notEqual(at, null, '恰好 1% 应该画');
  assert.ok(Math.abs(at - 0.01) < 1e-9);

  assert.equal(progressRatio({ duration: 1200, lastPosition: 11 }), null, '略低于 1% 不画');
  // 40 分钟的课看 5 秒 = 0.2%，画出来不到 1px，宁可不画
  assert.equal(progressRatio({ duration: 2400, lastPosition: 5 }), null);
});

test('lastPosition 超过 duration 时夹到 1（时长探测误差会算出 100.4%）', () => {
  assert.equal(progressRatio({ duration: 1200, lastPosition: 1205 }), 1);
  assert.equal(progressRatio({ duration: 1200, lastPosition: 99999 }), 1);
});

test('返回值恒在 (0, 1] 或 null —— 调用方拿去做百分比不用再防', () => {
  const samples = [12, 60, 600, 1200, 1205];
  for (const lastPosition of samples) {
    const r = progressRatio({ duration: 1200, lastPosition });
    assert.ok(r === null || (r > 0 && r <= 1), `lastPosition=${lastPosition} 得到 ${r}`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
