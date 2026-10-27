import test from 'node:test';
import assert from 'node:assert/strict';
import { groupMessages, formatListTime } from '../src/pages/botMessages.ts';

const at = (minutes) => new Date(Date.UTC(2026, 9, 24, 8, 0) + minutes * 60_000).toISOString();
const msg = (id, role, minutes) => ({ id, threadId: 't', clientNonce: id, seq: 0, role, kind: 'text', content: id, replyTo: null, createdAt: at(minutes) });

test('consecutive messages from one sender form a group; only the last has a tail', () => {
  const rows = groupMessages([msg('a', 'user', 0), msg('b', 'user', 1), msg('c', 'assistant', 1)]);
  assert.deepEqual(rows.map((r) => [r.first, r.last]), [[true, false], [false, true], [true, true]]);
});

test('a date pill appears on the first message and when the day changes, not for a gap within a day', () => {
  const rows = groupMessages([msg('a', 'user', 0), msg('b', 'user', 30), msg('c', 'user', 24 * 60)]);
  assert.ok(rows[0].stamp);
  assert.equal(rows[1].stamp, null);
  assert.ok(rows[2].stamp);
  // A 30 minute gap still breaks the group, and a new day always does.
  assert.equal(rows[0].last, true);
  assert.equal(rows[2].first, true);
  assert.ok(rows.every((r) => /\d{2}:\d{2}/.test(r.time)));
});

test('user messages read as sending, delivered, then read once the agent answers or is working', () => {
  const pending = { ...msg('pending-x', 'user', 3) };
  let rows = groupMessages([msg('a', 'user', 0), msg('b', 'assistant', 1), msg('c', 'user', 2), pending]);
  assert.deepEqual(rows.map((r) => r.status), ['read', undefined, 'sent', 'sending']);
  assert.equal(rows.findIndex((r) => r.lastMine), 3);
  rows = groupMessages([msg('a', 'user', 0)], 'zh-CN', { running: true });
  assert.equal(rows[0].status, 'read');
});

test('list times read like Messages: time today, "yesterday", weekday, then a date', () => {
  const now = new Date(2026, 9, 27, 12, 0);
  const ago = (hours) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  assert.match(formatListTime(ago(1), 'zh-CN', now), /11:00/);
  assert.equal(formatListTime(ago(24), 'zh-CN', now), '昨天');
  assert.equal(formatListTime(ago(24), 'en-US', now), 'yesterday');
  assert.equal(formatListTime(ago(72), 'zh-CN', now), '星期六');
  assert.equal(formatListTime('not a date', 'zh-CN', now), '');
});

test('legacy model failure notices are hidden before grouping', () => {
  const notice = { ...msg('error', 'assistant', 1), kind: 'progress', content: '模型暂时不可用，请稍后重试。' };
  const rows = groupMessages([msg('a', 'user', 0), notice, msg('b', 'user', 1)]);
  assert.deepEqual(rows.map((r) => r.key), ['a', 'b']);
  assert.deepEqual(rows.map((r) => [r.first, r.last]), [[true, false], [false, true]]);
  assert.deepEqual(groupMessages([notice]), []);
});

test('ordinary progress and user-authored failure text remain visible', () => {
  const progress = { ...msg('progress', 'assistant', 0), kind: 'progress', content: '正在整理资料' };
  const user = { ...msg('user', 'user', 1), content: '模型暂时不可用，请稍后重试。' };
  assert.deepEqual(groupMessages([progress, user]).map((r) => r.key), ['progress', 'user']);
});
