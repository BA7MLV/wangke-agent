#!/usr/bin/env node
/**
 * 课程助手两张卡片的**参数校验**断言（ask_user / propose_folder_plan）。
 *
 * 重点不在「合法输入能通过」（那太简单），而在几条**边界与措辞**：
 *   - 选项/分类条数上下限是 UI 契约，改了会让卡片放不下
 *   - 重复项要报错（模型重复给同一个方案会让用户以为是两个选项）
 *   - 同名分类项**合并**而不是报错：模型分两批列同一个分类是常见写法，让它重试一轮纯属浪费
 *   - 错误文案必须点名是第几个、期望多少（模型收到「参数不合法」只会换个说法重试）
 *   - allowCustom 默认给 true：模型判断不了用户处境时，「我自己说」比在选项里硬选诚实
 *
 * 运行：node scripts/test-course-chat-tools.mjs
 */
import assert from 'node:assert/strict';

const { validateAskUser, MIN_ASK_OPTIONS, MAX_ASK_OPTIONS } = await import('../src/harness/askUser.ts');
const { validateFolderPlan, MAX_PLAN_FOLDERS } = await import('../src/harness/folderPlan.ts');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.error(`  FAIL - ${name}\n        ${e.message}`);
  }
}

// ── ask_user ─────────────────────────────────────────────────────────────────

test('合法提问卡通过，且默认给「我自己说」', () => {
  const v = validateAskUser({ question: '你想按什么顺序学？', options: ['先基础后进阶', '按考试时间'] });
  assert.equal(v.ok, true);
  assert.equal(v.ask.allowCustom, true, '默认必须给自定义入口');
  assert.deepEqual(v.ask.options, ['先基础后进阶', '按考试时间']);
});

test('选项数上下限是硬边界（改了 UI 放不下）', () => {
  assert.equal(MIN_ASK_OPTIONS, 2);
  assert.equal(MAX_ASK_OPTIONS, 5);
  const one = validateAskUser({ question: '选哪个？', options: ['只有一个'] });
  assert.equal(one.ok, false);
  assert.match(one.error, /1 个/, `错误要说清收到几个：${one.error}`);
  const six = validateAskUser({
    question: '选哪个？',
    options: ['a', 'b', 'c', 'd', 'e', 'f'],
  });
  assert.equal(six.ok, false);
  assert.match(six.error, /6 个/);
});

test('重复选项、空选项都被拒（用户看不出是两个不同的方案）', () => {
  const dup = validateAskUser({ question: '选哪个？', options: ['行测', '行测'] });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /不能重复/);
  const empty = validateAskUser({ question: '选哪个？', options: ['行测', '  '] });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /不能为空/);
});

test('超长选项的报错点名是第几个、期望多少字', () => {
  const long = validateAskUser({ question: '选哪个？', options: ['短', '长'.repeat(80)] });
  assert.equal(long.ok, false);
  assert.match(long.error, /第 2 个选项/);
  assert.match(long.error, /60 字/);
});

test('题面不能为空 / 超长被拒', () => {
  assert.equal(validateAskUser({ question: '   ', options: ['a', 'b'] }).ok, false);
  assert.equal(validateAskUser({ question: '问'.repeat(300), options: ['a', 'b'] }).ok, false);
});

test('allowCustom 显式 false 才关掉（模型说「候选都很贴切」时能省掉这个入口）', () => {
  const off = validateAskUser({ question: '选哪个？', options: ['a', 'b'], allowCustom: false });
  assert.equal(off.ok, true);
  assert.equal(off.ask.allowCustom, false);
  const junk = validateAskUser({ question: '选哪个？', options: ['a', 'b'], allowCustom: 'yes' });
  assert.equal(junk.ask?.allowCustom, true, '非布尔值按「给」处理，不因为脏参数整张卡失败');
});

test('选项里的多余空白被压成单空格（卡片是等宽排版，多空格会被撑歪）', () => {
  const v = validateAskUser({ question: '选哪个？', options: ['  a   b  ', ' c'] });
  assert.deepEqual(v.ask.options, ['a b', 'c']);
});

// ── propose_folder_plan ─────────────────────────────────────────────────────

test('合法方案通过', () => {
  const v = validateFolderPlan({
    summary: '按学科分四类',
    folders: [
      { name: '行测', courseIds: ['a', 'b'] },
      { name: '申论', courseIds: ['c'] },
    ],
  });
  assert.equal(v.ok, true);
  assert.equal(v.plan.folders.length, 2);
});

test('summary 不能为空（方案卡顶部就是它，空了用户不知道在批准什么）', () => {
  assert.equal(validateFolderPlan({ summary: '', folders: [{ name: 'a', courseIds: ['x'] }] }).ok, false);
});

test('分类数上限受控（分太多类等于没整理）', () => {
  const many = Array.from({ length: MAX_PLAN_FOLDERS + 1 }, (_, i) => ({
    name: `类${i}`,
    courseIds: [`id${i}`],
  }));
  const v = validateFolderPlan({ summary: '太多了', folders: many });
  assert.equal(v.ok, false);
  assert.match(v.error, /13 个/);
});

test('单个分类一次不能塞太多门（超了要求分批）', () => {
  const v = validateFolderPlan({
    summary: '一把梭',
    folders: [{ name: '全部', courseIds: Array.from({ length: 80 }, (_, i) => `id${i}`) }],
  });
  assert.equal(v.ok, false);
  assert.match(v.error, /分批/);
});

test('同名分类自动合并（模型分两批列同一分类是常见写法，别让它重试一轮）', () => {
  const v = validateFolderPlan({
    summary: '两批',
    folders: [
      { name: '行测', courseIds: ['a'] },
      { name: '申论', courseIds: ['b'] },
      { name: '行测', courseIds: ['c', 'a'] },
    ],
  });
  assert.equal(v.ok, true);
  assert.equal(v.plan.folders.length, 2);
  const first = v.plan.folders.find((e) => e.name === '行测');
  assert.deepEqual(first.courseIds, ['a', 'c'], '合并时也要去重');
});

test('分类名与分类内课程 id 的清洗：空名报错，脏 id 丢掉', () => {
  assert.equal(validateFolderPlan({ summary: 'x', folders: [{ name: '  ', courseIds: ['a'] }] }).ok, false);
  const v = validateFolderPlan({
    summary: 'x',
    folders: [{ name: '行测', courseIds: ['a', 42, null, ' a ', ''] }],
  });
  assert.deepEqual(v.plan.folders[0].courseIds, ['a']);
});

test('空课程列表的分类被放行（由落库那侧决定不建目录，不是校验该管的事）', () => {
  const v = validateFolderPlan({ summary: 'x', folders: [{ name: '以后放这类', courseIds: [] }] });
  assert.equal(v.ok, true);
  assert.equal(v.plan.folders[0].courseIds.length, 0);
});

test('folders 必须是数组', () => {
  assert.equal(validateFolderPlan({ summary: 'x', folders: '行测' }).ok, false);
  assert.equal(validateFolderPlan({ summary: 'x' }).ok, false);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
