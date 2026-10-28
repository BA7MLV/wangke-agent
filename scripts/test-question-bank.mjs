import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createServer } from 'vite';

const server = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { db } = await server.ssrLoadModule('/src/store/db.ts');
  const { createResourceExecutor, parseResource, libraryResourceTools } = await server.ssrLoadModule('/src/harness/resources.ts');
  const { quizHistoryContent, validateQuiz } = await server.ssrLoadModule('/src/harness/quiz.ts');
  const { questionBankFileOf } = await server.ssrLoadModule('/src/materials/questionBankFile.ts');
  const { saveMarkdownMaterial } = await server.ssrLoadModule('/src/materials/markdownFile.ts');
  const { getMaterialFile } = await server.ssrLoadModule('/src/store/fileStore.ts');
  const { recordWrongbookAttempt, readWrongbook } = await server.ssrLoadModule('/src/store/wrongbook.ts');
  const { parseWrongbook } = await server.ssrLoadModule('/src/study/wrongbook.ts');
  const { ensureBuiltinSkills } = await server.ssrLoadModule('/src/skills/store.ts');
  const { buildSessionMarkdown } = await server.ssrLoadModule('/src/utils/chatExport.ts');
  const folderId = await db.folders.add({ name: '试卷', createdAt: 1 });
  const source = { id: 'exam', name: '测试卷.pdf', kind: 'material', materialFormat: 'pdf', folderId, createdAt: 1, duration: 0, unitCount: 20 };
  await db.videos.add(source);
  const file = questionBankFileOf(source), path = '/courses/current/questions.md';
  const q = { stem: '1. 选择符合题意的一项。', options: ['甲', '乙', '丙', '丁'], answer: 1, answerSource: 'original',
    explanation: '原文答案见第 20 页；原文未附解析。', source: { courseId: 'exam', name: source.name, page: 3 }, images: ['#source-image/exam/page-3'] };
  const questions = Array.from({ length: 7 }, (_, i) => ({ ...q, stem: `${i + 1}. 原题` }));
  questions[5] = { ...questions[5], answer: -1, answerSource: 'missing' };
  questions[6] = { ...questions[6], answerSource: 'ai' };
  const markdown = '# 测试卷 · 题库\n\n我的笔记：保留。\n\n```quiz\n' + JSON.stringify({ questions }, null, 2) + '\n```\n';
  let displayed;
  const local = () => createResourceExecutor({ courseId: source.id, kind: 'page', onQuiz: (quiz) => { displayed = quiz; } });
  const execute = local();
  assert.equal(parseResource(path).leaf, 'questions.md');
  assert.match(await execute('read', { path }), /不存在/);
  assert.equal(await db.files.count(), 0, 'read does not create a file');
  assert.match(await execute('read', { path: '/courses/current/info' }), /正文总页数：20/);
  assert.match(await execute('edit', { path, create: true, content: markdown }), /题库唯一真相源/);
  assert.equal((await db.videos.get(file.id)).folderId, folderId);
  assert.equal((await db.videos.get(file.id)).name, '测试卷 · 题库.md');
  assert.equal(await (await getMaterialFile(file.id)).text(), markdown);
  assert.match(await execute('edit', { path, create: true, content: '# 覆盖' }), /已存在/);
  assert.match(await execute('grep', { path, query: '我的笔记', raw: true }), /我的笔记/);
  assert.match(await execute('present_quiz', { path, offset: 0, limit: 5 }), /offset=5/);
  assert.equal(displayed.questions.length, 5);
  assert.deepEqual(displayed.questions[0], questions[0]);
  assert.deepEqual(displayed.bank, { path, offset: 0, total: 7 });
  const snapshot = { content: '请作答', quiz: { data: displayed, picks: [0, -1, 1, -1, -1] } };
  assert.match(quizHistoryContent(snapshot), /已作答 2 题.*offset=5/);
  assert.equal(quizHistoryContent({ content: '老题卡', quiz: { data: { questions: [q] }, picks: [-1] } }), '老题卡');
  assert.match(await execute('present_quiz', { path, offset: 5 }), /不要覆盖/);
  assert.equal(displayed.questions[0].stem, '1. 原题', 'a second call must not discard unanswered cards');
  assert.match(await local()('present_quiz', { path, offset: 5 }), /最后一批/);
  assert.equal(displayed.questions.length, 2);
  assert.equal(displayed.questions[0].answerSource, 'missing');
  assert.equal(displayed.questions[1].answerSource, 'ai');
  assert.match(quizHistoryContent({ content: '', quiz: { data: displayed, picks: [-1, -1] } }), /已到题库末尾/);
  assert.match(await local()('present_quiz', { path, offset: 7 }), /末尾/);
  for (const args of [{ offset: -1 }, { limit: 6 }, { offset: '0' }, { limit: 1.5 }, { questions }]) {
    assert.match(await local()('present_quiz', { path, ...args }), /必须|二选一/);
  }
  assert.match(await local()('present_quiz', { path: '/courses/other/questions.md' }), /只能访问当前课程/);
  assert.match(await createResourceExecutor({ courseId: source.id })('present_quiz', { path }), /未展示/);
  const edited = markdown.replace('"answer": 1', '"answer": 2');
  await saveMarkdownMaterial(file.id, edited, markdown);
  await local()('present_quiz', { path, limit: 1 });
  assert.equal(displayed.questions[0].answer, 2, 'manual edits are authoritative, not an old chat copy');
  assert.match(await (await getMaterialFile(file.id)).text(), /我的笔记/);
  const inBank = createResourceExecutor({ courseId: file.id, kind: 'para', onQuiz: (quiz) => { displayed = quiz; } });
  assert.match(await inBank('present_quiz', { path: '/courses/current/material', offset: 1, limit: 1 }), /展示/);
  assert.equal(displayed.questions[0].stem, '2. 原题');
  await saveMarkdownMaterial(file.id, edited + '\n```quiz\n{broken}\n```', edited);
  displayed = undefined;
  assert.match(await local()('present_quiz', { path }), /不是有效 JSON/);
  assert.equal(displayed, undefined, 'damaged later blocks cannot silently yield a partial bank');

  const global = createResourceExecutor();
  await db.videos.add({ ...source, id: 'global-exam' });
  assert.match(await global('edit', { path: '/courses/global-exam/questions.md', create: true, content: markdown }), /已创建/);
  assert.match(await global('read', { path: '/courses/global-exam/questions.md' }), /题库唯一真相源/);
  assert.equal((await db.videos.get(questionBankFileOf({ ...source, id: 'global-exam' }).id)).folderId, folderId);
  assert.equal(libraryResourceTools(true).some(tool => tool.function.name === 'present_quiz'), false, 'global chat has no quiz card UI');
  const inline = local();
  assert.match(await inline('present_quiz', { questions: [q] }), /展示/);
  assert.match(await inline('present_quiz', { path }), /不要覆盖/, 'path calls cannot replace an inline card either');

  await recordWrongbookAttempt(q, q.source, { id: 'wrong-1', at: '2026-10-24T10:00:00Z', answer: 0, correct: false, durationSeconds: 3, rating: 1 });
  const entry = parseWrongbook(await readWrongbook())[0];
  assert.deepEqual(entry.question.images, q.images);
  assert.deepEqual(entry.question.source, q.source);
  assert.equal(entry.question.answerSource, 'original');
  assert.equal(entry.source.page, 3);
  await assert.rejects(recordWrongbookAttempt({ ...q, answerSource: 'ai' }, { ...q.source, page: 4 },
    { id: 'unverified', at: '2026-10-24T10:00:01Z', answer: 0, correct: false, durationSeconds: 1, rating: 1 }), /未核验/);
  assert.equal(parseWrongbook(await readWrongbook()).length, 1);
  const exported = buildSessionMarkdown({ title: '答题', videoName: '卷', messages: [{ role: 'assistant', content: '', quiz: { data: { questions: questions.slice(5) }, picks: [0, 0] } }] });
  assert.match(exported, /待批改/);
  assert.match(exported, /AI 参考答案/);
  assert.doesNotMatch(exported, /正确答案|（错误）|undefined/);
  await ensureBuiltinSkills();
  const skill = await db.skills.where('name').equals('原题题库').first();
  assert.ok(skill?.enabled);
  assert.match(await local()('read', { path: '/skills/' + encodeURIComponent('原题题库') }), /不创建数据库/);
  assert.match(await createResourceExecutor({ courseId: source.id, allowedSkillIds: [] })('read', { path: '/skills/' + encodeURIComponent('原题题库') }), /不在本次会话/);

  const base = { stem: '不同题型', explanation: '原解析', answerSource: 'original', source: q.source, images: ['#source-image/exam/page-3-region-20-30-900-300'] };
  const typed = [
    { ...base, type: 'multiple', options: ['甲', '乙', '丙'], answer: [0, 2] },
    { ...base, type: 'boolean', answer: false },
    { ...base, type: 'fill', answer: ['北京', '2'], acceptedAnswers: [['北京', '北京市'], ['2']] },
    { ...base, type: 'ordering', options: ['甲', '乙'], answer: [1, 0] },
    { ...base, type: 'matching', options: ['甲', '乙'], matches: ['一', '二'], answer: [1, 0] },
    { ...base, type: 'freeform', typeLabel: '证明题', answer: '原文参考证明', presentation: { html: '<textarea></textarea>' } },
  ];
  typed.push({ ...base, type: 'composite', parts: [typed[1], typed[5]], answer: [false, typed[5].answer] });
  const values = [[0], true, ['上海', '2'], [0, 1], [0, 1], '学生证明\n包含 | 表格和 ``` 代码', [true, '学生证明']];
  for (const [i, raw] of typed.entries()) {
    const validated = validateQuiz({ questions: [raw] });
    assert.equal(validated.ok, true, JSON.stringify(validated));
    const question = validated.quiz.questions[0];
    await recordWrongbookAttempt(question, q.source, { id: `typed-${i}`, at: '2026-10-24T12:00:00Z', answer: values[i], correct: false,
      durationSeconds: 5, rating: 1, ...(i >= 5 ? { grading: 'self' } : {}) });
    const saved = parseWrongbook(await readWrongbook()).find(entry => entry.attempts.some(a => a.id === `typed-${i}`));
    assert.deepEqual(saved.question, question);
    assert.deepEqual(saved.attempts[0].answer, values[i]);
    assert.equal(saved.attempts[0].grading, i >= 5 ? 'self' : undefined);
  }
  await assert.rejects(recordWrongbookAttempt({ ...typed[5], options: [], stem: '未经自评' }, q.source,
    { id: 'forged-self', at: '2026-10-24T12:00:00Z', answer: '学生证明', correct: false, durationSeconds: 1, rating: 1 }), /作答记录/);
  const mixed = '# 混合题型\n\n```quiz\n' + JSON.stringify({ questions: typed }) + '\n```\n';
  await saveMarkdownMaterial(file.id, mixed, edited + '\n```quiz\n{broken}\n```');
  assert.match(await local()('present_quiz', { path, offset: 5, limit: 2 }), /最后一批/);
  assert.equal(displayed.questions[0].type, 'freeform');
  assert.equal(displayed.questions[1].parts.length, 2);
  const richExport = buildSessionMarkdown({ title: '混合', videoName: '卷', messages: [{ role: 'assistant', content: '', quiz: { data: displayed,
    picks: [{ answer: values[5], selfGrade: false }, { answer: values[6] }] } }] });
  assert.match(richExport, /自评：错误/);
  assert.match(richExport, /region-20-30-900-300/);
  assert.doesNotMatch(richExport, /undefined/);
  db.close();
  console.log('PASS: ordinary Markdown bank, original images, answer provenance, latest-file grading, pagination, isolation, wrongbook, export and skill scope');
} finally {
  await server.close();
}
