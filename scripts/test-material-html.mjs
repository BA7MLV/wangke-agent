#!/usr/bin/env node
/**
 * HTML 阅读材料的浏览器级单元测试。
 *
 * DOMParser / DOMPurify 都是浏览器能力，所以先用 esbuild 把模块打成 IIFE，
 * 再放进 Playwright 的空白页执行；无需启动应用或 API 服务。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '../src/materials/html.ts');
const bundle = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  globalName: 'HtmlMaterial',
  platform: 'browser',
  write: false,
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('about:blank');
await page.addScriptTag({ content: bundle.outputFiles[0].text });

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL - ${name}\n    ${e.message}`);
  }
}

await test('识别 .html / .htm 与 HTML MIME', async () => {
  const results = await page.evaluate(() => [
    HtmlMaterial.isHtmlFile({ name: '讲义.HTML', type: '' }),
    HtmlMaterial.isHtmlFile({ name: '讲义.htm', type: '' }),
    HtmlMaterial.isHtmlFile({ name: 'download', type: 'text/html; charset=utf-8' }),
    HtmlMaterial.isHtmlFile({ name: '讲义.md', type: 'text/markdown' }),
  ]);
  assert.deepEqual(results, [true, true, true, false]);
});

await test('标题并入正文，列表与表格各自成为可定位段落', async () => {
  const units = await page.evaluate(() => HtmlMaterial.extractHtmlUnits(`<!doctype html>
    <html><head><title>不算正文</title><script>evil()</script></head><body>
      <h1>第一章</h1><h2>概述</h2><p>第一段正文。</p>
      <ul><li>项目一</li><li>项目二</li></ul>
      <table><tr><th>名称</th><th>值</th></tr><tr><td>A</td><td>1</td></tr></table>
    </body></html>`));
  assert.equal(units.length, 4);
  assert.equal(units[0].unit, 1);
  assert.equal(units[0].text, '第一章\n\n概述\n\n第一段正文。');
  assert.equal(units[0].section, '概述');
  assert.equal(units[0].kind, 'title');
  assert.equal(units[1].text, '项目一');
  assert.equal(units[2].text, '项目二');
  assert.match(units[3].text, /名称/);
  assert.match(units[3].text, /A/);
  assert.equal(units[3].kind, 'table');
  assert.equal(units.some((unit) => unit.text.includes('evil')), false);
});

await test('只有 div 的网页仍能抽出正文，隐藏内容不入索引', async () => {
  const units = await page.evaluate(() => HtmlMaterial.extractHtmlUnits(`
    <main><div><span>第一块</span></div><div hidden>秘密</div><div>第二块</div></main>`));
  assert.deepEqual(units.map((unit) => unit.text), ['第一块', '第二块']);
});

await test('渲染白名单移除脚本、事件、外部图片和危险链接', async () => {
  const clean = await page.evaluate(() => HtmlMaterial.sanitizeHtmlFragment(`
    <p onclick="evil()">安全正文</p><script>evil()</script>
    <img src="https://tracker.invalid/pixel.png" onerror="evil()">
    <a href="javascript:evil()">坏链接</a><a href="https://example.com/a">好链接</a>`));
  assert.doesNotMatch(clean, /script|onclick|onerror|javascript:/i);
  assert.doesNotMatch(clean, /tracker\.invalid/);
  assert.match(clean, /href="https:\/\/example\.com\/a"/);
  assert.match(clean, /target="_blank"/);
  assert.match(clean, /rel="noopener noreferrer"/);
});

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
