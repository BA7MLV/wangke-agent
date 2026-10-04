#!/usr/bin/env node
/**
 * agent 编辑工具的单元测试（无需 API key / 无需起服务）。
 * 运行：node scripts/test-md-edit-tool.mjs
 *
 * 测的是**纯逻辑那一半**：把 agent 提出的 { old_string, new_string } 变成具体改哪几个坐标。
 * 不碰 CodeMirror、不碰 DOM（接线是下一个任务的事）。
 *
 * 这个模块的主要产出其实是**诊断文案**。含糊的报错会让模型换个说法再试一遍、
 * 白烧一整轮工具调用，所以「失败时文案有没有点名第几条、说清命中几处、给出下一步」
 * 也被当成不变量来断言，而不是只断言 `ok === false`。
 */
import assert from 'node:assert/strict';
import { planAgentEdits } from '../src/md-editor/edits.ts';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`  FAIL - ${name}\n    ${e.message}`); }
}

/** 期望成功，顺带把 PlanResult 收窄成 ok 分支（免得后面每次写 !） */
const ok = (res) => {
  assert.equal(res.ok, true, `期望成功，实际报错：${res.ok ? '' : res.error}`);
  return res;
};
/** 期望失败，把 error 拿出来（没 ok:false 就直接炸） */
const err = (res) => {
  assert.equal(res.ok, false, '期望失败，实际成功了');
  return res.error;
};
const at = (text, sub) => {
  const i = text.indexOf(sub);
  assert.notEqual(i, -1, `测试样本里找不到 ${JSON.stringify(sub)}`);
  return i;
};

/** 按 changes 落地。依赖 changes 已按 from 升序、互不重叠 —— 这两条本身就是契约 */
const applyChanges = (doc, changes) => {
  let out = '';
  let p = 0;
  for (const c of changes) {
    out += doc.slice(p, c.from) + c.insert;
    p = c.to;
  }
  return out + doc.slice(p);
};
/**
 * 撤销：把每个高亮区间换回 removed。
 *
 * 倒序处理 —— 前面区间的坐标才不会因为后面插入了内容而平移。
 * 纯删除的高亮是**零宽**区间，`slice(0,from) + removed + slice(from)` 正好把原文插回去，
 * 所以删除和替换能用同一条公式，不需要为删除单开分支。
 *
 * from 相同时必须**先撤 to 大的**。这是纯删除紧跟着另一处插入时的真实形状：
 * 「删掉 BBB，紧接着把 CCC 换成 CCCCC」，两条高亮会落在同一个 from 上
 * （插入 +2、再删 -3，第三处的旧坐标 6 被抵消成 5）。先撤零宽那条的话，
 * 刚插回去的 BBB 会被下一条 from 相同、to 更大的区间整个吃掉。
 * 升序给编辑器画装饰是合法的（零宽区间不与后一条相交），但**撤销端必须记住这个 tie-break**。
 */
const undo = (doc, changes, highlights) => {
  let next = applyChanges(doc, changes);
  for (const h of [...highlights].sort((a, b) => b.from - a.from || b.to - a.to)) {
    next = next.slice(0, h.from) + h.removed + next.slice(h.to);
  }
  return next;
};

// ── 匹配与坐标 ─────────────────────────────────────────────────────────────

test('唯一命中：成功，坐标就是 old_string 在文档里的位置', () => {
  const doc = '第一段。\n第二段。\n第三段。\n';
  const from = at(doc, '第二段。');
  const res = ok(planAgentEdits(doc, [{ old_string: '第二段。', new_string: '改过的第二段。' }]));
  assert.equal(res.changes.length, 1);
  assert.deepEqual(res.changes[0], { from, to: from + 4, insert: '改过的第二段。' });
});

test('未命中：失败，且文案里带着那条 old_string 的原文', () => {
  const doc = '第一段。\n第二段。\n';
  const e = err(planAgentEdits(doc, [{ old_string: '不存在的原文', new_string: 'x' }]));
  assert.ok(e.includes('不存在的原文'), `报错里必须回显 old_string，实际：${e}`);
});

test('未命中：文案点名是第几条 edit，并建议重新读原文', () => {
  const doc = '第一段。\n第二段。\n';
  const e = err(planAgentEdits(doc, [
    { old_string: '第一段。', new_string: 'x' },
    { old_string: '第三段。', new_string: 'y' },
  ]));
  assert.ok(e.includes('第 2 条'), `报错必须点名第 2 条，实际：${e}`);
  assert.ok(/重新读|再读一次|重新读取/.test(e), `报错必须建议重新读原文，实际：${e}`);
});

test('多处命中且没给 replace_all：失败，文案带命中次数和两条出路', () => {
  const doc = '重复。\n中间。\n重复。\n重复。\n';
  const e = err(planAgentEdits(doc, [{ old_string: '重复。', new_string: '换了。' }]));
  assert.ok(e.includes('3'), `报错必须带命中次数 3，实际：${e}`);
  assert.ok(/上下文/.test(e), `第一条出路应是补充上下文，实际：${e}`);
  assert.ok(/replace_all/.test(e), `第二条出路应是 replace_all，实际：${e}`);
});

test('文档里有重复段落时宁可报错，也不碰巧改第一处', () => {
  const doc = '重复段落。\n中间。\n重复段落。\n';
  const res = planAgentEdits(doc, [{ old_string: '重复段落。', new_string: '改过的。' }]);
  assert.equal(res.ok, false, '两处同名段落必须靠报错交给模型决定，不能替他挑第一处');
});

test('多处命中 + replace_all：成功，changes 长度等于命中次数', () => {
  const doc = 'x\n中间\nx\n';
  const res = ok(planAgentEdits(doc, [{ old_string: 'x', new_string: 'yy', replace_all: true }]));
  assert.equal(res.changes.length, 2);
  assert.deepEqual(res.changes.map((c) => [c.from, c.to, c.insert]), [[0, 1, 'yy'], [5, 6, 'yy']]);
});

test('replace_all 的新串里含 old_string 时不会无限匹配', () => {
  // 计数循环会在这里死掉；实现必须始终按 old_string 的长度在**原文**上推进
  const doc = 'a-a-a-a\n';
  const res = ok(planAgentEdits(doc, [{ old_string: 'a', new_string: 'aa', replace_all: true }]));
  assert.equal(res.changes.length, 4, '原文里 4 个 a 就该产生 4 处改动');
  assert.equal(applyChanges(doc, res.changes), 'aa-aa-aa-aa\n');
});

test('多条编辑区间不重叠：成功，changes 长度等于编辑条数', () => {
  const doc = '甲甲甲乙乙乙丙丙丙\n';
  const res = ok(planAgentEdits(doc, [
    { old_string: '甲甲甲', new_string: '丁' },
    { old_string: '乙乙乙', new_string: '戊' },
    { old_string: '丙丙丙', new_string: '己' },
  ]));
  assert.equal(res.changes.length, 3);
  assert.deepEqual(res.changes.map((c) => [c.from, c.to, c.insert]), [[0, 3, '丁'], [3, 6, '戊'], [6, 9, '己']]);
  assert.equal(applyChanges(doc, res.changes), '丁戊己\n');
  assert.equal(undo(doc, res.changes, res.highlights), doc, '撤销必须还原成原文');
});

test('区间重叠：失败，文案提到「重叠」并说是哪两条', () => {
  const doc = 'abcdefghij';
  const e = err(planAgentEdits(doc, [
    { old_string: 'cdef', new_string: 'X' },
    { old_string: 'de', new_string: 'Y' },
  ]));
  assert.ok(e.includes('重叠'), `文案必须提到重叠，实际：${e}`);
  assert.ok(e.includes('第 1 条') && e.includes('第 2 条'), `文案必须点名是哪两条，实际：${e}`);
});

test('同一起点的两条编辑也算重叠', () => {
  const doc = 'abcdef';
  const e = err(planAgentEdits(doc, [
    { old_string: 'bc', new_string: 'X' },
    { old_string: 'bcd', new_string: 'Y' },
  ]));
  assert.ok(e.includes('重叠'), `文案必须提到重叠，实际：${e}`);
});

test('首尾相接不算重叠（[a,b) 与 [b,c) 是合法的两次改动）', () => {
  const doc = 'abcd';
  const res = ok(planAgentEdits(doc, [
    { old_string: 'ab', new_string: 'X' },
    { old_string: 'cd', new_string: 'Y' },
  ]));
  assert.equal(res.changes.length, 2);
  assert.equal(applyChanges(doc, res.changes), 'XY');
});

test('changes 按 from 升序（输入乱序也要排好，接线端直接顺序 dispatch）', () => {
  const doc = '0123456789';
  const res = ok(planAgentEdits(doc, [
    { old_string: '89', new_string: 'B' },
    { old_string: '01', new_string: 'A' },
    { old_string: '45', new_string: 'C' },
  ]));
  assert.deepEqual(res.changes.map((c) => [c.from, c.to]), [[0, 2], [4, 6], [8, 10]]);
  assert.equal(applyChanges(doc, res.changes), 'A23C67B');
});

// ── highlights 用的是**新文档**坐标 ─────────────────────────────────────────
// 前一条编辑插入了几个字符，后面那些编辑的位置就整体后移几个。
// 直接拿旧坐标画装饰，绿高亮会落在无关的字上，而且这种错在屏幕上很难看出是「偏了几格」。

test('highlights 是新文档坐标：前面插入 5 字符后，后面那条的 from 已平移', () => {
  const doc = '0123456789ABCDEFGHIJ0123456789';
  const res = ok(planAgentEdits(doc, [
    { old_string: 'ABCDE', new_string: 'ABCDE!!!!!' }, // [10,15) → 净 +5
    { old_string: 'FGHIJ', new_string: 'FGHIJ?????' }, // [15,20) → 旧坐标 15，新坐标应是 20
  ]));
  const next = applyChanges(doc, res.changes);
  assert.equal(res.highlights.length, 2);
  assert.deepEqual(res.highlights[0], { from: 10, to: 20, removed: 'ABCDE' });
  assert.deepEqual(res.highlights[1], { from: 20, to: 30, removed: 'FGHIJ' });
  // 平移对了的判据不是坐标本身，而是高亮区间在新文档里正好盖住插入的那段字
  assert.equal(next.slice(res.highlights[1].from, res.highlights[1].to), 'FGHIJ?????');
});

test('highlights 不受前面「净长度变化」影响，只受前面**净**变化影响（删除后要往前收）', () => {
  const doc = '0123456789ABCDEFGHIJ';
  const res = ok(planAgentEdits(doc, [
    { old_string: 'ABCDE', new_string: '' },        // [10,15) 删 5 个字符
    { old_string: 'FGHIJ', new_string: 'F!' },      // [15,20) 旧坐标 15，新坐标应是 10
  ]));
  const next = applyChanges(doc, res.changes);
  assert.deepEqual(res.highlights[1], { from: 10, to: 12, removed: 'FGHIJ' });
  assert.equal(next.slice(res.highlights[1].from, res.highlights[1].to), 'F!');
});

test('replace_all 多处命中时每处都有一条高亮，坐标各自平移', () => {
  const doc = '甲\n甲\n甲\n';
  const res = ok(planAgentEdits(doc, [{ old_string: '甲', new_string: '甲甲甲', replace_all: true }]));
  assert.equal(res.highlights.length, 3);
  const next = applyChanges(doc, res.changes);
  assert.deepEqual(res.highlights.map((h) => [h.from, h.to]), [[0, 3], [4, 7], [8, 11]]);
  for (const h of res.highlights) {
    assert.equal(next.slice(h.from, h.to), '甲甲甲', `高亮 ${h.from}-${h.to} 没盖住插入的文字`);
  }
});

test('改动全部撤销后能逐字还原原文（坐标平移错的话这里必炸）', () => {
  const doc = '# 标题\n\n正文一。\n\n正文二。\n\n## 小节\n\n正文三。\n';
  const res = ok(planAgentEdits(doc, [
    { old_string: '# 标题', new_string: '# 新标题\n\n> 加一段引言' },
    { old_string: '正文二。', new_string: '正文二改。' },
    { old_string: '正文三。\n', new_string: '' },
  ]));
  assert.equal(undo(doc, res.changes, res.highlights), doc);
});

// ── 纯删除 ─────────────────────────────────────────────────────────────────
// 没有 new_string 可高亮，但**仍然必须能被撤销** —— 撤销靠的是 highlights[].removed。

test('纯删除：changes 里有这条（insert 为空串）', () => {
  const doc = '第一段。\n第二段要删掉。\n第三段。';
  const res = ok(planAgentEdits(doc, [{ old_string: '第二段要删掉。\n', new_string: '' }]));
  const from = at(doc, '第二段');
  assert.deepEqual(res.changes, [{ from, to: from + 8, insert: '' }]); // 含行尾的 \n，8 个字符
  assert.equal(applyChanges(doc, res.changes), '第一段。\n第三段。');
});

test('纯删除：highlights 里有一条零宽区间，removed 是被删掉的原文', () => {
  const doc = '第一段。\n第二段要删掉。\n第三段。';
  const res = ok(planAgentEdits(doc, [{ old_string: '第二段要删掉。\n', new_string: '' }]));
  assert.equal(res.highlights.length, 1, '纯删除也必须留一条高亮，否则撤不回来');
  assert.deepEqual(res.highlights[0], { from: 5, to: 5, removed: '第二段要删掉。\n' });
});

test('纯删除夹在两条插入之间：中间那条高亮是零宽，坐标已按前一条平移', () => {
  const doc = 'AAABBBCCC';
  const res = ok(planAgentEdits(doc, [
    { old_string: 'AAA', new_string: 'AAAAA' }, // [0,3) 插 2 → shift +2
    { old_string: 'BBB', new_string: '' },       // [3,6) 删 3 → shift 归 -1，新文档的插入点是 5
    { old_string: 'CCC', new_string: 'CCCCC' }, // [6,9) 旧坐标 6，新坐标应是 6 + 2 - 3 = 5
  ]));
  const next = applyChanges(doc, res.changes);
  assert.equal(next, 'AAAAACCCCC');
  assert.deepEqual(res.highlights[1], { from: 5, to: 5, removed: 'BBB' }, '纯删除是零宽区间');
  assert.deepEqual(res.highlights[2], { from: 5, to: 10, removed: 'CCC' });
  assert.equal(next.slice(5, 10), 'CCCCC', '平移错的话这里会切到无关的字');
  assert.equal(undo(doc, res.changes, res.highlights), doc);
});

// ── 撤销端必须知道的形状 ───────────────────────────────────────────────────

test('纯删除紧跟一处插入时，两条高亮共用同一个 from（撤销要按 to 降序 tie-break）', () => {
  const doc = 'AAABBBCCC';
  const res = ok(planAgentEdits(doc, [
    { old_string: 'BBB', new_string: '' },
    { old_string: 'CCC', new_string: 'CCCCC' },
  ]));
  const next = applyChanges(doc, res.changes);
  assert.equal(next, 'AAACCCCC');
  // 两条高亮都落在 from=3（6 被前面那次删除的 -3 拉到 3）：这是纯删除后面紧跟插入时无法回避的形状
  assert.deepEqual(res.highlights, [
    { from: 3, to: 3, removed: 'BBB' },
    { from: 3, to: 8, removed: 'CCC' },
  ]);
  // 升序不重叠：零宽区间不与后一条相交，可以直接顺序喂给 RangeSetBuilder
  assert.ok(res.highlights.every((h, i) => i === 0 || h.from >= res.highlights[i - 1].to));
  assert.equal(undo(doc, res.changes, res.highlights), doc, 'tie-break 写错这里就还原不回去');
});

test('整段删除到空文档也不炸', () => {
  const doc = '只有一段';
  const res = ok(planAgentEdits(doc, [{ old_string: '只有一段', new_string: '' }]));
  assert.deepEqual(res.changes, [{ from: 0, to: 4, insert: '' }]);
  assert.deepEqual(res.highlights, [{ from: 0, to: 0, removed: '只有一段' }]);
  assert.equal(applyChanges(doc, res.changes), '');
});

// ── 非法输入 ───────────────────────────────────────────────────────────────

test('old_string 为空串：失败（空串会匹配到文档里每个位置）', () => {
  const doc = '随便什么内容。';
  const e = err(planAgentEdits(doc, [{ old_string: '', new_string: 'x' }]));
  assert.ok(/空字符串|空串/.test(e), `文案要点明是空串的问题，实际：${e}`);
  assert.ok(e.includes('第 1 条'), `文案要点名第几条，实际：${e}`);
});

test('edits 为空数组：失败，文案说清是空指令', () => {
  const e = err(planAgentEdits('随便什么内容。', []));
  assert.ok(/空/.test(e), `文案要说清是空指令，实际：${e}`);
});

test('edits 不是数组（undefined / 字符串 / 对象）：失败，不抛异常', () => {
  for (const junk of [undefined, null, 'abc', 42, {}, { old_string: 'a' }]) {
    const e = err(planAgentEdits('随便什么内容。', junk));
    assert.ok(typeof e === 'string' && e.length > 0, `必须给一句报错，实际：${String(e)}`);
  }
});

test('模型传 { old_string: 123 }：失败，不崩在 indexOf 上', () => {
  const doc = '随便什么内容。';
  const e = err(planAgentEdits(doc, [{ old_string: 123, new_string: 'x' }]));
  assert.ok(e.includes('第 1 条'), `文案要点名第几条，实际：${e}`);
  assert.ok(/类型|字符串/.test(e), `文案要点明是类型不对，实际：${e}`);
});

test('模型传 {}：失败，字段缺失要单独点名', () => {
  const doc = '随便什么内容。';
  const e = err(planAgentEdits(doc, [{}]));
  assert.ok(e.includes('old_string'), `文案要点名缺哪个字段，实际：${e}`);
  assert.ok(e.includes('new_string'), `文案要点名缺哪个字段，实际：${e}`);
});

test('模型传 undefined / null / 字符串当一条 edit：失败，不抛异常', () => {
  const doc = '随便什么内容。';
  for (const junk of [undefined, null, 'old_string', 7]) {
    const e = err(planAgentEdits(doc, [junk]));
    assert.ok(typeof e === 'string' && e.length > 0, `必须给一句报错，实际：${String(e)}`);
  }
});

test('new_string 是 undefined（模型常犯）：失败，且指出是 new_string 而不是 old_string', () => {
  const doc = '随便什么内容。';
  const e = err(planAgentEdits(doc, [{ old_string: '随便什么内容。', new_string: undefined }]));
  assert.ok(e.includes('new_string'), `文案要点名是 new_string，实际：${e}`);
});

test('replace_all: false 等价于不给（仍要求唯一命中）', () => {
  const doc = '重复。\n重复。\n';
  const e = err(planAgentEdits(doc, [{ old_string: '重复。', new_string: 'x', replace_all: false }]));
  assert.ok(e.includes('2'), `两处命中必须报错并说明次数，实际：${e}`);
});

test('old_string === new_string 的空操作不报错（模型有时会发这种）', () => {
  const doc = '甲乙丙';
  const res = ok(planAgentEdits(doc, [{ old_string: '乙', new_string: '乙' }]));
  assert.equal(res.changes.length, 1);
  assert.equal(applyChanges(doc, res.changes), doc);
});

// ── 边界 ───────────────────────────────────────────────────────────────────

test('在文档首 / 尾 / 唯一字符上的改动坐标都准', () => {
  const doc = '头中尾';
  const res = ok(planAgentEdits(doc, [
    { old_string: '头', new_string: 'HEAD' },
    { old_string: '尾', new_string: 'TAIL' },
  ]));
  assert.deepEqual(res.changes.map((c) => [c.from, c.to]), [[0, 1], [2, 3]]);
  assert.equal(applyChanges(doc, res.changes), 'HEAD中TAIL');
  assert.equal(undo(doc, res.changes, res.highlights), doc);
});

test('空文档 + 唯一命中是不可能的组合：走「未命中」分支而不是崩', () => {
  const e = err(planAgentEdits('', [{ old_string: 'x', new_string: 'y' }]));
  assert.ok(e.includes('x'), `报错要回显 old_string，实际：${e}`);
});

test('命中跨行 / 含空格的原文不受影响（精确匹配，不做归一化）', () => {
  const doc = '# 标题\n\n正文  里有  两个空格\n';
  const from = at(doc, '正文  里有');
  const res = ok(planAgentEdits(doc, [{ old_string: '正文  里有  两个空格\n', new_string: '正文里有两个空格\n' }]));
  assert.deepEqual(res.changes[0], { from, to: doc.length, insert: '正文里有两个空格\n' });
  // 归一化空白就会让「一个空格」的 old_string 命中这段 —— 那是会写坏文档的错
  const e = err(planAgentEdits(doc, [{ old_string: '正文 里有 两个空格', new_string: 'x' }]));
  assert.ok(e.length > 0);
});

test('一条 edits 里混着好与坏：先撞到的那条报错，后面那条不该提前被改', () => {
  const doc = '甲甲乙乙';
  const res = planAgentEdits(doc, [
    { old_string: '甲', new_string: '丙' },        // 多处命中
    { old_string: '乙', new_string: '丁' },        // 唯一命中，但排在坏的那条后面
  ]);
  const e = err(res);
  assert.ok(e.includes('第 1 条'), `应报第 1 条（按调用顺序先撞到的那条），实际：${e}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length === 0) console.log(`全部通过：${passed} 个用例`);
if (failures.length > 0) process.exit(1);