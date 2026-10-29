import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBotAttachments, parseLegacyBotAttachments, MAX_BOT_ATTACHMENTS } from '../packages/contracts/src/bot-attachments.ts';

const file = { fileId: '18468d54-6475-45b3-90f3-da74adfcf799', originalName: 'image.jpg', mimeType: 'image/jpeg', sizeBytes: 123 };
test('single and batched attachments retain caption and all files', () => {
  assert.deepEqual(parseBotAttachments(JSON.stringify(file)), { files: [file], text: '' });
  const files = [file, { projectId: 'project', projectPath: 'notes.md' }];
  assert.deepEqual(parseBotAttachments(JSON.stringify({ attachments: files, caption: '解释这些附件' })), { files, text: '解释这些附件' });
});
test('invalid envelopes and unsafe metadata fail closed', () => {
  for (const value of [null, [], 'plain text', {}, { attachments: [] }, { attachments: Array(MAX_BOT_ATTACHMENTS + 1).fill(file) },
    { ...file, name: {} }, { ...file, mimeType: [] }, { ...file, sizeBytes: -1 }, { attachments: [file, { fileId: '' }] }]) {
    assert.equal(parseBotAttachments(JSON.stringify(value)), null);
  }
  assert.equal(parseBotAttachments('not json'), null);
});
test('historical gateway text becomes images without losing accompanying prose', () => {
  const line = `Attachment fileId=${file.fileId}, name=image, example.jpg, mime=image/jpeg. Use study_file to read/understand it.`;
  assert.deepEqual(parseLegacyBotAttachments(`请看图\n${line}\n${line}`), {
    text: '请看图', files: Array(2).fill({ fileId: file.fileId, originalName: 'image, example.jpg', mimeType: 'image/jpeg' }),
  });
  assert.equal(parseLegacyBotAttachments(`引用：${line}`), null);
  assert.equal(parseLegacyBotAttachments('Attachment fileId=https://evil.invalid/a, name=x.jpg, mime=image/jpeg. Use study_file to read/understand it.'), null);
});
