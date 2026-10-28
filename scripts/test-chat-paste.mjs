// npx tsx --test scripts/test-chat-paste.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pastedTextAttachment } from '../apps/web/src/chat/paste.ts';

test('empty and short text stay in the composer', () => {
  for (const text of ['', 'hello', '中文🙂', 'a'.repeat(3999)]) {
    assert.equal(pastedTextAttachment(text), null);
  }
});

test('exactly 4000 UTF-8 bytes do not become an attachment', () => {
  for (const text of ['a'.repeat(4000), '中'.repeat(1333) + 'a', '🙂'.repeat(1000)]) {
    assert.equal(Buffer.byteLength(text), 4000);
    assert.equal(pastedTextAttachment(text), null);
  }
});

for (const [name, text] of [
  ['ASCII', 'a'.repeat(4001)],
  ['Chinese', '中'.repeat(1334)],
  ['emoji', '🙂'.repeat(1001)],
  ['mixed text', '  notes\r\n' + '中🙂abc\n'.repeat(500) + '\n  '],
]) {
  test(`${name}: over 4000 bytes becomes a complete UTF-8 txt file`, async () => {
    const file = pastedTextAttachment(text);
    assert.ok(file instanceof File);
    assert.match(file.name, /^粘贴内容-\d+\.txt$/);
    assert.equal(file.type, 'text/plain;charset=utf-8');
    assert.equal(file.size, Buffer.byteLength(text));
    assert.equal(await file.text(), text);
  });
}

test('large pastes are not truncated in the original attachment', async () => {
  const text = '完整正文\n'.repeat(10_000);
  assert.equal(await pastedTextAttachment(text).text(), text);
});
