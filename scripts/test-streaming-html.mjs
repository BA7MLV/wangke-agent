import assert from 'node:assert/strict';
import { readPartialWidgetArguments, splitStreamingHtml } from '../src/utils/streamingHtml.ts';

const source = '<section><h2>收入</h2><p>同比增长 <strong>12%</strong></p></section><div>尾部';
const split = splitStreamingHtml(source);
assert.equal(source.slice(0, split.stableEnd), '<section><h2>收入</h2><p>同比增长 <strong>12%</strong></p></section>');
assert.equal(split.live, '<div>尾部');

assert.equal(splitStreamingHtml('<div class="card').stableEnd, 0, 'half tag must stay live');
assert.equal(splitStreamingHtml('<div>2 < 3</div>').live, '', 'less-than in text is not a tag');
assert.equal(splitStreamingHtml('<div><script>alert(1)').stableEnd, 0, 'open dangerous tag must not freeze');

const partial = readPartialWidgetArguments(
  '{"format":"html","code":"<div>第一行\\n<button title=\\"safe\\">继续',
);
assert.equal(partial.format, 'html');
assert.equal(partial.code, '<div>第一行\n<button title="safe">继续');

const incompleteEscape = readPartialWidgetArguments('{"format":"html","code":"<p>\\u4e');
assert.equal(incompleteEscape.code, '<p>');

console.log('Streaming HTML: conservative boundaries and partial JSON decoding passed.');
