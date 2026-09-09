#!/usr/bin/env node
/**
 * .apkg 生成的结构断言：Node 下用 sql.js 建包 → 解 zip → 重开 SQLite 逐表校验。
 * 运行：node scripts/test-apkg.mjs（无需 API key；sql.js 在 Node 直接从 node_modules 读 wasm）
 */
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { unzipSync, strFromU8 } from 'fflate';
import { buildApkgBytes } from '../src/anki/apkgCore.ts';

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

const SQL = await initSqlJs();

const CARDS = [
  { id: 1, videoId: 'v1', q: '光合作用发生在什么细胞器中？', a: '叶绿体', time: 625, status: 1, createdAt: 1 },
  { id: 2, videoId: 'v1', q: 'HTML 转义 <>& 与\n换行', a: '第二行\n答案', time: 3805, status: 1, createdAt: 1 },
];

const bytes = buildApkgBytes(SQL, '生物学 第3讲.mp4', CARDS);
const entries = unzipSync(bytes);

test('zip 包含 collection.anki2 与空 media 清单', () => {
  assert.ok(entries['collection.anki2'] instanceof Uint8Array);
  assert.equal(strFromU8(entries['media']), '{}');
});

const db = new SQL.Database(entries['collection.anki2']);
const scalar = (sql) => db.exec(sql)[0].values[0][0];

test('五张核心表齐全', () => {
  const names = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.flat();
  for (const t of ['col', 'notes', 'cards', 'revlog', 'graves']) assert.ok(names.includes(t), t);
});

test('notes/cards 行数与卡片数一致', () => {
  assert.equal(scalar('SELECT COUNT(*) FROM notes'), CARDS.length);
  assert.equal(scalar('SELECT COUNT(*) FROM cards'), CARDS.length);
});

test('note 字段：guid 唯一、tags 含层级标签、flds 三段 \x1f 分隔', () => {
  const res = db.exec('SELECT guid, tags, flds, sfld, csum FROM notes ORDER BY id');
  const rows = res[0].values;
  assert.notEqual(rows[0][0], rows[1][0]); // guid 唯一
  assert.match(rows[0][1], / 网课 /);
  assert.match(rows[0][1], /网课::生物学_第3讲/); // 空格转下划线
  const flds = rows[0][2].split('\x1f');
  assert.equal(flds.length, 3);
  assert.equal(flds[0], '光合作用发生在什么细胞器中？');
  assert.equal(flds[1], '叶绿体');
  assert.equal(flds[2], '视频 @10:25'); // 625 秒 → m:ss
  assert.equal(rows[0][3], flds[0]); // sfld = 首字段
  assert.equal(typeof rows[0][4], 'number');
});

test('flds HTML 转义 + 换行转 <br>', () => {
  const flds = db.exec('SELECT flds FROM notes ORDER BY id')[0].values[1][0].split('\x1f');
  assert.equal(flds[0], 'HTML 转义 &lt;&gt;&amp; 与<br>换行');
  assert.equal(flds[1], '第二行<br>答案');
  assert.equal(flds[2], '视频 @1:03:25'); // 3805 秒 → h:mm:ss
});

test('cards 行指向正确 note/deck，新卡状态（type=queue=0，due=nid）', () => {
  const rows = db.exec('SELECT nid, did, ord, type, queue, due FROM cards ORDER BY id')[0].values;
  const nids = db.exec('SELECT id FROM notes ORDER BY id')[0].values.flat();
  const did = scalar('SELECT did FROM cards LIMIT 1');
  rows.forEach(([nid, d, ord, type, queue, due], i) => {
    assert.equal(nid, nids[i]);
    assert.equal(d, did);
    assert.deepEqual([ord, type, queue], [0, 0, 0]);
    assert.equal(due, nid);
  });
});

test('col：models/decks/conf/dconf JSON 合法且互相引用', () => {
  const [modelsJ, decksJ, confJ, dconfJ] = db.exec('SELECT models, decks, conf, dconf FROM col')[0].values[0];
  const models = JSON.parse(modelsJ);
  const decks = JSON.parse(decksJ);
  const conf = JSON.parse(confJ);
  const dconf = JSON.parse(dconfJ);
  const model = Object.values(models)[0];
  assert.equal(model.name, '网课问答卡');
  assert.deepEqual(model.flds.map((f) => f.name), ['Front', 'Back', 'Source']);
  assert.match(model.tmpls[0].afmt, /FrontSide/);
  assert.match(model.tmpls[0].afmt, /\{\{#Source\}\}/);
  assert.equal(conf.curModel, String(model.id));
  const deckNames = Object.values(decks).map((d) => d.name);
  assert.ok(deckNames.includes('Default'));
  assert.ok(deckNames.includes('网课::生物学 第3讲')); // 牌组名保留空格（Anki 允许）
  assert.equal(dconf['1'].name, 'Default');
});

test('cards.did 指向 decks 里的课程牌组', () => {
  const did = scalar('SELECT did FROM cards LIMIT 1');
  const decks = JSON.parse(scalar('SELECT decks FROM col'));
  assert.equal(decks[String(did)].name, '网课::生物学 第3讲');
});

db.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
