#!/usr/bin/env node
/**
 * HTML 阅读材料的浏览器级单元测试。
 *
 * DOMParser / DOMPurify / TextDecoder / 沙箱 iframe 都是浏览器能力，所以先用 esbuild 把
 * 模块打成 IIFE，再放进 Playwright 的页面里执行；无需启动应用或 API 服务。
 *
 * 页面停在 `https://mr.test/`（由 `page.route` 就地应答，不出网）而不是 `about:blank`：
 * **`about:blank` 顶层文档的源是不透明的**，拿它测「沙箱 iframe 能否同源」会得到假阴性 ——
 * 而那条假设正是划词与段号跳转的前提，必须在一个真有源的环境里断言。
 *
 * 覆盖：
 *   1. 识别 .html / .htm 与 HTML MIME
 *   2. 抽单元：标题并入正文、列表 / 表格各自成段、隐藏内容不入索引
 *   3. 整文档净化：保留 style、删掉脚本面与导航面、相对路径一律拦住
 *   4. CSP 逐字断言（关 / 开联网两档），且在 head 首位
 *   5. 段号锚点与 `extractHtmlUnits` 的单元号**同源同序**
 *   6. 沙箱同源假设：`allow-same-origin` 能读 contentDocument，空 sandbox 读不到
 *   7. 字符集：GB2312 文档不乱码，无声明时回落 UTF-8
 *   8. 分段视图的片段白名单
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
// 给页面一个真实源（不透明源的顶层文档测不出同源沙箱的真实行为），且全程不出网
await page.route('**/*', (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>host</body></html>' }),
);
await page.goto('https://mr.test/');
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

await test('URL 分类：内嵌 / 远程 / 页内锚点 / 相对 / 其它 scheme', async () => {
  const kinds = await page.evaluate(() => [
    HtmlMaterial.urlKind('data:image/png;base64,AAA'),
    HtmlMaterial.urlKind('blob:https://x/1'),
    HtmlMaterial.urlKind('https://a/b.png'),
    HtmlMaterial.urlKind('//cdn/a.png'),
    HtmlMaterial.urlKind('#sec'),
    HtmlMaterial.urlKind('./a.png'),
    HtmlMaterial.urlKind('assets/a.css'),
    HtmlMaterial.urlKind('javascript:evil()'),
    HtmlMaterial.urlKind(''),
  ]);
  assert.deepEqual(kinds, [
    'inline',
    'inline',
    'remote',
    'remote',
    'fragment',
    'relative',
    'relative',
    'other',
    'empty',
  ]);
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

await test('整文档净化：保留 style 与结构，删掉脚本面与导航面', async () => {
  const out = await page.evaluate(() =>
    HtmlMaterial.prepareHtmlDocument(
      `<!doctype html><html><head>
        <meta http-equiv="refresh" content="0;url=https://evil.test/">
        <meta charset="utf-8">
        <meta name="viewport" content="width=1200">
        <base href="https://evil.test/">
        <link rel="preload" href="https://evil.test/x.js">
        <style>.a{color:red}body{background:#fff}</style>
      </head><body onload="evil()">
        <h1 style="margin:0">标题</h1><p onclick="evil()">正文</p>
        <iframe src="https://evil.test/"></iframe>
        <form action="https://evil.test/"><input name="a"></form>
        <video src="https://evil.test/v.mp4"></video>
        <script>evil()</script>
        <p>尾段</p>
      </body></html>`,
      { remote: false },
    ),
  );
  const probe = await page.evaluate((doc) => {
    const d = new DOMParser().parseFromString(doc, 'text/html');
    return {
      hasStyleEl: !!d.querySelector('style'),
      styleText: d.querySelector('style')?.textContent ?? '',
      inlineStyle: d.querySelector('h1')?.getAttribute('style') ?? '',
      forbidden: ['script', 'iframe', 'form', 'input', 'video', 'base'].filter((t) => d.querySelector(t)),
      metas: [...d.querySelectorAll('meta')].map((m) => m.getAttribute('http-equiv') ?? m.getAttribute('name') ?? ''),
      onAttrs: [...d.querySelectorAll('*')].flatMap((el) => el.getAttributeNames().filter((a) => a.startsWith('on'))),
      hasBody: !!d.body,
      hasHtml: !!d.documentElement,
      text: d.body?.textContent ?? '',
    };
  }, out.doc);
  assert.equal(probe.hasStyleEl, true);
  assert.match(probe.styleText, /color:red/);
  assert.equal(probe.inlineStyle, 'margin:0');
  assert.deepEqual(probe.forbidden, []);
  // 原文档的 charset / viewport / refresh 三个 meta 都被摘掉，只剩我们自己注入的这两条
  assert.deepEqual(probe.metas, ['Content-Security-Policy', 'viewport']);
  assert.deepEqual(probe.onAttrs, []);
  assert.equal(probe.hasBody, true);
  assert.equal(probe.hasHtml, true);
  assert.match(probe.text, /标题/);
  assert.match(probe.text, /尾段/);
  assert.doesNotMatch(out.doc, /evil\.test/);
});

await test('CSP 逐字断言：在 head 首位，两档都不放行脚本', async () => {
  const csp = await page.evaluate(() => {
    const pick = (remote) => {
      const { doc } = HtmlMaterial.prepareHtmlDocument('<!doctype html><html><body><p>x</p></body></html>', { remote });
      const d = new DOMParser().parseFromString(doc, 'text/html');
      const first = d.head.firstElementChild;
      return {
        isCsp: first?.getAttribute('http-equiv') === 'Content-Security-Policy',
        content: first?.getAttribute('content') ?? '',
      };
    };
    return { off: pick(false), on: pick(true) };
  });
  assert.equal(csp.off.isCsp, true);
  assert.equal(csp.on.isCsp, true);
  assert.equal(
    csp.off.content,
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'",
  );
  assert.equal(
    csp.on.content,
    "default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline' https: http:; font-src data: https: http:; base-uri 'none'; form-action 'none'",
  );
  // 关掉联网时整串里不该出现任何远程来源
  assert.doesNotMatch(csp.off.content, /https?:/);
});

await test('图片：内嵌留、远程按开关、相对路径一律摘掉并计数', async () => {
  const src = `<!doctype html><html><body>
    <img src="data:image/png;base64,AAA" alt="内嵌">
    <img src="https://cdn.test/a.png" alt="远程">
    <img src="./local.png" alt="相对">
    <img srcset="./a.png 1x" src="https://cdn.test/b.png" alt="带 srcset">
  </body></html>`;
  const both = await page.evaluate((html) => {
    const read = (remote) => {
      const out = HtmlMaterial.prepareHtmlDocument(html, { remote });
      const d = new DOMParser().parseFromString(out.doc, 'text/html');
      return { srcs: [...d.querySelectorAll('img')].map((i) => i.getAttribute('src')), stats: out.stats };
    };
    return { on: read(true), off: read(false) };
  }, src);

  assert.deepEqual(both.on.srcs, ['data:image/png;base64,AAA', 'https://cdn.test/a.png', null, 'https://cdn.test/b.png']);
  assert.equal(both.on.stats.remoteLoaded, 2);
  assert.equal(both.on.stats.unresolved, 1);

  assert.deepEqual(both.off.srcs, ['data:image/png;base64,AAA', null, null, null]);
  assert.equal(both.off.stats.remoteLoaded, 0);
  assert.equal(both.off.stats.remoteBlocked, 2);
  assert.equal(both.off.stats.unresolved, 1);
});

await test('CSS：相对 url() 与 @import 拦住，远程按开关放行', async () => {
  const out = await page.evaluate(() => {
    const html = `<!doctype html><html><head><style>
      @import url("https://fonts.test/x.css");
      @import "local.css";
      .a{background:url(./bg.png)}
      .b{background:url("data:image/gif;base64,AAA")}
      .c{background:url(#grad)}
      .d{background:url(https://cdn.test/d.png)}
    </style></head><body><p style="background:url(./inline.png)">x</p></body></html>`;
    const read = (remote) => {
      const r = HtmlMaterial.prepareHtmlDocument(html, { remote });
      const d = new DOMParser().parseFromString(r.doc, 'text/html');
      return {
        css: d.querySelector('style')?.textContent ?? '',
        inline: d.querySelector('p')?.getAttribute('style') ?? '',
        stats: r.stats,
      };
    };
    return { on: read(true), off: read(false) };
  });

  // 远程 @import 与 url 保留；相对的一律变成 about:invalid，且不产生任何请求
  assert.match(out.on.css, /@import url\("https:\/\/fonts\.test\/x\.css"\)/);
  assert.match(out.on.css, /url\(https:\/\/cdn\.test\/d\.png\)/);
  assert.doesNotMatch(out.on.css, /local\.css/);
  assert.match(out.on.css, /url\("about:invalid"\)/);
  assert.match(out.on.css, /url\("data:image\/gif;base64,AAA"\)/);
  assert.match(out.on.css, /url\(#grad\)/);
  assert.equal(out.on.inline, 'background:url("about:invalid")');

  assert.doesNotMatch(out.off.css, /fonts\.test/);
  assert.doesNotMatch(out.off.css, /cdn\.test/);
  assert.match(out.off.css, /@import 已移除/);
});

await test('段号锚点与 extractHtmlUnits 同源同序', async () => {
  const src = `<!doctype html><html><body>
    <div class="wrap">
      <h1>第一章</h1><p>第一段正文。</p>
      <h2>小节</h2><p>第二段正文。</p>
      <ul><li>条目</li></ul>
      <table><tr><td>表</td></tr></table>
    </div></body></html>`;
  const out = await page.evaluate((html) => {
    const units = HtmlMaterial.extractHtmlUnits(html);
    const prepared = HtmlMaterial.prepareHtmlDocument(html, { remote: false });
    const d = new DOMParser().parseFromString(prepared.doc, 'text/html');
    const all = [...d.querySelectorAll('[data-mr-unit]')];
    return {
      extract: units.map((u) => ({ unit: u.unit, text: u.text, kind: u.kind ?? 'body' })),
      prepared: prepared.units.map((u) => ({ unit: u.unit, text: u.text, kind: u.kind ?? 'body' })),
      marked: [...new Set(all.map((e) => Number(e.getAttribute('data-mr-unit'))))].sort((a, b) => a - b),
      h1Unit: d.querySelector('h1')?.getAttribute('data-mr-unit') ?? null,
      firstPUnit: d.querySelector('p')?.getAttribute('data-mr-unit') ?? null,
      // 纯容器是多个单元的公共祖先，打了锚点会让 closest() 认错单元
      wrapUnit: d.querySelector('.wrap')?.getAttribute('data-mr-unit') ?? null,
    };
  }, src);

  assert.deepEqual(out.prepared, out.extract);
  assert.deepEqual(out.marked, out.extract.map((u) => u.unit));
  // 标题与紧随的正文块共享段号：标题是跳转落点，正文块是划词的命中点
  assert.equal(out.h1Unit, '1');
  assert.equal(out.firstPUnit, '1');
  assert.equal(out.wrapUnit, null);
});

await test('沙箱同源假设：allow-same-origin 读得到，空 sandbox 读不到', async () => {
  const { doc } = await page.evaluate(() =>
    HtmlMaterial.prepareHtmlDocument(
      '<!doctype html><html><body><h1>第一章</h1><p>正文。</p></body></html>',
      { remote: false },
    ),
  );
  const result = await page.evaluate(async (html) => {
    const make = (sandbox) =>
      new Promise((resolve) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', sandbox);
        frame.srcdoc = html;
        frame.addEventListener('load', () => {
          const d = frame.contentDocument;
          resolve({
            readable: !!d,
            anchors: d ? [...d.querySelectorAll('[data-mr-unit]')].map((e) => e.getAttribute('data-mr-unit')) : [],
            text: d?.body?.textContent ?? '',
          });
          frame.remove();
        });
        document.body.appendChild(frame);
      });
    return { same: await make('allow-same-origin'), opaque: await make('') };
  }, doc);

  // 这条断言是「划词 + [第N段] 跳转」能继续工作的**前提**，不是实现细节
  assert.equal(result.same.readable, true);
  assert.deepEqual(result.same.anchors, ['1', '1']);
  assert.match(result.same.text, /正文/);
  // 反过来确认这个权限不是白给的：空 sandbox（不透明源）父窗口读不到
  assert.equal(result.opaque.readable, false);
});

await test('字符集：GB2312 声明不乱码，无声明回落 UTF-8', async () => {
  const decoded = await page.evaluate(async () => {
    const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
    const gbk = new Uint8Array([
      ...ascii('<html><head><meta charset="gb2312"></head><body><p>'),
      0xd6, 0xd0, 0xce, 0xc4, // 「中文」的 GBK 编码
      ...ascii('</p></body></html>'),
    ]);
    const utf8 = new Blob(['<html><body><p>中文</p></body></html>']);
    return {
      gbk: await HtmlMaterial.readHtmlText(new Blob([gbk])),
      utf8: await HtmlMaterial.readHtmlText(utf8),
    };
  });
  assert.match(decoded.gbk, /<p>中文<\/p>/);
  assert.match(decoded.utf8, /<p>中文<\/p>/);
});

await test('渲染白名单移除脚本、事件、外部图片和危险链接', async () => {
  const clean = await page.evaluate(() => HtmlMaterial.sanitizeHtmlFragment(`
    <p onclick="evil()">安全正文</p><script>evil()</script>
    <img src="https://tracker.invalid/pixel.png" onerror="evil()">
    <a href="javascript:evil()">坏链接</a><a href="https://example.com/a">好链接</a><a href="#sec">页内</a>`));
  assert.doesNotMatch(clean, /script|onclick|onerror|javascript:/i);
  assert.doesNotMatch(clean, /tracker\.invalid/);
  assert.match(clean, /href="https:\/\/example\.com\/a"/);
  assert.match(clean, /target="_blank"/);
  assert.match(clean, /rel="noopener noreferrer"/);
  // 页内锚点不产生请求，放行且不该被当成外链打开新窗口
  assert.match(clean, /href="#sec"/);
  assert.doesNotMatch(clean, /href="#sec"[^>]*target/);
});

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
