import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { db } from '../src/store/db.ts';
import { persistArtifactEdit } from '../src/store/artifactEdit.ts';
import { applyArtifactReply, artifactFences, parseArtifactReply, replaceArtifactFence } from '../src/utils/artifactEdit.ts';

const old = '{"type":"plot","curves":[{"fn":"x^2"}]}';
const next = '{"type":"plot","curves":[{"fn":"sin(x)"}]}';
const content = `原正文不应变化\n\n\`\`\`diagram title="函数"\n${old}\n\`\`\`\n\n第二张图\n~~~svg\n<svg></svg>\n~~~\n尾部`;
const patched = replaceArtifactFence(content, 'diagram', old, next);
assert.equal(patched, content.replace(old, next));
assert.equal(artifactFences(content).length, 2);
assert.equal(replaceArtifactFence('````diagram\r\n' + old + '\r\n````\r\n', 'diagram', old, next), '````diagram\r\n' + next + '\n````\r\n');
assert.throws(() => replaceArtifactFence(content + '\n```diagram\n' + old + '\n```', 'diagram', old, next), /唯一/);
assert.throws(() => replaceArtifactFence(content, 'diagram', old, next + '\n```\n污染正文'), /结束标记/);
assert.throws(() => replaceArtifactFence('```json\n```diagram\n' + old + '\n```\n```', 'diagram', old, next), /唯一/);

const reply = parseArtifactReply('```json\n{"edits":[{"search":"x^2","replace":"sin(x)"}]}\n```');
assert.throws(() => parseArtifactReply('   '), /未返回修改内容/);
assert.throws(() => parseArtifactReply('{"edits":['), /JSON 不完整或格式不正确/);
assert.throws(() => parseArtifactReply('```json\n{"edits":['), /JSON 不完整或格式不正确/);
assert.equal(applyArtifactReply(old, reply, 'patch'), next);
assert.equal(applyArtifactReply('abc def', { edits: [{ search: 'def', replace: 'abc' }, { search: 'abc', replace: 'xyz' }] }, 'patch'), 'xyz abc', 'all edits use the original source');
assert.equal(applyArtifactReply(old, { source: next }, 'rewrite'), next);
for (const edits of [[], [{ search: '', replace: 'a' }], [{ search: 'missing', replace: 'a' }], [{ search: 'a', replace: 'b' }], [{ search: 'abc', replace: 'x' }, { search: 'bc', replace: 'z' }]]) {
  assert.throws(() => applyArtifactReply('abc abc', { edits }, 'patch'));
}
assert.throws(() => applyArtifactReply('abc', { edits: [{ search: 'abc', replace: '' }] }, 'patch'), /为空/);
assert.throws(() => applyArtifactReply('abc', { source: 'abc' }, 'rewrite'), /没有修改/);
assert.throws(() => applyArtifactReply('abc', { source: 'x'.repeat(120001) }, 'rewrite'), /大小限制/);

const rowId = await db.chats.add({ videoId: 'artifact-test', sessionId: 17, role: 'assistant', createdAt: 1, content, reasoning: '保留思考', widget: { html: '<div>old</div>', libs: ['chart.js'] } });
const save = (extra = {}) => persistArtifactEdit({ rowId, kind: 'diagram', location: 'fence', source: old, next, ...extra });
const updated = await save();
assert.equal(updated.content, patched);
assert.equal(updated.reasoning, '保留思考');
await assert.rejects(save(), /已变化|唯一定位/);
const undone = await save({ source: next, next: old });
assert.equal(undone.content, content, 'undo restores only the selected fence');
await db.chats.update(rowId, { content: content.replace('<svg></svg>', '<svg><path /></svg>') });
const concurrent = await save();
assert.equal(concurrent.content, patched.replace('<svg></svg>', '<svg><path /></svg>'), 'unrelated figure changes are rebased, not overwritten or blocked');
await db.chats.update(rowId, { content });
const widget = await save({ kind: 'html', location: 'widget', source: '<div>old</div>', next: '<div>new</div>' });
assert.deepEqual(widget.widget, { html: '<div>new</div>', libs: ['chart.js'] });
assert.equal(widget.content, content, 'widget changes must not touch answer text');
await assert.rejects(save({ kind: 'html', location: 'widget', source: '<div>old</div>', next: '<div>race</div>' }), /已变化/);

await db.chats.update(rowId, { content: '```html\n<p>old</p>\n```' });
const html = await save({ kind: 'html', location: 'html', source: '<p>old</p>', next: '<p>new</p>' });
assert.equal(html.content, '```html\n<p>new</p>\n```');
await db.chats.update(rowId, { content: '<p>old</p>' });
assert.equal((await save({ kind: 'html', location: 'html', source: '<p>old</p>', next: '<p>new</p>' })).content, '<p>new</p>');
await db.chats.update(rowId, { interrupted: true });
await assert.rejects(save(), /先完成/);
await db.chats.delete(rowId);
await assert.rejects(save(), /已被删除/);
await db.delete();
console.log('Artifact editing: exact patches, fence isolation, conflicts, persistence, HTML libraries and undo passed.');
