import assert from 'node:assert/strict';
import { createContinuationFilter } from '../packages/study-core/src/utils/continuation.ts';

const prefix = '已经写过的第一段内容。\n\n这是一段较长的末尾内容，回答在这里中断';
const rest = '  继续接着写。\n\n';
function join(chunks, source = prefix) {
  const filter = createContinuationFilter(source);
  return chunks.map(chunk => filter.push(chunk)).join('') + filter.flush();
}
for (const raw of [rest, prefix + rest, prefix.slice(-18) + rest]) {
  assert.equal(join([raw]), rest);
  assert.equal(join([...raw]), rest, 'deduplication must be independent of chunk boundaries');
}
assert.equal(join([prefix]), '');
assert.equal(join(['未达到最小匹配']), '未达到最小匹配', 'EOF must flush short unmatched output');
assert.equal(join(['，下一句'], '前一句，'), '，下一句', 'short punctuation overlap is not evidence of replay');
assert.equal(join([prefix.slice(0, 15)]), prefix.slice(0, 15), 'a partial restart without a complete overlap must not lose text');
assert.equal(join(['\n  const x = 1;\n'], '示例代码：\n'), '\n  const x = 1;\n', 'preserve code/newline boundaries');
const filter = createContinuationFilter(prefix);
assert.equal(filter.push(prefix.slice(0, 13)), '', 'do not flash an ambiguous echoed prefix');
assert.equal(filter.push(prefix.slice(13) + rest), rest);
assert.equal(filter.flush(), '');
console.log('Continuation: exact restart/tail dedup, chunk boundaries, ambiguous prefixes and whitespace passed.');
