// Run: npx tsx --test scripts/test-wrongbook.mjs
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createEmptyCard, fsrs } from 'ts-fsrs';
import { applyAttempt, dueQuestions, EMPTY_WRONGBOOK, migrateWrongbook, parseWrongbook, questionId, Rating, writeQuestion } from '../src/study/wrongbook.ts';
import { db } from '../src/store/db.ts';
import { ensureWrongbookMaterial, importWrongbook, readWrongbook, recordWrongbookAttempt, saveWrongbookMarkdown, setWrongbookStatus } from '../src/store/wrongbook.ts';
import { extractMdUnits, mdCoverText } from '../src/materials/md.ts';

const question = { stem: '1 + 1 = ?', options: ['1', '2', '3', '4'], answer: 1, explanation: '相加得 2。\n```js\n1 + 1\n```' };
const source = { courseId: 'test-course', page: 12 };
const time = '2026-10-20T10:00:00.000Z';
const wrong = { id: 'attempt-1', at: time, answer: 0, correct: false, durationSeconds: 12.5, rating: Rating.Again };
const id = await questionId(question, source);
const entry = applyAttempt(undefined, id, question, source, wrong);

after(() => db.close());

test('first error uses real FSRS, correct first answers are not collected', () => {
  assert.equal(applyAttempt(undefined, id, question, source, { ...wrong, correct: true, answer: 1, rating: Rating.Good }), undefined);
  const expected = fsrs({ enable_fuzz: false }).next(createEmptyCard(time), time, Rating.Again).card;
  assert.equal(entry.card.due, expected.due.toISOString());
  assert.equal(entry.card.stability, expected.stability);
  assert.equal(entry.attempts.length, 1);
});

test('single Markdown round-trips nested code fences and preserves external notes', () => {
  const markdown = EMPTY_WRONGBOOK + '\n我的笔记：不要遗漏定义域。\n';
  const written = writeQuestion(markdown, entry);
  assert.deepEqual(parseWrongbook(written), [entry]);
  const corrected = applyAttempt(entry, id, question, source, {
    id: 'attempt-2', at: '2026-10-20T10:05:00.000Z', answer: 1, correct: true, durationSeconds: 8, rating: Rating.Good,
  });
  const updated = writeQuestion(written, corrected);
  assert.equal(parseWrongbook(updated).length, 1);
  assert.equal(parseWrongbook(updated)[0].attempts.length, 2);
  assert.match(updated, /我的笔记：不要遗漏定义域。/);
  assert.deepEqual(parseWrongbook(updated.replaceAll('\n', '\r\n')), [corrected]);
});

test('retry is idempotent and identity ignores explanation changes', async () => {
  assert.equal(applyAttempt(entry, id, question, source, wrong), entry);
  assert.equal(await questionId({ ...question, explanation: '新的解析' }, source), id);
  assert.notEqual(await questionId(question, { ...source, page: 13 }), id);
});

test('correct ratings update schedule without removing the error history', () => {
  for (const rating of [Rating.Hard, Rating.Good, Rating.Easy]) {
    const next = applyAttempt(entry, id, question, source, { ...wrong, id: `review-${rating}`, at: '2026-10-21T10:00:00.000Z', answer: 1, correct: true, rating });
    assert.equal(next.attempts.length, 2);
    assert.equal(next.attempts[0].correct, false);
    assert.ok(Date.parse(next.card.due) > Date.parse(next.card.last_review));
  }
  assert.equal(dueQuestions([entry], new Date(time)).length, 0);
  assert.equal(dueQuestions([entry], new Date('2026-10-21')).length, 1);
  assert.equal(dueQuestions([{ ...entry, status: 'mastered' }], new Date('2026-10-21')).length, 0);
  assert.throws(() => applyAttempt(entry, id, question, source, { ...wrong, id: 'past', at: '2026-10-19T10:00:00Z' }));
});

test('damaged, duplicate and inconsistent blocks fail closed', () => {
  const markdown = writeQuestion(EMPTY_WRONGBOOK, entry);
  assert.throws(() => parseWrongbook('# Not a notebook'));
  assert.throws(() => parseWrongbook(markdown.replace('<!-- /wrongbook:question -->', '')));
  assert.throws(() => parseWrongbook(markdown.replace('<!-- /wrongbook:stem -->', '')));
  assert.throws(() => parseWrongbook(markdown + markdown));
  assert.throws(() => writeQuestion(markdown, { ...entry, card: { ...entry.card, due: 'bad-date' } }));
  assert.throws(() => writeQuestion(markdown, { ...entry, attempts: [{ ...wrong, correct: true }] }));
});

test('transactional file storage handles concurrency, deduplication, import and conflict safety', async () => {
  await recordWrongbookAttempt(question, source, wrong);
  await Promise.all(Array.from({ length: 8 }, (_, i) => recordWrongbookAttempt(question, source, {
    ...wrong, id: `parallel-${i}`, at: '2026-10-20T10:05:00.000Z',
  })));
  let markdown = await readWrongbook();
  assert.equal(parseWrongbook(markdown).length, 1);
  assert.equal(parseWrongbook(markdown)[0].attempts.length, 9);
  await recordWrongbookAttempt(question, source, wrong);
  assert.equal(await readWrongbook(), markdown);
  await importWrongbook(markdown);
  assert.equal(await readWrongbook(), markdown);
  await setWrongbookStatus(id, 'mastered');
  markdown = await readWrongbook();
  assert.equal(parseWrongbook(markdown)[0].status, 'mastered');
  await assert.rejects(importWrongbook(writeQuestion(EMPTY_WRONGBOOK, entry)), /冲突/);
  assert.equal(await readWrongbook(), markdown);
  await assert.rejects(importWrongbook(markdown.replace('wrongbook:v2', 'wrongbook:v99')));
  assert.equal(await readWrongbook(), markdown);
  await recordWrongbookAttempt(question, source, { ...wrong, id: 'reopened', at: '2026-10-21T10:00:00Z' });
  assert.equal(parseWrongbook(await readWrongbook())[0].status, 'reviewing');
  const second = { ...question, stem: '第二题' };
  await Promise.all([recordWrongbookAttempt(second, source, wrong), recordWrongbookAttempt(question, source, {
    ...wrong, id: 'last', at: '2026-10-22T10:00:00Z',
  })]);
  assert.equal(parseWrongbook(await readWrongbook()).length, 2);
  const backup = await readWrongbook();
  await db.files.clear();
  await importWrongbook(backup);
  assert.equal(await readWrongbook(), backup);
  // Human-readable imported IDs remain stable when reviewed, not re-hashed into a duplicate.
  await db.files.clear();
  const custom = { ...entry, id: 'q-001' };
  await importWrongbook(writeQuestion(EMPTY_WRONGBOOK, custom));
  await recordWrongbookAttempt(question, source, { ...wrong, id: 'custom-review', at: '2026-10-21T10:00:00Z' }, custom.id);
  assert.equal(parseWrongbook(await readWrongbook()).length, 1);
  assert.equal(parseWrongbook(await readWrongbook())[0].attempts.length, 2);
});

test('question text and tables are real Markdown; edits and handwritten notes are authoritative', () => {
  let markdown = writeQuestion(EMPTY_WRONGBOOK, entry);
  assert.doesNotMatch(markdown, /```wrongbook-question|"stem"|"explanation"|"correct"/);
  assert.match(markdown, /### 题目\n\n<!-- wrongbook:stem -->\n1 \+ 1 = \?/);
  assert.match(markdown, /\| 时间 \| 答案 \| 结果 \| 用时（秒） \| 反馈 \|/);
  markdown = markdown.replace('1 + 1 = ?', '编辑后的题干：一加一？')
    .replace('相加得 2。', '编辑后的解析。')
    .replace('<!-- /wrongbook:question -->', '\n### 我的笔记\n\n先看清题意。\n<!-- /wrongbook:question -->');
  const parsed = parseWrongbook(markdown)[0];
  assert.equal(parsed.question.stem, '编辑后的题干：一加一？');
  assert.match(parsed.question.explanation, /^编辑后的解析。/);
  const updated = writeQuestion(markdown, { ...parsed, status: 'mastered' });
  assert.match(updated, /先看清题意。/);
  assert.equal(parseWrongbook(updated)[0].status, 'mastered');
  assert.match(updated, /编辑后的题干：一加一？/);
});

test('HTML comments are hidden from material text and cover, but code examples survive', () => {
  const markdown = writeQuestion(EMPTY_WRONGBOOK, entry);
  const text = extractMdUnits(markdown).map((u) => u.text).join('\n');
  assert.doesNotMatch(text, /wrongbook:|attemptIds|stability|difficulty/);
  assert.match(text, /1 \+ 1 = \?/);
  assert.match(text, /相加得 2/);
  assert.doesNotMatch(mdCoverText(markdown).preview, /wrongbook:/);
  const code = '```html\n<!-- a comment inside code -->\n```';
  assert.match(extractMdUnits(code)[0].text, /<!-- a comment inside code -->/);
});

test('v1 migration preserves all history and notes, then registers a real Markdown material', async () => {
  const legacy = '# 错题本\n\n<!-- wrongbook:v1 -->\n\n我的旧笔记。\n\n## q-001\n\n```wrongbook-question\n' + JSON.stringify(entry, null, 2) + '\n```\n';
  const migrated = migrateWrongbook(legacy);
  assert.deepEqual(parseWrongbook(migrated), [entry]);
  assert.match(migrated, /我的旧笔记。/);
  assert.doesNotMatch(migrated, /```wrongbook-question/);
  assert.equal(migrateWrongbook(migrated), migrated);
  await db.videos.delete('wrongbook.md');
  await db.files.put({ id: 'wrongbook.md', blob: new Blob([legacy]) });
  await ensureWrongbookMaterial();
  const material = await db.videos.get('wrongbook.md');
  assert.equal(material.name, 'wrongbook.md');
  assert.equal(material.kind, 'material');
  assert.equal(material.materialFormat, 'md');
  assert.equal(await readWrongbook(), migrated);
  const blocks = await db.materialBlocks.where('materialId').equals('wrongbook.md').toArray();
  assert.ok(blocks.some((b) => b.text.includes(question.stem)));
  assert.ok(blocks.every((b) => !b.text.includes('attemptIds')));
});

test('Markdown editor saves the same file and index; stale edits never erase newer attempts', async () => {
  const original = await readWrongbook();
  const edited = original.replace('相加得 2。', '用户修改后的解析。');
  await saveWrongbookMarkdown(edited, original);
  assert.equal(await readWrongbook(), edited);
  assert.match(parseWrongbook(await readWrongbook())[0].question.explanation, /^用户修改后的解析。/);
  assert.ok((await db.materialBlocks.where('materialId').equals('wrongbook.md').toArray()).some((b) => b.text.includes('用户修改后的解析。')));
  await recordWrongbookAttempt(question, source, { ...wrong, id: 'other-tab', at: '2026-10-21T10:00:00Z' });
  const newest = await readWrongbook();
  await assert.rejects(saveWrongbookMarkdown(edited + '\n我的草稿', edited), /其他页面更新/);
  assert.equal(await readWrongbook(), newest);
  const ordinary = '# 我的错题\n\n自由编辑，不要求专有格式。';
  await saveWrongbookMarkdown(ordinary, newest);
  assert.equal(await readWrongbook(), ordinary);
});
