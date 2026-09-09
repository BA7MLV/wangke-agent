#!/usr/bin/env node
/**
 * 提示词契约测试：PROMPTS.section 必须携带 IR JSON 输出契约；
 * PROMPTS.outline 契约保持不变。
 * 运行：node scripts/test-handout-prompts.mjs
 */
import assert from 'node:assert/strict';
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

const section = PROMPTS.section('执行时机', ['要点一'], '[00:00] 字幕', '- 03:25：对比图', {
  title: '测试讲义',
  summary: '概述',
  skillBlock: '【测试规范】',
});

test('section 提示词包含 IR blocks 契约', () => {
  assert.match(section, /"blocks"/);
});

test('section 提示词列出全部 7 种块类型', () => {
  for (const t of ['"lead"', '"para"', '"h2"', '"list"', '"table"', '"figure"', '"note"']) {
    assert.ok(section.includes(t), `缺块类型 ${t}`);
  }
});

test('figure 用 mm:ss 时间戳且要求从配图信息复制', () => {
  assert.match(section, /mm:ss/);
});

test('编号由渲染器生成：提示模型不要自写编号', () => {
  assert.match(section, /不要写.{0,8}编号|编号.{0,6}自动/);
});

test('skillBlock 注入位置保留', () => {
  assert.match(section, /【测试规范】/);
});

test('outline 契约不变（title/summary/sections）', () => {
  const outline = PROMPTS.outline('素材', '课程名', '规范块');
  assert.match(outline, /"title"/);
  assert.match(outline, /"summary"/);
  assert.match(outline, /"sections"/);
  assert.match(outline, /规范块/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
