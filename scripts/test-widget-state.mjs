import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { db } from '../apps/web/src/store/db.ts';
import { normalizeWidgetState, widgetFollowUp } from '../apps/web/src/harness/widgetState.ts';
import { buildWidgetDocument } from '../apps/web/src/harness/widgetRuntime.ts';
import { openWidgetSession, readWidgetState, saveWidgetState } from '../apps/web/src/store/widgetState.ts';
import { persistArtifactEdit } from '../apps/web/src/store/artifactEdit.ts';
import { layoutWidgets, messageWidgets, widgetReference } from '../apps/web/src/harness/widgetLayout.ts';
import { persistAssistantSnapshot } from '../apps/web/src/store/assistantSnapshot.ts';

const state = { modelContent: { a: -2, step: 1 }, privateContent: { panel: 'PRIVATE_UI_ONLY' } };
assert.deepEqual(normalizeWidgetState({ modelContent: 0 }), { modelContent: 0, privateContent: null });
assert.deepEqual(normalizeWidgetState({}), { modelContent: null, privateContent: null });
const copy = normalizeWidgetState(state);
copy.modelContent.a = 7;
assert.equal(state.modelContent.a, -2, 'snapshots are detached');
const cyclic = {}; cyclic.self = cyclic;
for (const invalid of [null, [], 1, { rowId: 1 }, { modelContent: undefined }, { modelContent: NaN },
  { modelContent: Infinity }, { modelContent: new Date() }, { modelContent: () => 1 }, { modelContent: cyclic },
  { privateContent: '中'.repeat(6000) }, { modelContent: Array.from({ length: 10000 }, () => 1) },
  { modelContent: new Array(3) }]) {
  assert.throws(() => normalizeWidgetState(invalid));
}
const overhead = JSON.stringify({ modelContent: '', privateContent: null }).length;
assert.equal(normalizeWidgetState({ modelContent: 'x'.repeat(16384 - overhead) }).modelContent.length, 16384 - overhead);
assert.throws(() => normalizeWidgetState({ modelContent: 'x'.repeat(16385 - overhead) }), /16 KiB/);
let deep = 1;
for (let i = 0; i < 20; i++) deep = { child: deep };
assert.throws(() => normalizeWidgetState({ modelContent: deep }), /嵌套/);
const sent = widgetFollowUp('解释当前情况', state);
assert.ok(sent.includes('"a":-2') && sent.includes('不可信数据'));
assert.ok(!sent.includes('PRIVATE_UI_ONLY') && !sent.includes('privateContent'));
assert.equal(widgetFollowUp('  解释  ', null), '解释');
assert.throws(() => widgetFollowUp('x'.repeat(2001), state));
const injected = '</script><script>window.stolen=1</script>';
const doc = await buildWidgetDocument({ html: '<p>safe</p>' }, { state: { modelContent: injected, privateContent: null }, persistent: true });
assert.ok(!doc.includes(injected), 'saved JSON cannot terminate bootstrap scripts');
assert.ok(doc.includes("connect-src 'none'") && !doc.includes('allow-same-origin'));

const payload = { html: '<p>explore</p>' };
const makeRow = (sessionId) => db.chats.add({ sessionId, videoId: 'widget-test', role: 'assistant', content: 'KEEP_TEXT', reasoning: 'KEEP_REASON', createdAt: 1, widget: payload });
const rowId = await makeRow(1), otherId = await makeRow(2);
const session = await openWidgetSession(rowId, payload);
assert.ok(session.widgetId);
assert.equal((await db.chats.get(rowId)).widget.schemaVersion, 1);
assert.equal((await openWidgetSession(rowId, payload)).widgetId, session.widgetId, 'legacy IDs are stable');
const competing = await Promise.all([openWidgetSession(otherId, payload), openWidgetSession(otherId, payload)]);
assert.equal(competing[0].widgetId, competing[1].widgetId, 'concurrent opens share one host ID');
assert.equal(await readWidgetState(session), null);
await saveWidgetState(session, state);
assert.deepEqual(await readWidgetState(session), state);
assert.equal(await readWidgetState(competing[0]), null, 'same HTML in another session does not share state');
let row = await db.chats.get(rowId);
assert.equal(row.content, 'KEEP_TEXT'); assert.equal(row.reasoning, 'KEEP_REASON');
await assert.rejects(saveWidgetState(session, { modelContent: state.modelContent, rowId: otherId }));
assert.deepEqual(await readWidgetState(session), state, 'invalid updates preserve old state');
await assert.rejects(saveWidgetState({ ...session, sessionId: 999 }, state), /修改或删除/);

row = await persistArtifactEdit({ rowId, kind: 'html', location: 'widget', source: payload.html, next: '<p>changed</p>', expectedContent: 'KEEP_TEXT' });
assert.notEqual(row.widget.id, session.widgetId);
assert.equal(row.widget.revision, 2);
assert.equal(row.widgetState, undefined);
await assert.rejects(saveWidgetState(session, state), /修改或删除/);
const updated = await openWidgetSession(rowId, row.widget);
assert.equal(await readWidgetState(updated), null, 'source edits start from defaults');
await db.chats.delete(rowId);
await assert.rejects(saveWidgetState(updated, state), /修改或删除/);
assert.equal(await db.chats.get(rowId), undefined, 'stale state writes cannot resurrect deleted messages');

const first = { id: 'first', ref: 'first-ref', html: '<p>same source</p>' };
const second = { id: 'second', ref: 'second-ref', html: first.html };
const both = [first, second];
assert.deepEqual(messageWidgets({ widget: second, widgets: both }), both, 'legacy alias does not duplicate a visual');
assert.deepEqual(messageWidgets({ widget: payload }), [payload]);
const inline = `Before\n\n${widgetReference(first.ref)}\n\nBetween\n\n${widgetReference(second.ref)}\n\nAfter`;
assert.deepEqual(layoutWidgets(inline, both).unplaced, []);
assert.deepEqual(layoutWidgets(widgetReference(second.ref), both).unplaced, [first]);
assert.deepEqual(layoutWidgets('````text\n' + widgetReference(first.ref) + '\n````', both).unplaced, both, 'code examples are not live references');
assert.deepEqual(layoutWidgets(widgetReference('other-message'), both).unplaced, both, 'unknown refs cannot read other messages');
assert.equal(layoutWidgets(`${inline}\n\n${widgetReference(first.ref)}`, both).markdown.split(first.ref).length, 2, 'duplicate references render only once');
const multiId = await db.chats.add({ sessionId: 3, videoId: 'multi', role: 'assistant', content: inline, widgets: both, widget: second, createdAt: 1 });
const firstSession = await openWidgetSession(multiId, first), secondSession = await openWidgetSession(multiId, second);
await Promise.all([saveWidgetState(firstSession, { modelContent: { a: 1 } }), saveWidgetState(secondSession, { modelContent: { a: 2 } })]);
assert.equal((await readWidgetState(firstSession)).modelContent.a, 1);
assert.equal((await readWidgetState(secondSession)).modelContent.a, 2, 'parallel saves do not overwrite sibling state');
row = await persistArtifactEdit({ rowId: multiId, kind: 'html', location: 'widget', widgetId: first.id, source: first.html, next: '<p>edited first</p>', expectedContent: inline });
assert.equal(row.widgets[0].ref, first.ref, 'editing preserves Markdown placement');
assert.notEqual(row.widgets[0].id, first.id, 'editing invalidates only this revision');
assert.equal(row.widgets[1].id, second.id);
assert.equal(row.content, inline);
assert.equal(row.widget.id, second.id, 'last-item alias remains the last item');
await assert.rejects(saveWidgetState(firstSession, state), /修改或删除/);
assert.equal((await readWidgetState(secondSession)).modelContent.a, 2, 'editing a sibling preserves its snapshot');
assert.equal(await readWidgetState(await openWidgetSession(multiId, row.widgets[0])), null);
const delivery = { sessionId: 77, videoId: 'snapshot', role: 'assistant', createdAt: 1,
  content: widgetReference('saved'), widgets: [{ id: 'saved', ref: 'saved', html: '<p>static work</p>', kind: 'html', schemaVersion: 1, revision: 1, source: 'tool' }],
  interrupted: true, interruptReason: '后续回答尚未完成' };
const deliveryId = await persistAssistantSnapshot(delivery);
assert.equal((await db.chats.get(deliveryId)).widgets.length, 1, 'complete work survives before final text');
await db.chats.update(deliveryId, { widgetStates: { saved: state } });
await persistAssistantSnapshot({ ...delivery, interrupted: undefined, interruptReason: undefined, content: `${delivery.content}\n完成` }, deliveryId);
assert.equal(await db.chats.where('sessionId').equals(77).count(), 1, 'finalization updates rather than duplicates');
assert.equal((await db.chats.get(deliveryId)).interrupted, undefined);
assert.deepEqual((await db.chats.get(deliveryId)).widgetStates.saved, state, 'finalization preserves concurrently saved runtime state');
await assert.rejects(persistAssistantSnapshot({ ...delivery, widgets: [{ html: '<p>bad version</p>', schemaVersion: 2 }] }), /协议版本/);
await db.chats.delete(deliveryId);
await assert.rejects(persistAssistantSnapshot(delivery, deliveryId), /已删除/);
assert.equal(await db.chats.get(deliveryId), undefined, 'late completion never resurrects deleted messages');
await db.delete();
console.log('Widget state/layout: JSON/byte limits, private isolation, safe bootstrap, scoped inline references, concurrent sibling saves, targeted edits and deletion passed.');
