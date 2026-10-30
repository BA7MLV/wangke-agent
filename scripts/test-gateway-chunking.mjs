import assert from 'node:assert/strict';
import { splitGatewayMarkdown } from '../apps/api/src/gateway/chunk.ts';

const count = text => Array.from(text).length;

{
  const parts = splitGatewayMarkdown('第一段内容。\n\n第二段内容。\n\n第三段内容。', 12);
  assert.deepEqual(parts, ['第一段内容。', '第二段内容。', '第三段内容。']);
}

{
  const source = `说明文字。\n\n\`\`\`ts\n${'const value = "长代码";\n'.repeat(20)}\`\`\``;
  const parts = splitGatewayMarkdown(source, 80);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => count(part) <= 80), JSON.stringify(parts.map(count)));
  assert.ok(parts.every(part => part.startsWith('说明') || part.startsWith('```ts')));
  assert.ok(parts.every(part => part.includes('```')));
}

{
  const emoji = '👨‍👩‍👧‍👦'.repeat(100);
  const parts = splitGatewayMarkdown(emoji, 25);
  assert.ok(parts.every(part => !part.includes('\u200d') || part.includes('👨‍👩‍👧‍👦')));
  assert.equal(parts.join(''), emoji);
}

{
  const formula = `${'说明 '.repeat(30)}$a+b=c$${' 继续'.repeat(30)}`;
  const parts = splitGatewayMarkdown(formula, 120);
  assert.equal(parts.filter(part => part.includes('$a+b=c$')).length, 1);
}

console.log('gateway chunking tests passed');
