#!/usr/bin/env node
/**
 * 问答画面引用契约测试：
 * - linkifyFrames 把 [图@mm:ss] 转成 #frame- 协议的 markdown 图片（供自定义 img 组件渲染）
 * - linkifyTimestamps 既有行为不变，且与 linkifyFrames 组合后不互相干扰
 * - formatFrameList 生成 list_frames 工具输出的画面清单
 * - PROMPTS.qaSystem 按 hasFrames 注入画面引用规则
 * 运行：node scripts/test-chat-frames.mjs
 */
import assert from 'node:assert/strict';
import { linkifyFrames, linkifyTimestamps, formatFrameList } from '../src/utils/linkify.ts';
import { PROMPTS } from '../src/harness/prompts.ts';

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

test('linkifyFrames 转换 [图@mm:ss] 为 #frame- 图片', () => {
  const out = linkifyFrames('对比见 [图@03:25] 所示。');
  assert.equal(out, '对比见 ![课程画面 03:25](#frame-205) 所示。');
});

test('linkifyFrames 支持 h:mm:ss', () => {
  const out = linkifyFrames('[图@1:02:03]');
  assert.equal(out, '![课程画面 1:02:03](#frame-3723)');
});

test('linkifyFrames 不动普通文本与普通时间戳', () => {
  const s = '没有标记 [03:25] 和 [图@] 残次标记';
  assert.equal(linkifyFrames(s), s);
});

test('linkifyTimestamps 既有行为：转 #seek- 链接', () => {
  assert.equal(linkifyTimestamps('见 [03:25]'), '见 [[03:25]](#seek-205)');
});

test('组合转换：画面标记成图片、普通时间戳成跳转链接，互不干扰', () => {
  const out = linkifyTimestamps(linkifyFrames('在 [03:25] 讲了定义，画面见 [图@04:10]。'));
  assert.ok(out.includes('[[03:25]](#seek-205)'), `缺 seek 链接：${out}`);
  assert.ok(out.includes('![课程画面 04:10](#frame-250)'), `缺画面图片：${out}`);
  assert.ok(!out.includes('[图@'), `残留原始标记：${out}`);
});

test('formatFrameList 输出按时间排序的 [mm:ss] 描述清单', () => {
  const out = formatFrameList([
    { ts: 250, caption: '第二章标题页' },
    { ts: 30.4, caption: '课程封面与学习目标' },
  ]);
  assert.equal(out, '[0:30] 课程封面与学习目标\n[4:10] 第二章标题页');
});

test('formatFrameList 空清单给出兜底文案', () => {
  assert.match(formatFrameList([]), /暂无可用画面/);
});

test('formatFrameList 缺 caption 时有占位描述', () => {
  assert.match(formatFrameList([{ ts: 65 }]), /\[1:05\] （无画面描述）/);
});

test('qaSystem 默认不含画面引用规则', () => {
  const p = PROMPTS.qaSystem('测试课程');
  assert.ok(!p.includes('list_frames'), '不应出现 list_frames');
  assert.ok(!p.includes('[图@'), '不应出现画面标记');
});

test('qaSystem hasFrames=true 时注入 list_frames 与 [图@mm:ss] 规则', () => {
  const p = PROMPTS.qaSystem('测试课程', undefined, true);
  assert.match(p, /list_frames/);
  assert.match(p, /\[图@mm:ss\]/);
});

test('qaSystem 技能与画面规则可共存且编号连续', () => {
  const p = PROMPTS.qaSystem('测试课程', '技能A：用途A', true);
  assert.match(p, /6\. .*present_quiz/);
  assert.match(p, /7\. 可用的技能/);
  assert.match(p, /8\. .*list_frames/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
