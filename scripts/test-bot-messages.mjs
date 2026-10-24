import test from 'node:test';
import assert from 'node:assert/strict';
import { groupMessages } from '../src/pages/botMessages.ts';

const at = (minutes) => new Date(Date.UTC(2026, 9, 24, 8, 0) + minutes * 60_000).toISOString();
const msg = (id, role, minutes) => ({ id, threadId: 't', clientNonce: id, seq: 0, role, kind: 'text', content: id, replyTo: null, createdAt: at(minutes) });

test('consecutive messages from one sender form a group; only the last has a tail', () => {
  const rows = groupMessages([msg('a', 'user', 0), msg('b', 'user', 1), msg('c', 'assistant', 1)]);
  assert.deepEqual(rows.map((r) => [r.first, r.last]), [[true, false], [false, true], [true, true]]);
});

test('a time stamp appears on the first message and after a 15 minute gap', () => {
  const rows = groupMessages([msg('a', 'user', 0), msg('b', 'user', 5), msg('c', 'user', 30)]);
  assert.ok(rows[0].stamp);
  assert.equal(rows[1].stamp, null);
  assert.ok(rows[2].stamp);
  // A stamp breaks the group even for the same sender.
  assert.equal(rows[1].last, true);
  assert.equal(rows[2].first, true);
});
