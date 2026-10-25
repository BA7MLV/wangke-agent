import assert from 'node:assert/strict';
import { Marked } from 'marked';
import { COMPLETE_MARKDOWN, STREAMING_MARKDOWN, protectMath } from '../src/components/markdown/math.ts';

const final = new Marked(COMPLETE_MARKDOWN);
const stream = new Marked(STREAMING_MARKDOWN);
const count = text => (text.match(/<math-formula /g) || []).length;
for (const source of ['$x_i^2$', '\\(x_i^2\\)', '$$\\frac{a}{b}$$', '\\[\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\\]']) {
  assert.equal(count(final.parse(source)), 1, source);
  assert.equal(count(protectMath(source, true)), 1, source);
  for (let end = 1; end < source.length; end++) {
    const partial = protectMath(source.slice(0, end), true);
    assert.ok(!partial.includes('data-pending="false"'), `premature math at ${end}: ${source}`);
  }
}
assert.match(final.parse('$x$'), /data-display="false"/);
assert.match(final.parse('$$x$$'), /data-display="true"/);
for (const source of ['`$x$`', '```tex\n$x$\n```', '~~~\n$x$\n~~~', '    $x$', '\\$20 and \\$30', '$20 and $30', '[link](https://example.com/$x$)']) {
  assert.equal(count(protectMath(source, true)), 0, source);
}
assert.equal(count(protectMath('`code` $x$\n```tex\n$x$\n```\n$y$', true)), 2);
assert.equal(count(final.parse('$x$$')), 0, 'mismatched delimiters');
assert.match(stream.parse('$x_i'), /data-pending="true"/);
assert.doesNotMatch(final.parse('$x_i'), /math-formula/, 'stop flushes unfinished math');
assert.match(protectMath('$$x\n\nNext paragraph', true), /Next paragraph/);
assert.doesNotMatch(protectMath('$<script>alert(1)</script>$', false), /<script>/);
assert.match(final.parse('| a | b |\n|---|---|\n| $x$ | **bold** |'), /<table>/);
const pipeTable = '| 公式 | 说明 |\n|---|---|\n| $|x|$ | 绝对值 |\n| $P(A|B)$ | 条件概率 |\n| $\\|v\\|$ | 范数 |';
for (const streaming of [false, true]) {
  const html = final.parse(protectMath(pipeTable, streaming));
  assert.equal(count(html), 3, 'pipes in TeX must not split table cells');
  assert.equal((html.match(/<td>/g) ?? []).length, 6);
  assert.match(html, /data-source="&#124;x&#124;"/);
  assert.match(html, /data-source="P\(A&#124;B\)"/);
}
console.log('Streaming Markdown: delimiters, every-character prefixes, code, currency, escaping, GFM and final flush passed.');
