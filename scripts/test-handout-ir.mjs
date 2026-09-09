#!/usr/bin/env node
/**
 * IR（讲义中间表示）解析与校验的单元测试。
 * 运行：node scripts/test-handout-ir.mjs
 * Node ≥22.18 原生运行 TS（类型擦除），无需额外依赖。
 */
import assert from 'node:assert/strict';
import { parseSectionBlocks, salvageBlocks, collectFigureTimestamps, parseRewrittenBlock } from '../src/handout/ir.ts';

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

const RANGE = { startSec: 60, endSec: 600 }; // 01:00 ~ 10:00

// ---------- 合法输入 ----------

test('解析全类型合法块', () => {
  const blocks = parseSectionBlocks(
    JSON.stringify({
      blocks: [
        { type: 'lead', text: '本节讲 Hook 的执行时机。' },
        { type: 'para', text: 'useEffect 在绘制后执行。' },
        { type: 'h2', text: '执行时机' },
        { type: 'list', ordered: true, items: ['第一步', '第二步'] },
        { type: 'list', ordered: false, items: ['要点甲'] },
        { type: 'table', header: ['特性', 'useEffect'], rows: [['时机', '异步']] },
        { type: 'figure', time: '03:25', caption: '执行时机对比' },
        { type: 'note', text: '注意不要混淆。' },
      ],
    }),
    RANGE,
  );
  assert.equal(blocks.length, 8);
  assert.deepEqual(blocks[0], { type: 'lead', text: '本节讲 Hook 的执行时机。' });
  assert.deepEqual(blocks[5], { type: 'table', header: ['特性', 'useEffect'], rows: [['时机', '异步']] });
  assert.deepEqual(blocks[6], { type: 'figure', ts: 205, caption: '执行时机对比' });
});

test('容忍 ```json 围栏', () => {
  const blocks = parseSectionBlocks('```json\n{"blocks":[{"type":"para","text":"内容"}]}\n```', RANGE);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'para');
});

test('figure 支持 hh:mm:ss', () => {
  const blocks = parseSectionBlocks('{"blocks":[{"type":"figure","time":"1:02:03"}]}', { startSec: 0, endSec: 7200 });
  assert.equal(blocks[0].ts, 3723);
  assert.equal(blocks[0].caption, undefined);
});

// ---------- 防御性清洗 ----------

test('剥离 h2 自带的「（一）」编号，防止渲染器重复编号', () => {
  const blocks = parseSectionBlocks('{"blocks":[{"type":"h2","text":"（一）执行时机"}]}', RANGE);
  assert.equal(blocks[0].text, '执行时机');
});

test('剥离 list 条目自带的序号/符号', () => {
  const blocks = parseSectionBlocks(
    '{"blocks":[{"type":"list","ordered":true,"items":["1. 第一步","2、第二步"]},{"type":"list","ordered":false,"items":["- 要点","• 要点二"]}]}',
    RANGE,
  );
  assert.deepEqual(blocks[0].items, ['第一步', '第二步']);
  assert.deepEqual(blocks[1].items, ['要点', '要点二']);
});

test('清除文本中的 Markdown 残留（**、__、`）', () => {
  const blocks = parseSectionBlocks('{"blocks":[{"type":"para","text":"这是**重点**和`代码`。"}]}', RANGE);
  assert.equal(blocks[0].text, '这是重点和代码。');
});

test('figure.ts 越界 → 丢弃该块，其余保留', () => {
  const blocks = parseSectionBlocks(
    '{"blocks":[{"type":"para","text":"正文"},{"type":"figure","time":"99:00"},{"type":"figure","time":"05:00"}]}',
    RANGE,
  );
  assert.deepEqual(blocks.map((b) => b.type), ['para', 'figure']);
  assert.equal(blocks[1].ts, 300);
});

test('figure time 格式非法 → 丢弃', () => {
  const blocks = parseSectionBlocks('{"blocks":[{"type":"para","text":"正文"},{"type":"figure","time":"abc"}]}', RANGE);
  assert.deepEqual(blocks.map((b) => b.type), ['para']);
});

test('纯空白 text 的块被过滤', () => {
  const blocks = parseSectionBlocks('{"blocks":[{"type":"para","text":"  "},{"type":"para","text":"有效"}]}', RANGE);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, '有效');
});

// ---------- 应当抛错（触发 pipeline 重试） ----------

test('非 JSON 输出 → 抛错', () => {
  assert.throws(() => parseSectionBlocks('这是纯文本，没有 JSON', RANGE), /JSON/);
});

test('未知块类型 → 抛错', () => {
  assert.throws(() => parseSectionBlocks('{"blocks":[{"type":"banner","text":"x"}]}', RANGE));
});

test('table 行列数不一致 → 抛错', () => {
  assert.throws(
    () => parseSectionBlocks('{"blocks":[{"type":"table","header":["a","b"],"rows":[["1"]]}]}', RANGE),
    /table/,
  );
});

test('blocks 为空数组 → 抛错', () => {
  assert.throws(() => parseSectionBlocks('{"blocks":[]}', RANGE));
});

test('过滤后无有效块 → 抛错', () => {
  assert.throws(() => parseSectionBlocks('{"blocks":[{"type":"para","text":"  "}]}', RANGE));
});

test('table 携带 caption（表题）', () => {
  const blocks = parseSectionBlocks(
    '{"blocks":[{"type":"table","caption":"特性对比","header":["a"],"rows":[["1"]]}]}',
    RANGE,
  );
  assert.deepEqual(blocks[0], { type: 'table', caption: '特性对比', header: ['a'], rows: [['1']] });
});

test('缺 blocks 字段 → 抛错', () => {
  assert.throws(() => parseSectionBlocks('{"sections":[]}', RANGE));
});

// ---------- salvageBlocks：两次解析失败后的兜底 ----------

test('salvage：纯文本（模型无视契约）按行转 para', () => {
  const blocks = salvageBlocks('第一段内容。\n第二段内容。');
  assert.deepEqual(blocks, [
    { type: 'para', text: '第一段内容。' },
    { type: 'para', text: '第二段内容。' },
  ]);
});

test('salvage：清洗 Markdown 残留并跳过空行', () => {
  const blocks = salvageBlocks('## 标题行\n\n**加粗**段落。');
  assert.deepEqual(blocks, [
    { type: 'para', text: '标题行' },
    { type: 'para', text: '加粗段落。' },
  ]);
});

test('salvage：残缺 JSON → 单段失败提示', () => {
  const blocks = salvageBlocks('{"blocks": [{"type": "para", "text": "断掉了');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'para');
  assert.match(blocks[0].text, /重新生成/);
});

test('salvage：空输出 → 单段失败提示', () => {
  assert.equal(salvageBlocks('   ')[0].type, 'para');
});

// ---------- collectFigureTimestamps：收集实际用到的配图时间戳 ----------

test('collectFigureTimestamps：跨节收集、去重、保持顺序', () => {
  const ts = collectFigureTimestamps([
    { heading: '一', blocks: [{ type: 'para', text: 'x' }, { type: 'figure', ts: 205 }, { type: 'figure', ts: 300 }] },
    { heading: '二', blocks: [{ type: 'figure', ts: 205 }, { type: 'figure', ts: 480 }] },
  ]);
  assert.deepEqual(ts, [205, 300, 480]);
});

test('collectFigureTimestamps：无配图 → 空数组', () => {
  assert.deepEqual(collectFigureTimestamps([{ heading: '一', blocks: [{ type: 'para', text: 'x' }] }]), []);
});

// ---------- parseRewrittenBlock：AI 单块改写的输出校验 ----------

test('改写 para：正常替换文本并清洗 Markdown', () => {
  const b = parseRewrittenBlock('{"text":"这是**精简后**的内容。"}', { type: 'para', text: '原文' });
  assert.deepEqual(b, { type: 'para', text: '这是精简后的内容。' });
});

test('改写后 type 强制与原文一致（lead 不变成 para）', () => {
  const b = parseRewrittenBlock('{"type":"para","text":"新文本"}', { type: 'lead', text: '原文' });
  assert.equal(b.type, 'lead');
  assert.equal(b.text, '新文本');
});

test('改写 h2：剥离模型补写的编号', () => {
  const b = parseRewrittenBlock('{"text":"（二）新的标题"}', { type: 'h2', text: '旧标题' });
  assert.deepEqual(b, { type: 'h2', text: '新的标题' });
});

test('改写 list：保持 ordered，剥离条目自带序号', () => {
  const b = parseRewrittenBlock('{"items":["1. 甲","● 乙"]}', { type: 'list', ordered: false, items: ['旧'] });
  assert.deepEqual(b, { type: 'list', ordered: false, items: ['甲', '乙'] });
});

test('改写 table：列数被改 → 抛错（结构不变约束）', () => {
  const orig = { type: 'table', header: ['a', 'b'], rows: [['1', '2']] };
  assert.throws(() => parseRewrittenBlock('{"header":["a"],"rows":[["1"]]}', orig), /列/);
});

test('改写 table：正常改文字，caption 可增删', () => {
  const orig = { type: 'table', header: ['a', 'b'], rows: [['1', '2']] };
  const b = parseRewrittenBlock('{"caption":"新表名","header":["A","B"],"rows":[["一","二"]]}', orig);
  assert.deepEqual(b, { type: 'table', caption: '新表名', header: ['A', 'B'], rows: [['一', '二']] });
});

test('改写 figure：ts 强制保留原值，只换 caption', () => {
  const orig = { type: 'figure', ts: 205, caption: '旧图注' };
  const b = parseRewrittenBlock('{"caption":"新图注","time":"99:99"}', orig);
  assert.deepEqual(b, { type: 'figure', ts: 205, caption: '新图注' });
});

test('改写结果为空 → 抛错（供上层重试）', () => {
  assert.throws(() => parseRewrittenBlock('{"text":"  "}', { type: 'para', text: '原文' }), /空/);
  assert.throws(() => parseRewrittenBlock('{"items":[]}', { type: 'list', ordered: true, items: ['旧'] }), /空/);
  assert.throws(() => parseRewrittenBlock('{"caption":""}', { type: 'figure', ts: 1 }), /空/);
});

test('改写输出非 JSON → 抛错', () => {
  assert.throws(() => parseRewrittenBlock('直接给了段话', { type: 'para', text: '原文' }), /JSON/);
});

// ---------- 汇总 ----------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
