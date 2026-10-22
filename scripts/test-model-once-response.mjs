import assert from 'node:assert/strict';
import { chatOnce, textOf } from '../src/api/modelClient.ts';

const target = { baseUrl: 'https://models.test/v1', apiKey: 'test', model: 'test', protocol: 'openai-chat' };
const options = { messages: [{ role: 'user', content: 'edit' }] };
const run = (body) => chatOnce(target, options, async () => new Response(body));
for (const reason of ['stop', 'length', 'content_filter', 'tool_calls']) {
  const message = await run(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reason === 'length' ? '{"edits":[' : null }, finish_reason: reason }] }));
  assert.equal(message.finish_reason, reason, 'preserve completion metadata for artifact truncation checks');
  if (reason === 'length') assert.equal(textOf(message), '{"edits":[');
}
await assert.rejects(run(''), /返回为空/);
await assert.rejects(run('{"choices":['), /不完整或不是有效 JSON/);
await assert.rejects(run('null'), /未返回有效消息/);
await assert.rejects(run('{"choices":[]}'), /未返回有效消息/);
console.log('Non-streaming response metadata and invalid response handling passed.');
