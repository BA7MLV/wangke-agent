import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { db } = await server.ssrLoadModule('/src/store/db.ts');
  const { createResourceExecutor, parseResource } = await server.ssrLoadModule('/src/harness/resources.ts');
  const { handoutFileOf } = await server.ssrLoadModule('/src/materials/handoutFile.ts');
  const { saveMarkdownMaterial } = await server.ssrLoadModule('/src/materials/markdownFile.ts');
  const { getMaterialFile } = await server.ssrLoadModule('/src/store/fileStore.ts');
  const folderId = await db.folders.add({ name: '课程目录', createdAt: 1 });
  const source = { id: 'source', name: '测试课程.mp4', folderId, createdAt: 1, duration: 60 };
  await db.videos.bulkAdd([source, { ...source, id: 'other', folderId: undefined }]);
  const local = createResourceExecutor({ courseId: source.id });
  const library = createResourceExecutor();
  const file = handoutFileOf(source);
  const path = '/courses/current/handout.md';
  assert.equal(parseResource(path).leaf, 'handout.md');
  assert.match(await local('read', { path }), /文件不存在/);
  assert.equal(await db.videos.count(), 2, 'read never creates files');
  assert.match(await local('edit', { path, create: true }), /需提供 content/);
  assert.equal(await db.files.count(), 0);
  assert.match(await local('read', { path: '/courses/current/info' }), /\/courses\/source\/handout.md/);
  const first = '# 测试课程讲义\n\n覆盖：00:00–01:00\n\n## 核心要点\n\n- 定义须结合适用条件。[00:00]\n\n## 内容大纲\n\n- 定义\n\n## 定义\n\n原始定义。\n\n![课程画面 0:25](#source-image/source/frame-25125)\n';
  const created = await local('edit', { path, create: true, content: first });
  assert.match(created, /已创建/);
  assert.match(created, /唯一真相源/);
  assert.ok(created.includes(`](#/player/${file.id})`));
  const row = await db.videos.get(file.id);
  assert.equal(row.name, '测试课程 · 讲义.md');
  assert.equal(row.materialFormat, 'md');
  assert.equal(row.folderId, folderId, 'created beside source, not at library root');
  assert.equal(await (await getMaterialFile(file.id)).text(), first);
  const saved = await local('read', { path });
  assert.match(saved, /## 核心要点/);
  assert.match(saved, /## 内容大纲/);
  assert.match(saved, /!\[课程画面 0:25\]\(#source-image\/source\/frame-25125\)/, 'inline images live in the saved file, not only in chat');
  assert.equal(await db.handouts.count(), 0, 'no duplicate handout-specific body');
  assert.match(await library('read', { path: `/courses/${file.id}/material`, raw: true }), /原始定义/);
  assert.match(await library('grep', { path: file.path, query: '^## 定义$', regex: true }), /## 定义/);
  assert.match(await local('edit', { path, create: true, content: '不可覆盖' }), /已存在/);
  assert.equal(await (await getMaterialFile(file.id)).text(), first);

  // A user's manual edit supersedes chat snapshots; subsequent agent edits use that same file.
  const manual = first.replace('原始定义', '用户修订定义') + '\n我的笔记：保留这个例子。\n';
  await saveMarkdownMaterial(file.id, manual, first);
  assert.match(await local('read', { path }), /用户修订定义/);
  assert.doesNotMatch(await local('read', { path }), /原始定义/);
  assert.match(await local('edit', { path, edits: [{ old_string: '原始定义。', new_string: '来自旧会话的覆盖' }] }), /未命中/);
  assert.equal(await (await getMaterialFile(file.id)).text(), manual);
  assert.match(await local('edit', { path, edits: [{ old_string: '用户修订定义。', new_string: '用户修订定义。\n\n## 应用\n\n补充例题。' }] }), /已修改/);
  const updated = await (await getMaterialFile(file.id)).text();
  assert.ok(updated.includes('我的笔记：保留这个例子。'));
  assert.ok(updated.includes('补充例题。'));
  const blocks = await db.materialBlocks.where('materialId').equals(file.id).toArray();
  assert.ok(blocks.some((b) => b.text.includes('补充例题')));
  await assert.rejects(saveMarkdownMaterial(file.id, '旧版整篇覆盖', manual), /已在其他页面更新/);
  assert.equal(await (await getMaterialFile(file.id)).text(), updated);
  assert.equal((await db.videos.get(source.id)).kind, undefined, 'source is not overwritten');

  // Stable identity does not rely on names or change when a user renames/moves the file.
  await db.videos.update(file.id, { name: '我的正式讲义.md', folderId: undefined });
  assert.match(await local('read', { path }), /我的正式讲义.md/);
  assert.match(await local('edit', { path, edits: [{ old_string: '补充例题。', new_string: '补充例题与答案。' }] }), /已修改/);
  assert.equal((await db.videos.get(file.id)).folderId, undefined, 'edits preserve deliberate moves');
  assert.match(await library('edit', { path: '/courses/other/handout.md', create: true, content: '# 另一份' }), /已创建/);
  assert.notEqual(handoutFileOf({ ...source, id: 'other' }).id, file.id, 'same-name courses do not share a file');
  assert.equal((await db.videos.get(handoutFileOf({ ...source, id: 'other' }).id)).folderId, undefined);
  assert.match(await local('edit', { path: '/courses/other/handout.md', create: true, content: '越界' }), /只能访问当前课程/);
  assert.match(await library('edit', { path: '/courses/missing/handout.md', create: true, content: '猜的课程' }), /课程不存在/);

  // A create-only check inside the transaction prevents two concurrent creations from winning.
  const racing = await Promise.allSettled(['甲', '乙'].map((text) => saveMarkdownMaterial('race.md', text, '', '并发.md', { createOnly: true })));
  assert.equal(racing.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(racing.find((r) => r.status === 'rejected').reason.message, /已存在/);
  await db.delete();
  console.log('PASS: ordinary Markdown handout creation, folder placement, stable identity, source-of-truth reads, user edits, reindex, scope and atomic conflict protection');
} finally {
  await server.close();
}
