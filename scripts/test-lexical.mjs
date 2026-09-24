#!/usr/bin/env node
// 词法检索：分词、BM25 打分与排序。
//
// 守的是「稠密检索被移除后，检索仍然找得到东西」这条底线：
// 尤其是编号 / 英文缩写这类**字面命中**（那正是换掉向量的直接动因），
// 以及单字查询能命中更长的中文词（unigram + bigram 分词的存在理由）。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import os from 'node:os';
import { unlinkSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `test-lexical-${Date.now()}.mjs`);

execSync(
  `node_modules/.bin/esbuild src/harness/lexical.ts --bundle --platform=node --format=esm --outfile=${tmp}`,
  { cwd: root, stdio: 'inherit' },
);

const { tokenize, bm25Idf, lexicalSearch } = await import(tmp);

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

/** 用「文本数组 + textOf」搭一个最小语料，避免测试里出现数据库 */
function corpus(texts) {
  const docs = texts.map((text, idx) => ({ text, idx }));
  return { docs, textOf: (d) => d.text };
}
function topTexts(texts, query, topK = 6, opts) {
  const { docs, textOf } = corpus(texts);
  return lexicalSearch(docs, textOf, query, topK, opts).map((h) => h.doc.text);
}

console.log('tokenize');
test('中文串发单字与邻接二字组', () => {
  // 顺序无关（BM25 只看词项集合），所以排序后比较
  assert.deepEqual([...tokenize('中文')].sort(), ['中', '中文', '文'].sort());
});

test('单字串只发自己（否则查「幂」永远命不中）', () => {
  assert.deepEqual(tokenize('幂'), ['幂']);
});

test('中文与数字混合：数字单独成词', () => {
  assert.deepEqual([...tokenize('第4条')].sort(), ['4', '条', '第'].sort());
});

test('英文缩写整段成词且小写化', () => {
  assert.deepEqual(tokenize('BGE-M3'), ['bge', 'm3']);
});

test('标点与空白只作分隔符，且不产生跨分隔符的二字组', () => {
  const t = tokenize('过拟合，是 什么？');
  assert.ok(!t.some((x) => /[，？\s]/.test(x)), '词项里不该含标点或空白');
  assert.ok(t.includes('拟合'));
  // 「拟合」与「是」被逗号隔开：跨过分隔符的「合是」不该出现，
  // 否则「标点当空格用」和「标点当边界用」两种读法会得到同一串词项，边界就形同虚设
  assert.ok(!t.includes('合是'));
});

test('空串与纯标点返回空', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('  ，。！ '), []);
});

console.log('bm25Idf');
test('越常见的词 idf 越小', () => {
  assert.ok(bm25Idf(10, 1) > bm25Idf(10, 5));
});

test('df 达到全部文档数时仍然非负（用 log(1+…) 变体的理由）', () => {
  assert.ok(bm25Idf(10, 10) >= 0);
  assert.ok(bm25Idf(10, 0) > 0);
});

console.log('lexicalSearch');
test('命中关键词的文档排第一', () => {
  const got = topTexts(
    ['今天讲天气', '我们来看贝叶斯定理的应用', '另一个无关话题'],
    '贝叶斯定理',
  );
  assert.equal(got[0], '我们来看贝叶斯定理的应用');
});

test('单字查询能命中更长的中文词（unigram 分词的直接收益）', () => {
  const got = topTexts(['接下来讲幂运算的规则', '这节课讲函数图像'], '幂');
  assert.equal(got[0], '接下来讲幂运算的规则');
});

test('英文标识符字面命中（换掉向量的直接动因）', () => {
  const got = topTexts(['错误码是 E1243', '错误码是 E1234', '这里没有错误码'], 'E1234');
  assert.equal(got[0], '错误码是 E1234');
});

test('编号类查询字面命中', () => {
  const got = topTexts(['第一条 总则', '第四条 申报流程', '第二条 适用范围'], '第4条 申报流程');
  assert.equal(got[0], '第四条 申报流程');
});

test('查不到就返回空数组，而不是硬凑一堆无关片段', () => {
  const got = topTexts(['今天讲天气', '明天讲地理'], '量子纠缠');
  assert.deepEqual(got, []);
});

test('空查询返回空', () => {
  assert.deepEqual(topTexts(['任意内容'], ''), []);
  assert.deepEqual(topTexts(['任意内容'], '  ，。 '), []);
});

test('空语料返回空', () => {
  assert.deepEqual(topTexts([], '任意查询'), []);
});

test('topK 生效', () => {
  const texts = Array.from({ length: 10 }, (_, i) => `第${i}节 讲同一个概念`);
  assert.equal(topTexts(texts, '概念', 3).length, 3);
  assert.equal(topTexts(texts, '概念', 0).length, 0);
});

test('结果按分数降序', () => {
  const { docs, textOf } = corpus(['概念', '概念 概念 概念 概念', '概念 概念']);
  const hits = lexicalSearch(docs, textOf, '概念', 6);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
});

test('长度归一化：同样命中，短文档分数更高（b 生效）', () => {
  const { docs, textOf } = corpus(['概念', `概念${'填充内容'.repeat(50)}`]);
  const hits = lexicalSearch(docs, textOf, '概念', 6);
  assert.equal(hits[0].doc.text, '概念');
  assert.ok(hits[0].score > hits[1].score);
});

test('覆盖率加成：全中的文档正好乘 1+bonus', () => {
  const { docs, textOf } = corpus(['甲 乙']);
  const withBonus = lexicalSearch(docs, textOf, '甲 乙', 6, { coverageBonus: 0.5 })[0].score;
  const noBonus = lexicalSearch(docs, textOf, '甲 乙', 6, { coverageBonus: 0 })[0].score;
  assert.ok(Math.abs(withBonus / noBonus - 1.5) < 1e-9);
});

test('覆盖率加成：只中一半的文档乘 1+bonus/2', () => {
  const { docs, textOf } = corpus(['甲']);
  const withBonus = lexicalSearch(docs, textOf, '甲 乙', 6, { coverageBonus: 0.5 })[0].score;
  const noBonus = lexicalSearch(docs, textOf, '甲 乙', 6, { coverageBonus: 0 })[0].score;
  assert.ok(Math.abs(withBonus / noBonus - 1.25) < 1e-9);
});

test('查询词去重：同一个词写两遍不重复计分', () => {
  const once = lexicalSearch(corpus(['概念']).docs, (d) => d.text, '概念', 6)[0].score;
  const twice = lexicalSearch(corpus(['概念']).docs, (d) => d.text, '概念 概念', 6)[0].score;
  assert.ok(Math.abs(once - twice) < 1e-9, `${once} vs ${twice}`);
});

test('同分保持入参顺序（排序稳定，结果可复现）', () => {
  const { docs, textOf } = corpus(['概念 A', '概念 B', '概念 C']);
  const hits = lexicalSearch(docs, textOf, '概念', 6);
  assert.deepEqual(hits.map((h) => h.doc.idx), [0, 1, 2]);
});

test('词频是非重叠计数（不重复数同一段字符）', () => {
  // 'aaa' 里 'aa' 非重叠只出现 1 次；重叠计数会得 2
  const a = lexicalSearch(corpus(['aaa']).docs, (d) => d.text, 'aa', 6)[0].score;
  const b = lexicalSearch(corpus(['aa']).docs, (d) => d.text, 'aa', 6)[0].score;
  assert.ok(Math.abs(a - b) < 1e-9);
});

test('topK 传负数表示不限条数', () => {
  const texts = ['概念一', '概念二', '概念三'];
  assert.equal(topTexts(texts, '概念', -1).length, 3);
});

test('textOf 返回空串时该文档只是不命中，不影响其他文档', () => {
  const docs = [{ t: '' }, { t: '贝叶斯定理' }];
  const hits = lexicalSearch(docs, (d) => d.t, '贝叶斯定理', 6);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].doc.t, '贝叶斯定理');
});

unlinkSync(tmp);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
