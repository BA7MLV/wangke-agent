#!/usr/bin/env node
/**
 * 问答「技能范围」的三态语义单测。
 *
 * 只测 `src/skills/scope.ts` —— 它零依赖，Node 能直接 import TS 源码，不用打包。
 * 这是刻意拆出来的：这三条判定是全功能最容易写错的地方，而它们所在的
 * `skills/store.ts` 依赖链带着 Dexie 和内置 skill 的 `?raw` 资源，Node 打不动。
 * 装配层（会话读写、工具拒绝的端到端行为）交给 e2e-chat-skill-scope.mjs。
 *
 * 运行：node scripts/test-qa-skill-scope.mjs
 */
import assert from 'node:assert/strict';
import { isSkillLimited, intersectSkillIds, isSkillAllowed } from '../src/skills/scope.ts';

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

// 模拟一个「3 个启用技能」的库：id 1 / 2 / 3
const ENABLED = [1, 2, 3];

// ── isSkillLimited：三态的分界线 ────────────────────────────────────────────
// 这一组是整份设计的基石：`[]` 必须是「限定」，不能和 `undefined` 混为一谈。

test('undefined = 不限定（默认态、老会话）', () => {
  assert.equal(isSkillLimited(undefined), false);
});

test('[] = 限定，且是合法状态（不是「没设」）', () => {
  assert.equal(isSkillLimited([]), true);
});

test('[id] = 限定', () => {
  assert.equal(isSkillLimited([1]), true);
});

// ── intersectSkillIds：白名单 × 启用集合 ────────────────────────────────────

test('不限定 → 原样返回全部启用技能', () => {
  assert.deepEqual(intersectSkillIds(ENABLED, undefined), [1, 2, 3]);
});

test('限定为空集 → 一个都不给（不是退回全量）', () => {
  assert.deepEqual(intersectSkillIds(ENABLED, []), []);
});

test('白名单是启用集合的子集 → 只留选中的', () => {
  assert.deepEqual(intersectSkillIds(ENABLED, [2]), [2]);
});

test('白名单里的 id 已被禁用/删除 → 自动失效，不报错', () => {
  // 9 不在启用集合里。取交集天然把它剔掉 —— 这就是「禁用后自动失效」的实现方式，
  // 不需要另写一套 enabled 判断。
  assert.deepEqual(intersectSkillIds(ENABLED, [2, 9]), [2]);
});

test('白名单全是失效 id → 空集', () => {
  assert.deepEqual(intersectSkillIds(ENABLED, [8, 9]), []);
});

test('结果保持启用集合的原有顺序（不跟随白名单顺序）', () => {
  // 白名单写 [3,1]，结果仍是 [1,3]：展示顺序要稳定，不受用户勾选先后影响
  assert.deepEqual(intersectSkillIds(ENABLED, [3, 1]), [1, 3]);
});

test('不修改入参', () => {
  const enabled = [1, 2, 3];
  const allow = [3];
  intersectSkillIds(enabled, allow);
  assert.deepEqual(enabled, [1, 2, 3]);
  assert.deepEqual(allow, [3]);
});

// ── isSkillAllowed：工具层的放行条件 ────────────────────────────────────────

test('不限定 → 任意技能都放行（含不在启用集合里的）', () => {
  assert.equal(isSkillAllowed(1, undefined), true);
  assert.equal(isSkillAllowed(99, undefined), true);
});

test('限定为空集 → 一切拒绝（高危分支：写错就退化成「不限制」）', () => {
  assert.equal(isSkillAllowed(1, []), false);
  assert.equal(isSkillAllowed(undefined, []), false);
});

test('限定为集合 → 集合内放行、集合外拒绝', () => {
  assert.equal(isSkillAllowed(1, [1, 2]), true);
  assert.equal(isSkillAllowed(3, [1, 2]), false);
});

test('技能 id 缺失时一律拒绝（限定模式下）', () => {
  // skill.id 理论上必有值；但若库里出现无 id 的行，宁可拒绝也不要放行
  assert.equal(isSkillAllowed(undefined, [1, 2]), false);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
