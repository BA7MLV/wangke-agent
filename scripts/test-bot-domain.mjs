import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { BotSkills } from '../apps/api/src/agent/skills.ts';
import { BotMemory } from '../apps/api/src/agent/memory.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-domain-'));
const store = new DatabaseStore(path.join(root, 'db.sqlite'));
const link = path.resolve('packages/study-core/assets/builtin/course-handout/references/review-probe.md');
try {
  const owner = 'domain-owner', other = 'domain-other', at = new Date().toISOString();
  for (const id of [owner, other]) store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, id, at);
  const config = new CloudConfiguration(store, path.join(root, 'config'));
  const service = new BotApplicationService(store, { enqueue() {}, cancel() {} });
  const thread = service.create(owner, 'bot', 'Domain');
  const msg = service.send(owner, thread.id, { clientNonce: 'domain', content: 'Remember course evidence' });
  const run = store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(msg.id).id;
  store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run);
  const records = new CloudRecords(store), tools = new StudyTools(store, config, path.join(root, 'files'));
  fs.mkdirSync(path.join(root, 'files'));
  let sequence = 0;
  const context = () => ({ owner, thread: thread.id, run, step: `domain-${++sequence}`, signal: new AbortController().signal, checkActive() {}, append() {} });
  const invoke = (name, args) => tools.plugins.get(name).execute(args, context());
  const manage = (table, key, before, after) => invoke('study_manage', { table, key, before, after });
  const read = async (table, key) => (await invoke('study_record', { table, key })).value;
  const file = await receiveFile(store, path.join(root, 'files'), owner, Readable.from(['content']), 'owned.md', 'text/markdown', 100);
  const alien = await receiveFile(store, path.join(root, 'files'), other, Readable.from(['private']), 'private.md', 'text/markdown', 100);
  const course = { id: 'course', name: '课程', size: 7, mimeType: 'video/mp4', duration: 30, createdAt: 1, status: 'transcribed', skillOverride: { pin: [-4], drop: [] } };
  await manage('videos', 'course', null, course);
  const valid = {
    folders: { id: 1, name: 'Folder', createdAt: 1, color: 'blue' },
    segments: { id: 1, videoId: 'course', idx: 0, start: 0, end: 3, text: '真实字幕', status: 1, cues: [{ start: 0, end: 3, text: '字幕' }] },
    materialBlocks: { id: 1, materialId: 'course', idx: 0, unit: 1, unitLabel: '第1页', text: '材料', kind: 'body' },
    handouts: { id: 1, videoId: 'course', createdAt: 1, title: '讲义', blob: { $file: file.id, type: 'text/markdown' }, outlineJson: JSON.stringify({ title: '课程', summary: '摘要', sections: [{ heading: '标题', start: '00:00', end: '00:03', points: ['考点'] }] }), sectionsJson: JSON.stringify([{ heading: '标题', blocks: [{ type: 'para', text: '段落' }, { type: 'list', ordered: false, items: ['item'] }, { type: 'table', header: ['列'], rows: [['值']] }, { type: 'figure', ts: 1 }] }]), usedSkills: ['course-handout'], readPos: { anchor: 's0b0', offset: -2 } },
    cards: { id: 1, videoId: 'course', q: '问题?', a: '答案', time: 1, status: 0, createdAt: 1 },
    studyDays: { date: '2026-10-26', seconds: 20, updatedAt: 1 },
    courseFiles: { id: 'course', fileId: file.id, mimeType: 'text/markdown', size: 7, directory: 'materials' },
    files: { id: 'course', blob: { $file: file.id, type: 'text/markdown' } },
    subtitleTracks: { id: 1, videoId: 'course', lang: 'zh', lanDoc: '中文', primary: 1, cues: [{ start: 0, end: 1, text: '字幕' }] },
    comments: { id: 1, videoId: 'course', time: 1, author: 'Learner', role: 'ask', text: '问', createdAt: 1 },
    danmakus: { id: 1, videoId: 'course', time: 1, text: '考点' },
  };
  // Every table: incomplete create/delete-required-field is rejected without
  // any record/operation/revision write; then use real read results to edit.
  const snapshot = () => JSON.stringify({ records: store.db.prepare('SELECT * FROM cloud_records ORDER BY revision').all(), operations: store.db.prepare('SELECT * FROM cloud_operations ORDER BY id').all() });
  for (const [table, row] of Object.entries(valid)) {
    const key = row.id ?? row.date;
    const before = snapshot();
    await assert.rejects(manage(table, key, null, { [table === 'studyDays' ? 'date' : 'id']: key }));
    assert.equal(snapshot(), before, `${table}: incomplete mutation has zero writes`);
    await manage(table, key, null, row);
    const persisted = await read(table, key), broken = { ...persisted };
    delete broken[Object.keys(row).find(k => !['id', 'date'].includes(k))];
    const state = snapshot(); await assert.rejects(manage(table, key, persisted, broken)); assert.equal(snapshot(), state);
    await manage(table, key, persisted, { ...persisted });
  }
  const bad = [
    ['segments', 1, { cues: { arbitrary: true } }], ['segments', 1, { cues: [{ start: 2, end: 1, text: 'bad' }] }],
    ['segments', 1, { idx: 1.5 }], ['segments', 1, { videoId: 'other-course' }], ['segments', 1, { text: 42 }],
    ['videos', 'course', { skillOverride: { pin: ['shell'], drop: [] } }], ['videos', 'course', { status: 'ready' }],
    ['videos', 'course', { createdAt: -1 }], ['folders', 1, { parentId: 1 }], ['folders', 1, { color: 'pink' }],
    ['cards', 1, { status: 3 }], ['materialBlocks', 1, { kind: 'script' }], ['materialBlocks', 1, { unit: 0 }],
    ['subtitleTracks', 1, { cues: [null] }], ['comments', 1, { role: 'system' }], ['comments', 1, { parentId: 1 }],
    ['studyDays', '2026-10-26', { seconds: 86401 }], ['handouts', 1, { blob: { arbitrary: true } }],
    ['handouts', 1, { blob: { $file: alien.id, type: 'text/markdown' } }], ['files', 'course', { blob: [] }],
    ['courseFiles', 'course', { fileId: alien.id }], ['handouts', 1, { usedSkills: { arbitrary: true } }],
    ['handouts', 1, { readPos: { anchor: 'sum', offset: '2' } }], ['handouts', 1, { outlineJson: '{}' }],
    ['handouts', 1, { sectionsJson: JSON.stringify([{ heading: 'h', blocks: [{ type: 'list', ordered: 1, items: ['a'] }] }]) }],
    ['handouts', 1, { sectionsJson: JSON.stringify([{ heading: 'h', blocks: [{ type: 'figure', ts: '1' }] }]) }],
    ['videos', 'course', { biliSource: { bvid: 'BVtest', aid: 1, cid: -1, page: 1 } }],
    ['handouts', 1, { sectionsJson: JSON.stringify([{ heading: 'h', blocks: [{ type: 'table', header: ['a'], rows: [['a', 'b']] }] }]) }],
  ];
  for (const [table, key, patch] of bad) { const before = await read(table, key), state = snapshot(); await assert.rejects(manage(table, key, before, { ...before, ...patch })); assert.equal(snapshot(), state, `${table}: invalid nested value has zero writes`); }
  // The actual Node text-source handout pipeline uses heading-only outline
  // sections and an owned descriptor without a MIME override.
  const textHandout = { ...valid.handouts, id: 2, blob: { $file: file.id }, outlineJson: JSON.stringify({ title: '文字讲义', summary: '摘要', sections: [{ heading: '标题' }] }) };
  await manage('handouts', 2, null, textHandout);
  const realTextHandout = await read('handouts', 2);
  await manage('handouts', 2, realTextHandout, { ...realTextHandout, title: '合法编辑' });
  await manage('handouts', 2, await read('handouts', 2), null);
  const legacy = { ...course, futureField: { legacy: true } };
  records.apply(owner, [{ id: 'legacy', table: 'videos', key: 'course', before: course, after: legacy }]);
  const live = await read('videos', 'course');
  await manage('videos', 'course', live, { ...live, name: '更新课程' });
  await assert.rejects(manage('videos', 'course', { ...live, invented: true }, { ...live, invented: true }));
  await assert.rejects(manage('videos', 'course', { ...live, futureField: { fake: true } }, { ...live, futureField: { fake: true } }));
  // Optimistic disjoint updates remain mergeable, including legacy data.
  const stale = await read('videos', 'course');
  records.apply(owner, [{ id: 'concurrent', table: 'videos', key: 'course', before: stale, after: { ...stale, pinned: 1 } }]);
  await manage('videos', 'course', stale, { ...stale, name: '合并后课程' });
  assert.equal((await read('videos', 'course')).pinned, 1);

  const fact = await invoke('study_memory', { action: 'save', scope: 'course', scopeId: 'course', kind: 'course_fact', content: '课程事实', source: 'record:segments:1' });
  assert.equal(fact.status, 'active'); assert.ok(fact.source_revision);
  const segment = await read('segments', 1);
  await manage('segments', 1, segment, { ...segment, text: '教材已修订' });
  assert.equal((await invoke('study_memory', { action: 'list' })).find(m => m.id === fact.id).status, 'stale');
  const fact2 = await invoke('study_memory', { action: 'save', scope: 'course', scopeId: 'course', kind: 'course_fact', content: '修订事实', source: 'record:segments:1' });
  await manage('segments', 1, await read('segments', 1), null);
  assert.equal(new BotMemory(store).get(owner, fact2.id).status, 'stale');
  await assert.rejects(invoke('study_memory', { action: 'save', scope: 'course', scopeId: 'course', kind: 'course_fact', content: '无来源事实' }));
  await assert.rejects(invoke('study_memory', { action: 'save', kind: 'preference', content: 'cross owner', source: `file:${alien.id}` }));
  const fileFact = await invoke('study_memory', { action: 'save', scope: 'course', scopeId: 'course', kind: 'course_fact', content: '文件事实', source: `file:${file.id}` });
  const memory = new BotMemory(store);
  const serverRevision = memory.save(owner, { scope: 'course', scopeId: 'course', kind: 'course_fact', content: 'version is server-owned', source: 'record:videos:"course"', sourceRevision: 'forged' });
  assert.notEqual(serverRevision.source_revision, 'forged');
  store.db.prepare('DELETE FROM files WHERE id=?').run(file.id);
  assert.equal(memory.get(owner, fileFact.id).status, 'stale');
  const preference = await invoke('study_memory', { action: 'save', kind: 'preference', content: '简洁回答' });
  store.db.prepare('UPDATE runs SET trigger_message_id=NULL WHERE id=?').run(run);
  store.db.prepare('DELETE FROM messages WHERE id=?').run(msg.id);
  assert.ok(!memory.context(owner, thread.id).some(m => m.id === preference.id));
  assert.equal(memory.get(owner, preference.id).status, 'stale');
  for (const [table, row] of Object.entries(valid).filter(([t]) => !['segments', 'files', 'courseFiles', 'handouts', 'folders'].includes(t))) await manage(table, row.id ?? row.date, await read(table, row.id ?? row.date), null);

  fs.mkdirSync(path.join(root, 'host', 'references'), { recursive: true });
  fs.writeFileSync(path.join(root, 'host', 'references', 'probe.md'), 'host-file-boundary-probe');
  records.apply(owner, [{ id: 'evil-skill', table: 'skills', key: 99, before: null, after: { id: 99, name: 'evil', description: 'desc', body: 'body', enabled: 1, updatedAt: 1, builtinPath: path.join(root, 'host') } }]);
  records.apply(owner, [{ id: 'good-ref', table: 'skillRefs', key: 1, before: null, after: { id: 1, skillId: 99, path: 'references/good.md', body: 'synced reference' } }]);
  store.db.prepare("INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,'skills','100',?)").run(owner, '{bad');
  const skills = new BotSkills(store);
  assert.ok(skills.catalog(owner, thread.id).length >= 6, 'malformed one does not break catalog');
  assert.throws(() => skills.load(owner, thread.id, 99, 'references/probe.md'), /not_found/);
  assert.equal(skills.load(owner, thread.id, 99).source, 'synced');
  assert.equal(skills.load(owner, thread.id, 99, 'references/good.md').body, 'synced reference');
  assert.equal(skills.load(owner, thread.id, -4, 'references/writing.md').source, 'builtin');
  fs.symlinkSync(path.join(root, 'host', 'references', 'probe.md'), link);
  assert.throws(() => skills.load(owner, thread.id, -4, 'references/review-probe.md'), /invalid_skill_reference/);
  store.db.prepare("UPDATE threads SET skill_ids='[]' WHERE id=?").run(thread.id);
  assert.equal(skills.catalog(owner, thread.id).length, 0);
  assert.throws(() => skills.load(owner, thread.id, 99, 'references/good.md'), /not_available/);
  console.log('Bot domain: owned tool CRUD, zero-write invalid schemas, optimistic merge, source freshness and skill filesystem isolation passed');
} finally { if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) fs.unlinkSync(link); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
