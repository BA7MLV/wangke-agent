import assert from 'node:assert/strict';
import { htmlPreviewSource, looksLikeStreamingHtml, nextVisualRound, readPartialWidgetArguments, splitAssistantContent, splitStreamingHtml } from '../apps/web/src/utils/streamingHtml.ts';

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

assert.equal(looksLikeStreamingHtml('<div><h1>标题</h1>'), false, 'raw HTML is not an execution declaration');
assert.equal(looksLikeStreamingHtml('<!doctype html><html><body>内容'), false);
assert.equal(looksLikeStreamingHtml('<div class="card'), false);
assert.equal(looksLikeStreamingHtml('2 < 3'), false, 'ordinary prose must remain Markdown');
assert.equal(looksLikeStreamingHtml('```html\n<div>源码</div>\n```'), false, 'ordinary HTML is code');
assert.equal(htmlPreviewSource('```html\n<div>源码</div>\n```'), undefined);
assert.equal(htmlPreviewSource('~~~html interactive\n<section>流式</section>'), '<section>流式</section>', 'explicit legacy declarations support tilde fences');
assert.equal(looksLikeStreamingHtml('```javascript\n<div>源码</div>\n```'), false, 'other fenced source must remain code');

const fenced = '```html interactive\n<section>第一题</section>\n```\n\n先解释第一题，再看下一题。\n\n~~~html interactive\n<div>第二题</div>\n~~~\n\n继续练习。\n\n````htm interactive\n<div>第三题</div>\n````\n\n答完后告诉我。';
const blocks = splitAssistantContent(fenced);
assert.deepEqual(blocks.filter((block) => block.kind === 'html').map((block) => block.source), ['<section>第一题</section>', '<div>第二题</div>', '<div>第三题</div>']);
assert.deepEqual(blocks.map((block) => block.kind), ['html', 'markdown', 'html', 'markdown', 'html', 'markdown']);
assert.equal(htmlPreviewSource(fenced), undefined, 'a leading HTML fence must not swallow the entire answer');
assert.ok(blocks.every((block) => block.closed));
const raw = '<section><p>2 < 3</p><div title="a > b">第一题</div></section>\n\n**讲解**\n\n<div>第二题</div><div>第三题</div>\n完成。';
assert.deepEqual(splitAssistantContent(raw).map((block) => block.kind), ['html', 'markdown', 'html', 'html', 'markdown']);
assert.equal(splitAssistantContent(raw)[0].source, raw.slice(0, raw.indexOf('\n')));
assert.equal(splitAssistantContent('<!doctype html><html><body>第一题</body></html>\n后续回复')[0].source, '<!doctype html><html><body>第一题</body></html>');
assert.equal(splitAssistantContent('<div><script>const text = "<div>";</script>第一题</div>\n讲解')[0].closed, true, 'raw-text tags cannot confuse the boundary');
assert.equal(splitAssistantContent('````text\n```html\n<div>这只是源码</div>\n```\n````').length, 1, 'HTML examples in code stay Markdown');
assert.equal(splitAssistantContent('行内代码 `<div>` 和比较 2 < 3')[0].kind, 'markdown');
assert.equal(splitAssistantContent('示例：\n\n    <div>缩进代码</div>')[0].kind, 'markdown', 'indented code is not an HTML answer');
assert.equal(splitAssistantContent('```html interactive\n<div>正在出题')[0].closed, false);
assert.equal(splitAssistantContent('```html\n<div>正在出题')[0].kind, 'markdown');
assert.equal(splitAssistantContent('<div class="card')[0].closed, false);
for (let length = 0; length <= fenced.length; length++) {
  const partialBlocks = splitAssistantContent(fenced.slice(0, length));
  for (const block of partialBlocks.filter((block) => block.kind === 'html' && block.closed)) {
    assert.ok(['<section>第一题</section>', '<div>第二题</div>', '<div>第三题</div>'].includes(block.source), 'completed questions stay independent at every stream boundary');
  }
}
assert.equal(nextVisualRound('正在检索资料。'), '', 'plain retrieval narration still resets');
assert.equal(nextVisualRound('```html\n<div>第一题</div>\n```'), '```html\n<div>第一题</div>\n```\n\n', 'delivered HTML survives the next tool round');
assert.equal(nextVisualRound('题目讲解', true), '题目讲解\n\n', 'widget explanation also survives');
assert.equal(nextVisualRound('```wbw-widget\nquestion-1\n```'), '```wbw-widget\nquestion-1\n```\n\n');

const svg = '<svg width="200" height="200"><defs><linearGradient id="g"><stop offset="0%" stop-color="#fff"/></linearGradient></defs><circle r="80" fill="url(#g)"/></svg>';
const mixedSvg = `前文\n\n${svg}\n\n后文\n\n${svg}\n结束`;
assert.deepEqual(splitAssistantContent(mixedSvg).map(block => block.kind), ['markdown', 'svg', 'markdown', 'svg', 'markdown']);
assert.deepEqual(splitAssistantContent(mixedSvg).filter(block => block.kind === 'svg').map(block => block.source), [svg, svg]);
assert.equal(splitAssistantContent('```html\n' + svg + '\n```')[0].kind, 'markdown', 'HTML examples containing SVG remain code');
assert.equal(splitAssistantContent('<svg width="200"')[0].closed, false);
assert.equal(splitAssistantContent('示例：\n\n    ' + svg)[0].kind, 'markdown', 'indented examples go through the code renderer');
assert.equal(splitAssistantContent('```js\n' + svg + '\n```')[0].kind, 'markdown');
for (const value of [svg, '```xml\n' + svg + '\n```', '```\n' + svg + '\n```'])
  assert.equal(nextVisualRound(value), value + '\n\n', 'SVG survives later tool rounds');

console.log('Streaming HTML: ordered mixed blocks, three questions, chunk boundaries, retained rounds and partial JSON decoding passed.');
