#!/usr/bin/env node
/**
 * 迁移包核心逻辑断言：在 Node 下用 fake-indexeddb 驱动真实 Dexie，
 * 验证 导出→导入 的往返一致性与冲突跳过策略。
 *
 * 运行（migration.ts 依赖链含 zustand，Node 原生 TS 无法解析无扩展名
 * 导入，故先用 esbuild 打包再执行；脚本会自检并自动完成这两步）：
 *   node scripts/test-migration.mjs
 */
import assert from 'node:assert/strict';

// Node 缺浏览器 API：fake-indexeddb 提供 IDB；Blob/atob/btoa Node 20+ 均有
const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const { db } = await import('../src/store/db.ts');
const { exportMigrationZip, importMigrationZip, previewMigrationZip } = await import(
  '../src/store/migration.ts'
);
const { unzipSync, strFromU8 } = await import('fflate');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL - ${name}\n    ${e.message}`);
  }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 255]);
const VID_A = 'video-aaa';
const VID_B = 'video-bbb';

// ---------- 源库造数据 ----------
await db.delete();
await db.open();

await db.folders.add({ name: '行测', createdAt: 1 });
const folderId = (await db.folders.toArray())[0].id;

await db.videos.add({
  id: VID_A, name: '资料分析 第1讲.mp4', size: 123, mimeType: 'video/mp4',
  duration: 3600, createdAt: 10, status: 'transcribed', lastPosition: 120, folderId,
});
await db.videos.add({
  id: VID_B, name: '数量关系 第2讲.mp4', size: 456, mimeType: 'video/mp4',
  duration: 7200, createdAt: 20, status: 'transcribed',
});
await db.segments.bulkAdd([
  { videoId: VID_A, idx: 0, start: 0, end: 5, text: '大家好', status: 1, cues: [{ start: 0, end: 2, text: '大家' }, { start: 2, end: 5, text: '好' }] },
  { videoId: VID_A, idx: 1, start: 5, end: 10, text: '今天讲增长率', status: 1 },
  { videoId: VID_B, idx: 0, start: 0, end: 3, text: 'B 课字幕', status: 1 },
]);
await db.frames.add({
  videoId: VID_A, ts: 30, kind: 'slide', caption: '公式页',
  blob: new Blob([PNG], { type: 'image/png' }),
});
await db.handouts.add({
  videoId: VID_A, createdAt: 30, title: '资料分析讲义', outlineJson: '[]', sectionsJson: '[]',
  blob: new Blob([new Uint8Array([80, 75, 3, 4, 9, 9, 9])], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
});
const sidA = await db.chatSessions.add({ videoId: VID_A, title: '增长率讨论', createdAt: 40 });
await db.chats.bulkAdd([
  { videoId: VID_A, sessionId: sidA, role: 'user', content: '间隔增长率公式？', createdAt: 41 },
  { videoId: VID_A, sessionId: sidA, role: 'assistant', content: 'r = r1 + r2 + r1×r2', createdAt: 42, reasoning: '检索到 05:30', quiz: { data: { q: 'x' }, picks: [-1] } },
]);
await db.danmakus.add({ videoId: VID_A, time: 330, text: '为什么基期量要除 1+r？' });
await db.cards.add({ videoId: VID_A, q: '间隔增长率', a: 'r1+r2+r1r2', time: 330, status: 1, createdAt: 50 });
await db.skills.add({ name: '我的自定义技能', description: 'd', body: '正文', enabled: 1, builtin: 0, updatedAt: 60 });
const skillId = (await db.skills.toArray())[0].id;
await db.skillRefs.add({ skillId, path: 'references/notes.md', body: '参考内容' });

// ---------- 导出 ----------
const zipBlob = await exportMigrationZip();
const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());

await test('zip 含 manifest/db/settings 三件', () => {
  const files = unzipSync(zipBytes);
  assert.ok(files['manifest.json']);
  assert.ok(files['db.json']);
  assert.ok(files['settings.json']);
  const m = JSON.parse(strFromU8(files['manifest.json']));
  assert.equal(m.format, 1);
  assert.equal(m.counts.videos, 2);
  assert.equal(m.counts.segments, 3);
  assert.equal(m.counts.frames, 1);
});

await test('settings.json 不含 apiKey', () => {
  const files = unzipSync(zipBytes);
  const s = JSON.parse(strFromU8(files['settings.json']));
  assert.equal(s.apiKey, undefined);
  assert.ok(s.llmModel);
});

// ---------- 目标库（全新）导入 ----------
await db.delete();
await db.open();

const preview = await previewMigrationZip(new Blob([zipBytes]));
assert.equal(preview.existingVideos, 0);
assert.equal(preview.currentVideos, 0);

const r1 = await importMigrationZip(new Blob([zipBytes]), { restoreSettings: true });

await test('全新导入：2 视频迁入且标记 fileDeleted、清播放进度', async () => {
  assert.equal(r1.videosAdded, 2);
  assert.equal(r1.videosSkipped, 0);
  const a = await db.videos.get(VID_A);
  assert.equal(a.fileDeleted, 1);
  assert.equal(a.lastPosition, undefined);
  assert.equal(a.status, 'transcribed'); // 元数据保留
});

await test('全新导入：字幕/弹幕/卡片跟随新视频', async () => {
  assert.equal(await db.segments.where('videoId').equals(VID_A).count(), 2);
  assert.equal(await db.segments.where('videoId').equals(VID_B).count(), 1);
  assert.equal(await db.danmakus.count(), 1);
  assert.equal(await db.cards.count(), 1);
  // 自增主键重排后 videoId 关联不变
  const seg = await db.segments.where('videoId').equals(VID_A).first();
  assert.equal(seg.text, '大家好');
  assert.deepEqual(seg.cues.length, 2); // 嵌套对象保留
});

await test('全新导入：帧 Blob 字节级一致', async () => {
  const f = await db.frames.where('videoId').equals(VID_A).first();
  assert.equal(f.blob.type, 'image/png');
  const buf = new Uint8Array(await f.blob.arrayBuffer());
  assert.deepEqual([...buf], [...PNG]);
});

await test('全新导入：讲义 docx Blob 一致、IR 字段保留', async () => {
  const h = await db.handouts.where('videoId').equals(VID_A).first();
  assert.equal(h.title, '资料分析讲义');
  assert.equal(h.sectionsJson, '[]');
  const buf = new Uint8Array(await h.blob.arrayBuffer());
  assert.deepEqual([...buf.slice(0, 4)], [80, 75, 3, 4]);
});

await test('全新导入：chat 的 sessionId 已重挂到新会话', async () => {
  const sessions = await db.chatSessions.where('videoId').equals(VID_A).toArray();
  assert.equal(sessions.length, 1);
  const newSid = sessions[0].id;
  const chats = await db.chats.where('videoId').equals(VID_A).toArray();
  assert.equal(chats.length, 2);
  for (const c of chats) assert.equal(c.sessionId, newSid);
  const assistant = chats.find((c) => c.role === 'assistant');
  assert.equal(assistant.reasoning, '检索到 05:30');
  assert.deepEqual(assistant.quiz.picks, [-1]); // 嵌套 quiz 状态保留
});

await test('全新导入：folder 重挂、skill+ref 重挂', async () => {
  const a = await db.videos.get(VID_A);
  const folders = await db.folders.toArray();
  assert.equal(folders.length, 1);
  assert.equal(a.folderId, folders[0].id); // 新库 folder 自增 id 已映射
  const skills = await db.skills.toArray();
  assert.equal(skills.length, 1);
  const refs = await db.skillRefs.toArray();
  assert.equal(refs.length, 1);
  assert.equal(refs[0].skillId, skills[0].id);
  assert.equal(refs[0].body, '参考内容');
});

// ---------- 冲突场景：同包二次导入应全部跳过 ----------
const r2 = await importMigrationZip(new Blob([zipBytes]), { restoreSettings: false });
await test('二次导入：视频全部跳过，无重复写入', async () => {
  assert.equal(r2.videosAdded, 0);
  assert.equal(r2.videosSkipped, 2);
  assert.equal(await db.segments.count(), 3);
  assert.equal(await db.chats.count(), 2);
  assert.equal(await db.folders.count(), 1); // 同名 folder 合并
  assert.equal(await db.skills.count(), 1); // 同名 skill 跳过
});

// ---------- 部分冲突：本机已有 VID_A，只迁 VID_B ----------
await db.delete();
await db.open();
await db.videos.add({
  id: VID_A, name: '本机的资料分析.mp4', size: 999, mimeType: 'video/mp4',
  duration: 3600, createdAt: 5, status: 'transcribed',
});
await db.segments.add({ videoId: VID_A, idx: 0, start: 0, end: 1, text: '本机字幕', status: 1 });

const preview2 = await previewMigrationZip(new Blob([zipBytes]));
const r3 = await importMigrationZip(new Blob([zipBytes]), { restoreSettings: false });
await test('部分冲突：已有视频整条跳过（含子表），新视频正常迁入', async () => {
  assert.equal(preview2.existingVideos, 1);
  assert.equal(r3.videosAdded, 1);
  assert.equal(r3.videosSkipped, 1);
  const a = await db.videos.get(VID_A);
  assert.equal(a.name, '本机的资料分析.mp4'); // 本机数据未被覆盖
  assert.equal(a.fileDeleted, undefined);
  assert.equal(await db.segments.where('videoId').equals(VID_A).count(), 1); // 本机字幕保留
  assert.equal(await db.segments.where('videoId').equals(VID_B).count(), 1); // B 字幕迁入
  assert.equal(await db.frames.count(), 0); // A 被跳过 → A 的帧不导入
  const b = await db.videos.get(VID_B);
  assert.equal(b.fileDeleted, 1);
});

// ---------- 坏文件 ----------
await test('非 zip 文件报明确错误', async () => {
  await assert.rejects(
    () => previewMigrationZip(new Blob([new Uint8Array([1, 2, 3])])),
    /zip/,
  );
});
await test('缺 manifest 的 zip 报明确错误', async () => {
  const { zipSync, strToU8 } = await import('fflate');
  const bad = zipSync({ 'foo.txt': strToU8('hello') });
  await assert.rejects(
    () => previewMigrationZip(new Blob([bad])),
    /迁移包/,
  );
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
