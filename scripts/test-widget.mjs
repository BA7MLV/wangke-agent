#!/usr/bin/env node
/**
 * show_widget 的纯逻辑：入参校验 + 两条回执文案（src/harness/widget.ts）。
 *
 * 为什么只测这一层：真正决定「预检有没有意义」的是**它是否走了渲染层同一个净化函数**，
 * 那是 `probe-svg-sanitize.mjs`（要真浏览器，DOMPurify 需要 window）守的。
 * 本文件守住剩下的一半：参数校验，以及**回执文案是否可执行** ——
 * 文案是模型唯一的纠错依据，写成「已阻止渲染」这种它没法照着改的话，
 * 这个工具就退化成一块只会说「不行」的牌子。
 *
 * 运行：node scripts/test-course-chat-tools.mjs 之外单独跑：node scripts/test-widget.mjs
 */
import assert from 'node:assert/strict';
import { validateWidgetArgs, widgetAcceptedText, widgetRejectedText } from '../src/harness/widget.ts';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL - ${name}\n    ${e.message}`);
  }
}

const SVG = '<svg viewBox="0 0 240 120"><rect x="1" y="1" width="10" height="10"/></svg>';

test('接受 svg 与 mermaid 两种 format', () => {
  for (const format of ['svg', 'mermaid']) {
    const v = validateWidgetArgs({ format, code: SVG });
    assert.ok(v.ok, `${format} 应通过`);
    assert.equal(v.args.format, format);
    assert.equal(v.args.code, SVG, 'code 应被 trim 后原样保留');
  }
});

// ── html 形态：mockup / interactive / chart 都走它 ────────────────────────────
test('html 形态：接受片段，libs 白名单外的被拒', () => {
  const ok = validateWidgetArgs({ format: 'html', code: '<div id="c">hi</div>' });
  assert.ok(ok.ok);
  assert.equal(ok.args.libs, undefined, '没传 libs 就不该有该字段');

  const withLib = validateWidgetArgs({ format: 'html', code: '<canvas></canvas>', libs: ['chart.js'] });
  assert.ok(withLib.ok);
  assert.deepEqual(withLib.args.libs, ['chart.js']);

  // 重复声明去重，避免把 200KB 的库内联两遍
  const dup = validateWidgetArgs({ format: 'html', code: '<b/>', libs: ['chart.js', 'chart.js'] });
  assert.deepEqual(dup.args.libs, ['chart.js']);

  const bad = validateWidgetArgs({ format: 'html', code: '<b/>', libs: ['https://evil.example/x.js'] });
  assert.ok(!bad.ok && /libs/.test(bad.error), '任意外链不得被当作库内联');
});

test('html 形态：拒绝文档外壳（外壳由宿主提供）', () => {
  for (const code of [
    '<html><body>x</body></html>',
    '<!DOCTYPE html><p>x</p>',
    '<head><style>a{}</style></head>',
    '<body>x</body>',
  ]) {
    const v = validateWidgetArgs({ format: 'html', code });
    assert.ok(!v.ok, `应拒绝：${code}`);
    assert.match(v.error, /片段/);
  }
});

test('html 形态：拒绝外链脚本与外链资源（网络已禁用，要给可执行的解释）', () => {
  const s = validateWidgetArgs({ format: 'html', code: '<script src="https://cdn.example/x.js"></script>' });
  assert.ok(!s.ok && /libs/.test(s.error), '要提示改用 libs，而不是只说「不行」');

  const h = validateWidgetArgs({ format: 'html', code: '<img src="https://evil.example/x.png">' });
  assert.ok(!h.ok && /外部/.test(h.error));

  const l = validateWidgetArgs({ format: 'html', code: '<link href="https://evil.example/x.css" rel="stylesheet">' });
  assert.ok(!l.ok && /外部/.test(l.error));
});

test('html 形态：超长被拒；内联 script 不误伤', () => {
  const v = validateWidgetArgs({ format: 'html', code: 'x'.repeat(60_001) });
  assert.ok(!v.ok && /60000/.test(v.error));
  const ok = validateWidgetArgs({ format: 'html', code: "<div></div><script>var a=1</scr" + 'ipt>' });
  assert.ok(ok.ok, '内联 script 应放行');
});

test('html 回执：说明「已渲染、在下方」，并劝阻把 HTML 贴进正文', () => {
  const t = widgetAcceptedText({ format: 'html', code: '<div/>' });
  assert.match(t, /已渲染/);
  assert.match(t, /不要再把 HTML 贴进正文/);
  assert.ok(!t.includes('```'), 'html 回执不该含围栏（那会被当源码显示）');
});

test('拒绝非法 format / 空 code / 超长 code', () => {
  const bad1 = validateWidgetArgs({ format: 'dot', code: SVG });
  assert.ok(!bad1.ok && /format/.test(bad1.error));

  const bad2 = validateWidgetArgs({ format: 'svg', code: '   ' });
  assert.ok(!bad2.ok && /不能为空/.test(bad2.error));

  const bad3 = validateWidgetArgs({ format: 'svg', code: 'x'.repeat(20_001) });
  assert.ok(!bad3.ok && /过长/.test(bad3.error));

  // 参数整个缺失也不能抛
  assert.ok(!validateWidgetArgs(undefined).ok);
  assert.ok(!validateWidgetArgs(null).ok);
  assert.ok(!validateWidgetArgs({}).ok);
});

test('code 恰好在上限上不报错（边界）', () => {
  assert.ok(validateWidgetArgs({ format: 'svg', code: 'x'.repeat(20_000) }).ok);
});

test('通过回执：回一段围栏，并强调「还没上屏」与「放进正文」', () => {
  const t = widgetAcceptedText({ format: 'svg', code: SVG });
  // 模型最容易犯的错是把回执当成「已经画完了」而不写进正文，所以这两句是硬要求
  assert.match(t, /还没有上屏/);
  assert.match(t, /放进你的回答正文/);
  assert.ok(t.includes('```svg'), '回执里必须含可粘贴的围栏');
  assert.ok(t.includes(SVG), '源码要原样带回来');
});

test('通过回执：mermaid 的围栏名跟着 format 走', () => {
  const t = widgetAcceptedText({ format: 'mermaid', code: 'flowchart TD\n  A-->B' });
  assert.ok(t.includes('```mermaid'));
  assert.ok(!t.includes('```svg'));
});

test('失败回执：每类净化报错都要翻译成可执行的改法', () => {
  // 措辞对齐 components/mermaid/svgRender.ts 实际会抛的几种
  const cases = [
    ['没有找到 <svg 标签：请用 ```svg 围栏包一段完整的 SVG', /以 <svg 开头/],
    ['SVG 没有闭合（缺少 </svg>）', /补上 <\/svg>/],
    ['净化后没有剩下可渲染的图形内容', /白名单之外的标签/],
    ['SVG 包含脚本或外部嵌入内容，已阻止渲染', /含有脚本或外部嵌入/],
    ['SVG 引用了外部资源，已阻止渲染', /不允许引用外部资源/],
  ];
  for (const [raw, expect] of cases) {
    const t = widgetRejectedText(new Error(raw));
    assert.match(t, expect, `原始报错「${raw}」的归因不对`);
    assert.ok(t.includes(raw), '必须带上原始报错，否则模型无从定位');
    assert.match(t, /图不会上屏/, '要说清后果');
  }
});

test('失败回执：认不出来的报错回落到通用建议，不丢原文', () => {
  const t = widgetRejectedText(new Error('某个没见过的异常'));
  assert.match(t, /某个没见过的异常/);
  assert.match(t, /定位问题/);
});

test('失败回执：非 Error 的抛出物也能处理', () => {
  assert.match(widgetRejectedText('字符串报错'), /字符串报错/);
  assert.match(widgetRejectedText({ weird: true }), /定位问题/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);