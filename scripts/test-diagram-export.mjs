#!/usr/bin/env node
/**
 * 图表导出契约：`toStandaloneSvg()` 把渲染结果导出成可独立打开的 .svg 时，
 * **只能改根标签**，不能碰子元素的几何属性。
 *
 * 这条是给原生 svg 围栏加的：mermaid 的产出根节点必然带 width，所以过去那版
 * 「全串替换第一个 `\swidth="…"`」恰好命中的就是根节点；而模型手写的 SVG 经常
 * 只给 viewBox、根节点不写 width，此时全串替换会打到某个子元素上
 * （比如 `<rect width="100">` 直接被删掉），导出文件里的图形就变形了。
 *
 * 运行：node scripts/test-diagram-export.mjs
 */
import assert from 'node:assert/strict';
import { toStandaloneSvg, svgIntrinsicSize } from '../src/components/mermaid/mermaidRender.ts';

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

test('svgIntrinsicSize 读 viewBox，缺 viewBox 时给兜底尺寸', () => {
  assert.deepEqual(svgIntrinsicSize('<svg viewBox="0 0 220 140"><rect/></svg>'), { width: 220, height: 140 });
  assert.deepEqual(svgIntrinsicSize('<svg viewBox="0 0 1.5 2.5"/>'), { width: 1.5, height: 2.5 });
  assert.deepEqual(svgIntrinsicSize('<svg><rect/></svg>'), { width: 800, height: 600 });
});

test('导出带 xml 头，且根标签拿到 viewBox 尺寸', () => {
  const out = toStandaloneSvg('<svg viewBox="0 0 220 140"><rect/></svg>');
  assert.ok(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'), '应有 xml 声明');
  assert.match(out, /<svg[^>]*width="220"[^>]*height="140"/);
});

test('mermaid 那种「根节点已有 width/height」的情况：旧尺寸被换掉，不是叠加', () => {
  const out = toStandaloneSvg('<svg id="m1" width="100%" height="100%" viewBox="0 0 320 180"><g/></svg>');
  const root = out.slice(out.indexOf('<svg'));
  const widths = root.match(/\swidth=/g) || [];
  assert.equal(widths.length, 1, `根标签上应只有一个 width（实得 ${widths.length}）`);
  assert.match(root, /<svg[^>]*width="320"[^>]*height="180"/);
  assert.ok(!/width="100%"/.test(root), '旧的百分比尺寸应被移除');
});

test('★ 根节点没有 width 时，子元素的 width 绝不能被删（原生 svg 的常态）', () => {
  const src = '<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="80" height="30"/><circle cx="150" cy="50" r="20"/></svg>';
  const out = toStandaloneSvg(src);
  assert.ok(out.includes('<rect x="10" y="10" width="80" height="30"'), `rect 的几何被改坏了：${out}`);
  assert.ok(out.includes('<circle cx="150" cy="50" r="20"'), `circle 的几何被改坏了：${out}`);
  assert.match(out, /<svg[^>]*width="200"[^>]*height="100"/, '根标签应补上 viewBox 尺寸');
});

test('缺 xmlns 时补上（独立打开的文件不能靠 HTML 解析器兜底）', () => {
  const out = toStandaloneSvg('<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>');
  assert.match(out, /<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal((out.match(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g) || []).length, 1, 'xmlns 不该重复');
});

test('已有 xmlns 时不重复添加', () => {
  const out = toStandaloneSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>');
  assert.equal((out.match(/xmlns=/g) || []).length, 1, `xmlns 出现了多次：${out}`);
});

test('只动根标签：viewBox、子元素属性与文本原样保留', () => {
  const src = '<svg viewBox="0 0 60 40"><path d="M0 0 L60 40" stroke-width="2"/><text x="30" y="20" font-size="10">顶点</text></svg>';
  const out = toStandaloneSvg(src);
  assert.ok(out.includes('viewBox="0 0 60 40"'), 'viewBox 不该被动');
  assert.ok(out.includes('<path d="M0 0 L60 40" stroke-width="2"'), 'path 不该被动');
  assert.ok(out.includes('>顶点</text>'), '中文文本不该被动');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
