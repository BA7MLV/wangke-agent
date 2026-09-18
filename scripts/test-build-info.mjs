#!/usr/bin/env node
// 构建信息纯逻辑：时间补零 / 本地时区（不是 UTC）/ commit 缺失降级 / dev 分支 / 注入值被清空时的兜底。
//
// 为什么这些要单测：它们是页脚文案的全部分支，且都跟「时区」「补零」这类
// 只在特定时刻才暴露的边界有关 —— 平时看着对，跨月/跨零点/换设备就错。
// 真正「注入有没有通到 DOM」由 e2e 覆盖（单测测不出 define 配没配对）。
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `test-build-info-${Date.now()}.mjs`);

execSync(
  `node_modules/.bin/esbuild src/utils/buildInfo.ts --bundle --platform=node --format=esm --outfile=${tmp}`,
  { cwd: root, stdio: 'inherit' },
);

const { formatBuildTime, buildInfoLabel } = await import(tmp);

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

const info = (over = {}) => ({ version: '0.1.0', time: '2026-09-18 19:40', commit: '5ffa0c7', ...over });

console.log('formatBuildTime');

test('个位数月/日/时/分都补零', () => {
  assert.equal(formatBuildTime(new Date(2026, 0, 5, 3, 7)), '2026-01-05 03:07');
});

test('常规值原样输出', () => {
  assert.equal(formatBuildTime(new Date(2026, 8, 18, 19, 40)), '2026-09-18 19:40');
});

test('年末最后一分钟不被进位', () => {
  assert.equal(formatBuildTime(new Date(2026, 11, 31, 23, 59)), '2026-12-31 23:59');
});

// 这条是刻意的：new Date(y, m, d, h, min) 按**本地时区**构造，
// 如果实现用了 getUTCMonth 之类，在 GMT+8 下零点会被算成前一天 16:00，这里就会红。
test('按本地时区取，不按 UTC', () => {
  assert.equal(formatBuildTime(new Date(2026, 0, 1, 0, 0)), '2026-01-01 00:00');
});

test('输出格式与 e2e 断言的正则同形', () => {
  assert.match(formatBuildTime(new Date()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

console.log('buildInfoLabel');

test('生产：版本 · 时间 · commit', () => {
  assert.equal(buildInfoLabel(info(), false), 'v0.1.0 · 2026-09-18 19:40 · 5ffa0c7');
});

test('开发模式：不展示注入的时间（那是配置加载时刻，不是构建）', () => {
  assert.equal(buildInfoLabel(info(), true), 'v0.1.0 · 开发模式');
});

test('取不到 commit（CI 导出源码包 / 没装 git）：收敛成两段', () => {
  assert.equal(buildInfoLabel(info({ commit: '' }), false), 'v0.1.0 · 2026-09-18 19:40');
});

test('commit 是空白字符时同样不展示', () => {
  assert.equal(buildInfoLabel(info({ commit: '   ' }), false), 'v0.1.0 · 2026-09-18 19:40');
});

test('时间缺失时保留版本与 commit，不留空行', () => {
  assert.equal(buildInfoLabel(info({ time: '' }), false), 'v0.1.0 · 5ffa0c7');
});

test('注入整体为空：仍给出可读文案，不是空白', () => {
  assert.equal(buildInfoLabel(null, false), '未知版本');
  assert.equal(buildInfoLabel(undefined, false), '未知版本');
});

test('版本号不写成 vunknown（那看着像个真版本号，更难发现注入丢了）', () => {
  assert.equal(buildInfoLabel(info({ version: '' }), false), '未知版本 · 2026-09-18 19:40 · 5ffa0c7');
});

test('各段两侧不留多余空白', () => {
  assert.equal(buildInfoLabel(info({ version: ' 0.2.0 ' }), false), 'v0.2.0 · 2026-09-18 19:40 · 5ffa0c7');
});

unlinkSync(tmp);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
