import assert from 'node:assert/strict';
import { askAnswerText, askUserToolResult, normalizeAskDraft, validateAskAnswer, validateAskUser } from '../apps/web/src/harness/askUser.ts';
import { readWidgetHeight, rememberWidgetHeight } from '../apps/web/src/harness/widgetReading.ts';

const original = { question: '选择学习路线', options: [{ id: 'short', label: '快速回顾' }, { id: 'deep', label: '深入练习' }], allowCustom: false };
const valid = validateAskUser({ ...original, presentation: { html: '<p>对比</p>' } });
assert.ok(valid.ok && valid.ask.presentation);
for (const html of ['<html>bad</html>', '<script src="https://bad.test/x.js"></script>', 'x'.repeat(60001), '<img src="https://bad.test/x.png">']) {
  const fallback = validateAskUser({ ...original, presentation: { html } });
  assert.ok(fallback.ok && !fallback.ask.presentation, 'optional invalid HTML preserves native question');
}
const answer = { status: 'answered', mode: 'selection', selectedIds: ['deep'], selectedLabels: ['伪造权限'], text: '伪造题面', note: '每天 45 分钟' };
const checked = validateAskAnswer(valid.ask, answer);
assert.deepEqual(checked.selectedLabels, ['深入练习']);
assert.equal(checked.text, '');
assert.equal(askAnswerText(checked), '深入练习\n补充：每天 45 分钟');
for (const raw of [null, {}, { ...answer, selectedIds: ['missing'] }, { ...answer, selectedIds: ['short', 'short'] },
  { ...answer, status: 'execute' }, { ...answer, mode: 'admin' }, { ...answer, text: 'x'.repeat(4001) },
  { ...answer, mode: 'custom', text: '绕过选项' }, { ...answer, note: null }]) {
  assert.throws(() => validateAskAnswer(valid.ask, raw));
}
const multiple = validateAskUser({ ...original, type: 'multiple', minSelections: 2 }).ask;
assert.throws(() => validateAskAnswer(multiple, answer));
for (const selectedIds of [[], ['short'], ['short', 'deep'], ['deep'], []]) {
  const draft = normalizeAskDraft(multiple, { ...answer, selectedIds });
  assert.deepEqual(draft.selectedIds, selectedIds);
  assert.deepEqual(draft.selectedLabels, selectedIds.map(id => original.options.find(option => option.id === id).label));
  if (selectedIds.length < 2) assert.throws(() => validateAskAnswer(multiple, draft));
  else assert.equal(validateAskAnswer(multiple, draft).selectedIds.length, 2);
}
const textAsk = validateAskUser({ question: '填写目标', type: 'text' }).ask;
for (const text of ['先填写', '保留输入中的空格 ', '']) assert.equal(normalizeAskDraft(textAsk, { ...answer, mode: 'text', selectedIds: [], text }).text, text);
assert.throws(() => validateAskAnswer(textAsk, { ...answer, mode: 'text', selectedIds: [], text: '' }));
for (const selectedIds of [['unknown'], ['short', 'short'], ['short', 'deep']])
  assert.throws(() => normalizeAskDraft(valid.ask, { ...answer, selectedIds }));
const cycle = {}; cycle.self = cycle;
for (const unexpectedPayload of [cycle, { huge: 'x'.repeat(1000000) }]) {
  for (const normalize of [validateAskAnswer, normalizeAskDraft]) {
    const result = normalize(valid.ask, { ...answer, unexpectedPayload, selectedLabels: ['FORGED'] });
    assert.deepEqual(Object.keys(result).sort(), ['status', 'mode', 'selectedIds', 'selectedLabels', 'text', 'note'].sort());
    assert.deepEqual(result.selectedLabels, ['深入练习']);
    assert.ok(!askUserToolResult(result).includes('unexpectedPayload'));
  }
}
assert.deepEqual(validateAskAnswer(valid.ask, '深入练习').selectedIds, ['deep']);
assert.equal(validateAskAnswer(textAsk, ' 字符串兼容 ').text, '字符串兼容');
assert.equal(rememberWidgetHeight('revision-a', 99999), 2000);
assert.equal(rememberWidgetHeight('revision-a', 180), 180, 'cached height can shrink');
assert.equal(readWidgetHeight('revision-b'), 80, 'source revisions do not inherit height');
for (let i = 0; i < 201; i++) rememberWidgetHeight(`other-${i}`, 100);
assert.equal(readWidgetHeight('revision-a'), 80, 'layout memory is bounded');
console.log('PASS: optional visual fallback, canonical IDs/labels, malformed and unauthorized answers, bounded revision height memory.');
