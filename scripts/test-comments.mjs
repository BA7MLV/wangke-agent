#!/usr/bin/env node
/**
 * 评论区（AI 生成的同学讨论）纯逻辑单测：模型输出解析 / 清洗 / 钳制 / 排序 / 分组。
 * 运行：node scripts/test-comments.mjs
 * Node ≥22.18 原生运行 TS（类型擦除），无需额外依赖。
 *
 * 为什么这一层能覆盖：`harness/comments.ts` 是零依赖纯模块（连 `store/db.ts` 都只靠
 * 结构化类型绕开），所有分支判断都在里面 —— 生成质量是模型的事，这段代码才是我们的。
 */
import assert from 'node:assert/strict';
import {
  COMMENT_AUTHOR_POOL,
  COMMENT_LIMITS,
  cleanText,
  countComments,
  dedupeThreads,
  groupThreads,
  normalizeAuthor,
  normalizeRole,
  orderThreads,
  parseCommentThreads,
} from '../src/harness/comments.ts';
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

/** 一个字幕块的时间范围：10:00 ~ 20:00，钳制容差 ±60s */
const RANGE = { start: 600, end: 1200 };

const thread = (over = {}) => ({
  time: '10:30',
  author: '小林',
  role: 'ask',
  text: '这里为什么不能直接取反？',
  replies: [{ author: '阿哲', role: 'answer', text: '因为条件是单向的。' }],
  ...over,
});

/** 走完整的「LLM 文本 → 讨论串」路径，顺带覆盖围栏剥离 */
const parse = (arr) => parseCommentThreads(JSON.stringify(arr), RANGE);

// ── 解析 ────────────────────────────────────────────────────────────────

test('合法输出解析为讨论串（主贴 + 回复）', () => {
  const out = parse([thread()]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    time: 630,
    author: '小林',
    role: 'ask',
    text: '这里为什么不能直接取反？',
    replies: [{ author: '阿哲', role: 'answer', text: '因为条件是单向的。' }],
  });
});

test('h:mm:ss 时间戳', () => {
  assert.equal(parse([thread({ time: '0:12:05' })])[0].time, 725);
});

test('带 ```json 围栏的输出照样能解析', () => {
  const text = '```json\n' + JSON.stringify([thread()]) + '\n```';
  assert.equal(parseCommentThreads(text, RANGE).length, 1);
});

test('非 JSON / 坏 JSON 返回空数组而不是抛错', () => {
  assert.deepEqual(parseCommentThreads('模型今天不想输出 JSON', RANGE), []);
  assert.deepEqual(parseCommentThreads('[ bad json ]', RANGE), []);
  assert.deepEqual(parseCommentThreads('', RANGE), []);
});

// ── 时间戳钳制（两侧边界各测内外） ──────────────────────────────────────

test('时间戳钳制：块首块尾 ±60s 内收，之外丢', () => {
  assert.equal(parse([thread({ time: '09:00' })]).length, 1, 'start-60 应保留');
  assert.equal(parse([thread({ time: '08:59' })]).length, 0, 'start-60-1 应丢弃');
  assert.equal(parse([thread({ time: '21:00' })]).length, 1, 'end+60 应保留');
  assert.equal(parse([thread({ time: '21:01' })]).length, 0, 'end+60+1 应丢弃');
});

test('时间戳非法（缺失 / 非数字）丢弃', () => {
  assert.equal(parse([thread({ time: undefined })]).length, 0);
  assert.equal(parse([thread({ time: 'abc' })]).length, 0);
});

// ── 条数上限 ────────────────────────────────────────────────────────────

test(`每块至多收 ${COMMENT_LIMITS.maxThreadsPerChunk} 条讨论串`, () => {
  const three = [thread({ time: '10:00' }), thread({ time: '11:00' }), thread({ time: '12:00' })];
  const out = parse(three);
  assert.equal(out.length, COMMENT_LIMITS.maxThreadsPerChunk);
  assert.equal(out[0].time, 600, '保留的是先出现的那条');
});

test(`每条至多收 ${COMMENT_LIMITS.maxReplies} 条回复`, () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    author: '阿哲',
    role: 'answer',
    text: `回复内容${i}`,
  }));
  const out = parse([thread({ replies: many })]);
  assert.equal(out[0].replies.length, COMMENT_LIMITS.maxReplies);
});

test('replies 缺失 / 类型不对 → 退化为空数组（不整条丢弃）', () => {
  assert.deepEqual(parse([thread({ replies: undefined })])[0].replies, []);
  assert.deepEqual(parse([thread({ replies: 'nope' })])[0].replies, []);
  assert.deepEqual(parse([thread({ replies: [null, 'x', {}] })])[0].replies, []);
});

test('正文过短的那条不落库', () => {
  assert.equal(parse([thread({ text: '嗯' })]).length, 0);
  assert.equal(parse([thread({ text: '  ' })]).length, 0);
});

// ── 归一化 ──────────────────────────────────────────────────────────────

test('作者只认名单内的名字，其余兜底', () => {
  assert.equal(normalizeAuthor('小林'), '小林');
  assert.equal(normalizeAuthor(' 助教 '), '助教');
  assert.equal(normalizeAuthor('张三'), '同学');
  assert.equal(normalizeAuthor(undefined), '同学');
  assert.equal(parse([thread({ author: '路人甲' })])[0].author, '同学');
});

test('角色归一：英文键 / 中文标签 / 未知按位置兜底', () => {
  assert.equal(normalizeRole('ask', true), 'ask');
  assert.equal(normalizeRole('question', true), 'ask');
  assert.equal(normalizeRole('补充', false), 'note');
  assert.equal(normalizeRole('ANSWER', false), 'answer');
  assert.equal(normalizeRole('', true), 'ask', '主贴兜底当提问');
  assert.equal(normalizeRole(undefined, false), 'answer', '回复兜底当回答');
});

test('正文清洗：折换行 / 剥引号 / [mm:ss] 去方括号 / 截断', () => {
  assert.equal(cleanText('第一行\n第二行', 140), '第一行 第二行');
  assert.equal(cleanText('  「引号包裹的内容」  ', 140), '引号包裹的内容');
  // 正文不 linkify，留着方括号会让人以为能点
  assert.equal(cleanText('[12:34] 这里有问题', 140), '12:34 这里有问题');
  assert.equal(cleanText('一二三四五六', 4), '一二三四');
  assert.equal(cleanText(123, 140), '');
});

// ── 去重与排序 ──────────────────────────────────────────────────────────

test('跨块去重：正文前 12 字相同的只留先出现的', () => {
  const early = { time: 10, text: '这里为什么不能直接取反？' };
  const late = { time: 900, text: '这里为什么不能直接取反' };
  const other = { time: 950, text: '换个完全不同的说法试试' };
  const out = dedupeThreads([late, other, early]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((t) => t.time), [10, 950], '按时间升序且保留了更早的那条');
});

test('排序：热门按回复数降序、同数按时间；按进度按时间升序', () => {
  const t1 = { id: 1, time: 100, replies: [] };
  const t2 = { id: 2, time: 200, replies: [1, 2] };
  const t3 = { id: 3, time: 50, replies: [1] };
  assert.deepEqual(orderThreads([t1, t2, t3], 'hot').map((t) => t.id), [2, 3, 1]);
  assert.deepEqual(orderThreads([t1, t2, t3], 'progress').map((t) => t.id), [3, 1, 2]);
});

test('排序不改动入参数组', () => {
  const input = [{ id: 1, time: 100, replies: [] }, { id: 2, time: 50, replies: [] }];
  orderThreads(input, 'progress');
  assert.deepEqual(input.map((t) => t.id), [1, 2]);
});

// ── 分组 ────────────────────────────────────────────────────────────────

const root = { id: 1, time: 100, author: '小林', role: 'ask', text: '主贴', createdAt: 1 };
const replyLate = { id: 2, time: 100, author: '阿哲', role: 'answer', text: '后发', parentId: 1, createdAt: 5 };
const replyEarly = { id: 3, time: 100, author: 'Lily', role: 'note', text: '先发', parentId: 1, createdAt: 2 };
const otherRoot = { id: 4, time: 200, author: '老王', role: 'ask', text: '另一串', createdAt: 3 };

test('两层还原：主贴挂回复，回复按 createdAt 升序', () => {
  const g = groupThreads([root, replyLate, replyEarly, otherRoot]);
  assert.equal(g.length, 2);
  assert.equal(g[0].id, 1);
  assert.deepEqual(g[0].replies.map((r) => r.id), [3, 2]);
  assert.equal(g[1].id, 4);
});

test('回复排在父评论之前也能正确归位（两趟扫描）', () => {
  const g = groupThreads([replyEarly, root]);
  assert.equal(g.length, 1);
  assert.equal(g[0].replies.length, 1);
});

test('孤儿回复提升为主贴，不静默丢内容', () => {
  const orphan = { id: 9, time: 300, author: '老王', role: 'answer', text: '孤儿回复', parentId: 777, createdAt: 1 };
  const g = groupThreads([orphan]);
  assert.equal(g.length, 1);
  assert.equal(g[0].id, 9);
  assert.equal(g[0].parentId, undefined, 'parentId 会被清掉，免得展示层再去找一次');
});

test('主贴按时间升序', () => {
  const g = groupThreads([otherRoot, root]);
  assert.deepEqual(g.map((t) => t.id), [1, 4]);
});

test('计数：讨论串数与发言总数', () => {
  assert.deepEqual(countComments([root, replyLate, otherRoot]), { threads: 2, posts: 3 });
  assert.deepEqual(countComments([]), { threads: 0, posts: 0 });
});

// ── 提示词契约（名单与清洗规则必须同一份来源） ──────────────────────────

test('提示词携带角色名单与 replies 输出契约', () => {
  const p = PROMPTS.comments('测试课程', '[00:00] 字幕内容');
  for (const name of COMMENT_AUTHOR_POOL) assert.ok(p.includes(name), `名单缺角色 ${name}`);
  assert.match(p, /"replies"/);
  assert.match(p, /"role"/);
  assert.ok(!p.includes('上文回顾'), '未传 context 时不该出现上文回顾段');
});

test('提示词带上文回顾（跨块串联用，且明确不要针对它生成）', () => {
  const p = PROMPTS.comments('测试课程', '[00:00] 字幕', '[00:00] 上文内容');
  assert.ok(p.includes('上文回顾'));
  assert.ok(p.includes('上文内容'));
  assert.match(p, /不要针对它生成讨论/);
});

test('提示词禁止正文写时间戳（正文不 linkify，写了会变成死链的错觉）', () => {
  assert.ok(PROMPTS.comments('测试课程', '[00:00] 字幕').includes('正文里不要写时间戳'));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
