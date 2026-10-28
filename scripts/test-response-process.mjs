import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processSteps, processTitle } from '../apps/web/src/utils/responseProcess.ts';

test('分析与重复工具按真实先后交错，连续工具不生成空分析', () => {
  const calls = [
    { name: 'grep', status: 'done', reasoningOffset: 2 },
    { name: 'grep', status: 'done', reasoningOffset: 4 },
    { name: 'read', status: 'done', reasoningOffset: 4 },
  ];
  const steps = processSteps('初想复查结论', calls);
  assert.deepEqual(steps.map((step) => step.kind === 'reasoning' ? step.text : step.call.name),
    ['初想', 'grep', '复查', 'grep', 'read', '结论']);
  assert.equal(new Set(steps.map((step) => step.key)).size, steps.length);
});

test('历史记录不猜交错顺序，仍完整显示分析与所有工具', () => {
  const calls = [{ name: 'grep', status: 'done' }, { name: 'read', status: 'done' }];
  assert.deepEqual(processSteps('旧分析', calls).map((step) => step.kind), ['reasoning', 'tool', 'tool']);
  assert.deepEqual(processSteps('', []), []);
  assert.equal(processSteps('只有分析', [])[0].text, '只有分析');
});

test('异常偏移夹在有效范围内，不重复或丢失正文', () => {
  const steps = processSteps('完整分析', [
    { name: 'read', status: 'done', reasoningOffset: 100 },
    { name: 'read', status: 'done', reasoningOffset: -1 },
  ]);
  assert.equal(steps.filter((step) => step.kind === 'reasoning').map((step) => step.text).join(''), '完整分析');
});

test('执行阶段决定标题，不用正文是否为空来猜正在思考', () => {
  const calls = [{ name: 'search_material', detail: '傅里叶', status: 'running' }];
  assert.equal(processTitle({ streaming: true, phase: 'tool', calls }), '正在检索材料：傅里叶');
  assert.equal(processTitle({ streaming: true, phase: 'thinking', calls }), '正在思考');
  assert.equal(processTitle({ streaming: true, phase: 'answering', calls }), '正在组织回答');
  assert.equal(processTitle({ streaming: false, phase: 'thinking', calls }), '思考过程');
});

test('确认和失败场景不会伪装成成功或继续思考', () => {
  assert.equal(processTitle({ streaming: true, calls: [], waiting: true }), '等待你的确认');
  assert.equal(processTitle({ streaming: true, phase: 'tool', calls: [{ name: 'ask_user', status: 'running' }] }), '等待你的回答');
  assert.equal(processTitle({ streaming: false, calls: [{ name: 'ask_user', status: 'running' }], waiting: true }), '等待你的回答');
  assert.equal(processTitle({ streaming: true, calls: [{ name: 'propose_folder_plan', status: 'running' }], waiting: true }), '等待你的确认');
  assert.equal(processTitle({ streaming: false, calls: [{ name: 'read', status: 'error' }] }), '思考过程');
});
