import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// DOM utility unit tests only: no app server, mouse, touch, click or UI acceptance.
const bundle = await build({ entryPoints: ['apps/web/src/utils/htmlAnswer.ts'], bundle: true, write: false, format: 'iife', globalName: 'HtmlUtils', platform: 'browser' });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const requests = [];
  await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(() => {
    const source = '<!doctype html><html><head><style>body{color:red}</style><link rel="stylesheet" href="https://blocked.test/style.css"></head><body class="work" onload="init()"><button onclick="act()">run</button><img src="https://blocked.test/image.png"><a href="https://blocked.test/">link</a><script>window.executed = true</script><meta http-equiv="refresh" content="0;url=https://blocked.test/"></body></html>';
    const interactive = HtmlUtils.prepareInteractiveHtml(source);
    const example = HtmlUtils.sanitizeHtmlAnswer(source);
    return { interactive, example, executed: window.executed === true };
  });
  assert.equal(result.executed, false, 'preparing source must never execute it in the host');
  assert.match(result.interactive, /onclick="act\(\)"/);
  assert.match(result.interactive, /onload="init\(\)"/);
  assert.match(result.interactive, /class="work"/);
  assert.match(result.interactive, /<script>window.executed = true<\/script>/);
  assert.match(result.interactive, /href="https:\/\/blocked.test\/style.css"/, 'dependencies remain visible to iframe CSP feedback');
  assert.doesNotMatch(result.interactive, /http-equiv|<a href=/);
  assert.doesNotMatch(result.example, /<script|onclick=|onload=/);
  assert.deepEqual(requests, [], 'normalization must not load work-provided resources in the host');
  console.log('PASS: inert HTML normalization, body initialization handlers, source/example separation and no host resource requests (DOM-only unit test)');
} finally {
  await browser.close();
}
