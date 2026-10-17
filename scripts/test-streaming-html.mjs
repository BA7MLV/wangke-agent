import assert from 'node:assert/strict';
import { htmlPreviewSource, looksLikeStreamingHtml, readPartialWidgetArguments, splitStreamingHtml } from '../src/utils/streamingHtml.ts';

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

assert.equal(looksLikeStreamingHtml('<div><h1>标题</h1>'), true, 'raw HTML answer must use the HTML renderer');
assert.equal(looksLikeStreamingHtml('<!doctype html><html><body>内容'), true, 'document HTML must use the HTML renderer');
assert.equal(looksLikeStreamingHtml('<div class="card'), true, 'an incomplete root tag must be detected while streaming');
assert.equal(looksLikeStreamingHtml('2 < 3'), false, 'ordinary prose must remain Markdown');
assert.equal(looksLikeStreamingHtml('```html\n<div>源码</div>\n```'), true, 'fenced HTML must use the HTML renderer');
assert.equal(htmlPreviewSource('```html\n<div>源码</div>\n```'), '<div>源码</div>', 'fence markers must not enter the DOM');
assert.equal(htmlPreviewSource('~~~html\n<section>流式</section>'), '<section>流式</section>', 'tilde fences must also be supported');
assert.equal(looksLikeStreamingHtml('```javascript\n<div>源码</div>\n```'), false, 'other fenced source must remain code');

console.log('Streaming HTML: conservative boundaries and partial JSON decoding passed.');
