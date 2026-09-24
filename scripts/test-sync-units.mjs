#!/usr/bin/env node
/**
 * 同步单元（`src/sync/units.ts`）的纯逻辑单测。
 *
 * 单元 id 是同步协议的**唯一寻址方式**，拼错或解析歧义的后果不是报错，而是
 * 「同一条数据在两台设备上算出两个键」—— 表现为静默重复或静默丢失，比崩溃难查得多。
 * 该模块只 `import type`，所以 Node 能直接读 TS 源码，不用打包。
 *
 * ## 本脚本**不管**什么
 *
 * 「新加的 `Settings` / `VideoRow` 字段有没有被归类」由**编译期守门员**负责
 * （`ALL_SETTINGS_FIELDS_CLASSIFIED` / `ALL_VIDEO_FIELDS_CLASSIFIED`，`npm run build`
 * 里的 `tsc -b` 会拦住漏分类的字段）。不放这里的原因：加字段是编辑器里的动作，
 * 编译期反馈最及时；而单测要人记得跑。
 *
 * 这里管的是**类型管不到**的东西：白名单与排除项不得有交集、编码往返无歧义、
 * 分片边界、畸形输入不抛异常。
 *
 * 运行：node scripts/test-sync-units.mjs
 */
import assert from 'node:assert/strict';
import {
  VIDEO_UNIT_SUFFIXES,
  PART_BYTES,
  SETTINGS_UNIT,
  SYNC_SETTINGS_KEYS,
  NON_SYNC_SETTINGS_KEYS,
  videoUnit,
  videoUnits,
  folderUnit,
  skillUnit,
  studyUnit,
  parseUnit,
  partCount,
  pickSyncSettings,
} from '../src/sync/units.ts';

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

// ── 课程单元 ────────────────────────────────────────────────────────────────

test('课程单元 id 的形状', () => {
  assert.equal(videoUnit('abc', 'content'), 'video:abc:content');
  assert.equal(videoUnit('abc', 'meta'), 'video:abc:meta');
});

test('videoUnits 给出 5 个单元，顺序与 VIDEO_UNIT_SUFFIXES 一致', () => {
  const units = videoUnits('v1');
  assert.deepEqual(units, [
    'video:v1:meta',
    'video:v1:content',
    'video:v1:vectors',
    'video:v1:frames',
    'video:v1:cover',
  ]);
  // 删课程要给这 5 个都写墓碑，漏一个就会「复活」。数量与后缀常量绑定，避免手写清单漂移。
  assert.equal(units.length, VIDEO_UNIT_SUFFIXES.length);
});

test('5 种后缀逐个往返', () => {
  for (const suffix of VIDEO_UNIT_SUFFIXES) {
    const parsed = parseUnit(videoUnit('v-1', suffix));
    assert.deepEqual(parsed, { kind: 'video', id: 'v-1', suffix });
  }
});

test('id 里出现 `:` 时归到 id 一侧，后缀仍认对', () => {
  // uuid 不会有 `:`，但服务端数据不完全可信。解析走 lastIndexOf，所以这里能正确切分；
  // 若写成 split(':')[1] 就会把 id 截成 'a' —— 于是两台设备算出不同的键。
  assert.deepEqual(parseUnit('video:a:b:meta'), { kind: 'video', id: 'a:b', suffix: 'meta' });
});

test('空 id 被拒绝', () => {
  assert.equal(parseUnit('video::meta'), null);
});

test('缺后缀被拒绝', () => {
  assert.equal(parseUnit('video:x'), null);
});

test('未知后缀被拒绝', () => {
  assert.equal(parseUnit('video:x:blob'), null);
});

test('后缀大小写敏感', () => {
  assert.equal(parseUnit('video:x:Meta'), null);
});

// ── 文件夹 / 技能：名字要编码 ────────────────────────────────────────────────

test('文件夹名字含中文 / 空格 / 全角冒号时往返一致', () => {
  for (const name of ['第 3 章：入门', 'a/b', '100%', 'a:b', 'a?b#c', 'emoji 🎬']) {
    assert.deepEqual(parseUnit(folderUnit(name)), { kind: 'folder', name }, `名字: ${name}`);
  }
});

test('名字里的冒号被编码，id 不产生歧义', () => {
  // 不编码的话 `folder:a:b` 与 `folder:a` + 后缀 `b` 无从区分。
  assert.equal(folderUnit('a:b'), 'folder:a%3Ab');
});

test('文件夹与技能同名不冲突', () => {
  assert.match(folderUnit('x'), /^folder:/);
  assert.match(skillUnit('x'), /^skill:/);
  assert.notEqual(folderUnit('x'), skillUnit('x'));
});

test('技能名字往返一致', () => {
  assert.deepEqual(parseUnit(skillUnit('公考申论：结构')), { kind: 'skill', name: '公考申论：结构' });
});

test('空的文件夹名被拒绝（无名文件夹是 id 碰撞隐患）', () => {
  assert.equal(parseUnit(folderUnit('')), null);
});

test('畸形百分号转义返回 null 而不是抛异常', () => {
  // 畸形 id 可能来自服务端。一个坏 id 不该让整轮同步炸掉（不变量：同步失败不阻塞 UI）。
  assert.equal(parseUnit('folder:%'), null);
  assert.equal(parseUnit('skill:%E0%A4%A'), null);
});

// ── 学习时长：一天一个 ──────────────────────────────────────────────────────

test('学习时长日期往返', () => {
  assert.deepEqual(parseUnit(studyUnit('2026-09-23')), { kind: 'study', date: '2026-09-23' });
});

test('日期形状不合法一律拒绝', () => {
  // 形状错的日期会让「同一天」匹配不上，表现为「学习时长莫名少了一截」，很难查。
  for (const bad of ['2026-9-3', '', 'abc', '2026-09-23T00:00', '20260923', '2026-13-01x']) {
    assert.equal(parseUnit(studyUnit(bad)), null, `应拒绝: ${bad}`);
  }
});

// ── 设置 ────────────────────────────────────────────────────────────────────

test('设置单元解析', () => {
  assert.deepEqual(parseUnit(SETTINGS_UNIT), { kind: 'settings' });
  assert.equal(parseUnit('settings:x'), null);
});

test('设置白名单与排除项逐项吻合', () => {
  // 这是一条**故意的变更探测器**：改动白名单就必须同步改这里。
  // 它连同下面的「无交集」「必排除项」一起，把「谁能跟着数据走」钉成可审阅的清单。
  assert.deepEqual([...SYNC_SETTINGS_KEYS].sort(), [
    'agentRounds',
    'asrConcurrency',
    'asrModel',
    'baseUrl',
    'captionScale',
    'contextWindow',
    'customRates',
    'danmakuEnabled',
    'dynamicColor',
    'favorites',
    'llmModel',
    'studyIdleMinutes',
    'studyTrackingEnabled',
    'theme',
    'thinkingEffort',
    'thinkingEnabled',
    'visionModel',
  ]);
  assert.deepEqual([...NON_SYNC_SETTINGS_KEYS].sort(), [
    'apiKey',
    'bilibiliCookie',
    'bilibiliProxy',
    'syncEnabled',
    'syncEndpoint',
    'syncToken',
  ]);
});

test('白名单与排除项**没有交集**（类型管不到，只能在这里守）', () => {
  const sync = new Set(SYNC_SETTINGS_KEYS);
  const overlap = NON_SYNC_SETTINGS_KEYS.filter((k) => sync.has(k));
  assert.deepEqual(overlap, [], `同时出现在两张表里: ${overlap.join(', ')}`);
});

test('凭据永远不可同步：apiKey / bilibiliCookie 必须在排除项里', () => {
  // 即便有人重写了整张白名单，这两条也不许松动 —— 单列一个测试，让它红得显眼。
  assert.ok(NON_SYNC_SETTINGS_KEYS.includes('apiKey'));
  assert.ok(NON_SYNC_SETTINGS_KEYS.includes('bilibiliCookie'));
});

/** 一份「所有字段都填了值」的设置，含敏感值，用于验证白名单真的在拦 */
const FULL_SETTINGS = {
  apiKey: 'sk-SECRET',
  baseUrl: 'https://api.siliconflow.cn/v1',
  asrModel: 'asr-1',
  llmModel: 'llm-1',
  visionModel: 'vision-1',
  favorites: { chat: ['a'], vision: [], asr: [] },
  contextWindow: 131072,
  asrConcurrency: 4,
  thinkingEnabled: true,
  thinkingEffort: 'high',
  captionScale: 1.35,
  agentRounds: 6,
  bilibiliProxy: 'https://proxy.example.dev',
  bilibiliCookie: 'SESSDATA=SECRET',
  danmakuEnabled: true,
  customRates: [1.25, 3.5],
  theme: 'dark',
  dynamicColor: false,
  studyTrackingEnabled: true,
  studyIdleMinutes: 10,
  syncEnabled: true,
  syncEndpoint: 'https://sync.example.dev',
  syncToken: 'TOKEN-SECRET',
};

test('pickSyncSettings 只带出白名单字段', () => {
  const out = pickSyncSettings(FULL_SETTINGS);
  assert.deepEqual(Object.keys(out).sort(), [...SYNC_SETTINGS_KEYS].sort());
});

test('pickSyncSettings 不泄漏任何凭据 / 同步自身配置', () => {
  const out = pickSyncSettings(FULL_SETTINGS);
  for (const k of NON_SYNC_SETTINGS_KEYS) {
    assert.equal(k in out, false, `${k} 不该出现在同步载荷里`);
  }
  // 双保险：连值也不许以别的方式混进来
  assert.equal(JSON.stringify(out).includes('SECRET'), false);
});

test('pickSyncSettings 保留值，且不修改入参', () => {
  const snapshot = JSON.stringify(FULL_SETTINGS);
  const out = pickSyncSettings(FULL_SETTINGS);
  assert.equal(out.baseUrl, FULL_SETTINGS.baseUrl);
  assert.deepEqual(out.favorites, FULL_SETTINGS.favorites);
  assert.deepEqual(out.customRates, FULL_SETTINGS.customRates);
  assert.equal(out.studyIdleMinutes, 10);
  assert.equal(JSON.stringify(FULL_SETTINGS), snapshot);
});

// ── 分片 ────────────────────────────────────────────────────────────────────

test('分片阈值是 256KB', () => {
  assert.equal(PART_BYTES, 256 * 1024);
});

test('分片数的边界：空、不足一片、恰好一片、刚好越界', () => {
  assert.equal(partCount(0), 1, '空载荷也要占 1 片');
  assert.equal(partCount(1), 1);
  assert.equal(partCount(PART_BYTES - 1), 1);
  assert.equal(partCount(PART_BYTES), 1, '恰好等于阈值不该多切一片');
  assert.equal(partCount(PART_BYTES + 1), 2);
  assert.equal(partCount(PART_BYTES * 3), 3);
  assert.equal(partCount(PART_BYTES * 3 + 1), 4);
});

test('非法字节长度抛 RangeError', () => {
  for (const bad of [-1, NaN, Infinity, -Infinity]) {
    assert.throws(() => partCount(bad), RangeError, `应抛: ${bad}`);
  }
});

// ── 垃圾输入 ────────────────────────────────────────────────────────────────

test('无法识别的 id 一律返回 null，不抛异常', () => {
  assert.equal(parseUnit(''), null);
  assert.equal(parseUnit('unknown:a'), null);
  assert.equal(parseUnit('video'), null);
  assert.equal(parseUnit('folder'), null);
  // 远端数据可能不是字符串
  assert.equal(parseUnit(undefined), null);
  assert.equal(parseUnit(null), null);
  assert.equal(parseUnit(123), null);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
