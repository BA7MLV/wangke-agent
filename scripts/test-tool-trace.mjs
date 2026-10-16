#!/usr/bin/env node
/**
 * 工具调用「人话层」契约测试（src/utils/toolTrace.ts）。
 *
 * 这份逻辑守的是**三处文案的一致性**：流式状态行、会话里的工具链、历史回放读的是同一张表。
 * 覆盖点：
 * - 18 个已注册工具都有动作短语（新增工具忘登记 → 用户看到英文函数名）
 * - 未注册工具原样返回，不抛错、不显示空白
 * - detail 只取一个参数；参数 JSON 半截 / 写坏时不抛，退化成「没有 detail」
 * - 时间类参数转 mm:ss（用户脑子里的时间轴不是「第 83 秒」）
 * - 结果摘要压成一行并截断
 *
 * 运行：node scripts/test-tool-trace.mjs
 */
import assert from 'node:assert/strict';
import {
  toolLabel,
  toolDetail,
  toolHint,
  summarizeToolResult,
  isToolFailure,
} from '../src/utils/toolTrace.ts';

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

/**
 * 工具注册表的镜像 —— 刻意**手抄一份**而不是从 harness/tools.ts 里 import：
 * 那边 import 链上挂着 IndexedDB 与 settings（模块级副作用），纯 Node 里跑不起来。
 * 代价是新增工具时这里要跟着加一行，而这正是本测试想暴露的事（见下一条断言）。
 */
const TOOL_NAMES = [
  'search_transcript',
  'search_material',
  'get_transcript_range',
  'get_material_range',
  'list_frames',
  'present_quiz',
  'show_widget',
  'edit_markdown',
  'use_skill',
  'read_skill_reference',
  'search_course_library',
  'list_courses',
  'get_learning_overview',
  'get_course_details',
  'set_course_context',
  'ask_user',
  'list_folders',
  'propose_folder_plan',
];

test('每个已注册工具都有中文动作短语（不是原样吐英文名）', () => {
  for (const name of TOOL_NAMES) {
    const label = toolLabel(name);
    assert.notEqual(label, name, `${name} 没登记动作短语，界面会显示英文函数名`);
    assert.ok(/[\u4e00-\u9fa5]/.test(label), `${name} 的动作短语该是中文：${label}`);
  }
});

test('未注册的工具名原样返回，不抛也不留空', () => {
  assert.equal(toolLabel('brand_new_tool'), 'brand_new_tool');
  assert.equal(toolLabel(''), '');
});

test('检索类工具把查询词带出来', () => {
  assert.equal(toolDetail('search_transcript', '{"query":"傅里叶变换"}'), '傅里叶变换');
  assert.equal(toolDetail('search_material', '{"query":" 假设检验 "}'), '假设检验');
  assert.equal(toolDetail('search_course_library', '{"query":"极限"}'), '极限');
});

test('技能类工具把技能名带出来', () => {
  assert.equal(toolDetail('use_skill', '{"name":"科目三-教学设计"}'), '科目三-教学设计');
  assert.equal(
    toolDetail('read_skill_reference', '{"name":"接口规范","path":"references/terms.md"}'),
    '接口规范',
    '一行里只放一个参数：取 name 而不是 path',
  );
});

test('材料范围取 from，不做时间格式化', () => {
  assert.equal(toolDetail('get_material_range', '{"from":12,"to":14}'), '12');
});

test('字幕范围把秒转成 mm:ss', () => {
  assert.equal(toolDetail('get_transcript_range', '{"start":83,"end":150}'), '1:23');
  assert.equal(toolDetail('get_transcript_range', '{"start":5,"end":30}'), '0:05');
  assert.equal(toolDetail('get_transcript_range', '{"start":3725,"end":3800}'), '62:05');
});

test('无参数工具与缺字段的参数都没有 detail（标题只报动作）', () => {
  assert.equal(toolDetail('list_frames', '{}'), undefined);
  assert.equal(toolDetail('present_quiz', '{"questions":[]}'), undefined);
  assert.equal(toolDetail('search_transcript', '{}'), undefined);
  assert.equal(toolDetail('search_transcript', '{"query":"   "}'), undefined);
});

test('参数 JSON 半截或写坏时退化成「没有 detail」，不抛错', () => {
  // 流式拼装期间 onToolStart 拿到的就是半截 JSON，这条路径每天都在走
  assert.equal(toolDetail('search_transcript', '{"query":"傅里'), undefined);
  assert.equal(toolDetail('search_transcript', ''), undefined);
  assert.equal(toolDetail('search_transcript', undefined), undefined);
  assert.doesNotThrow(() => toolHint('search_transcript', 'not json'));
});

test('detail 过长时截断（工具链一行放不下整段提问）', () => {
  const long = '傅'.repeat(80);
  const detail = toolDetail('search_transcript', JSON.stringify({ query: long }));
  assert.ok(detail.length <= 41, `截断后不该超过 41 字：${detail.length}`);
  assert.ok(detail.endsWith('…'));
});

test('状态行：有 detail 用冒号接，没有就用省略号', () => {
  assert.equal(toolHint('search_transcript', '{"query":"傅里叶"}'), '正在检索字幕：傅里叶');
  assert.equal(toolHint('list_frames', '{}'), '正在查看课程画面…');
});

test('提问卡的状态行是等待口吻，不是「正在…」', () => {
  assert.equal(toolHint('ask_user', '{}'), '等你选一个…');
});

test('未注册工具的状态行用调用方给的兜底文案', () => {
  assert.equal(toolHint('brand_new_tool', '{}', '正在读取课程库…'), '正在读取课程库…');
  assert.equal(toolHint('brand_new_tool', '{}'), '正在处理…');
});

test('结果摘要压成一行', () => {
  const raw = '[00:12] 大家好\n\n[00:30] 今天我们讲傅里叶';
  assert.equal(summarizeToolResult(raw), '[00:12] 大家好 [00:30] 今天我们讲傅里叶');
});

test('结果摘要超长截断，空结果返回空串', () => {
  const long = '字'.repeat(300);
  const out = summarizeToolResult(long, 20);
  assert.equal(out, `${'字'.repeat(20)}…`);
  assert.equal(summarizeToolResult('   \n\t '), '');
  assert.equal(summarizeToolResult('未检索到相关字幕内容。'), '未检索到相关字幕内容。');
});

test('结果摘要把 Markdown 链接还原成可读文字', () => {
  // list_courses / search_course_library 的结果里带课程链接，那是给模型抄的，不是给人读的
  assert.equal(
    summarizeToolResult('- [《高等数学（上）》](#/player/c-math) 视频课程 尚未开始'),
    '- 《高等数学（上）》 视频课程 尚未开始',
  );
  // 字幕命中那种 [00:12] 方括号不是链接，不许被吃掉
  assert.equal(summarizeToolResult('[00:12] 大家好 [00:30] 讲傅里叶'), '[00:12] 大家好 [00:30] 讲傅里叶');
});

test('只有执行器抛错才算失败，工具自己说的「未检索到」不算', () => {
  // 前缀与 harness/agent.ts 里 `工具执行失败：${…}` 对齐；改了那边这里会红
  assert.equal(isToolFailure('工具执行失败：db is not defined'), true);
  assert.equal(isToolFailure('未检索到相关字幕内容。'), false);
  assert.equal(isToolFailure('该时间范围内没有字幕内容。'), false);
  assert.equal(isToolFailure(''), false);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;