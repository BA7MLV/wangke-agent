// Real CSP, local material loading and repair UX. Isolated browser storage; no model calls.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(20000);
  let externalRequests = 0, modelRequests = 0;
  await page.route('https://blocked.test/**', route => { externalRequests++; return route.abort(); });
  await page.route('**/chat/completions', route => { modelRequests++; return route.abort(); });
  await page.goto(process.env.BASE_URL || 'http://127.0.0.1:5188');
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).waitFor();
  await page.evaluate(async () => {
    const load = path => {
      const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(entry?.name ?? path);
    };
    const React = (await load('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await load('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { default: WidgetBlock } = await load('/src/components/WidgetBlock.tsx');
    const { default: ArtifactEditor, ArtifactEditProvider } = await load('/src/components/ArtifactEditor.tsx');
    const { widgetImageReferences, loadWidgetImages } = await load('/src/harness/widgetImages.ts');
    const { createToolExecutor } = await load('/src/harness/tools.ts');
    const { db } = await load('/src/store/db.ts');
    const host = document.createElement('main'); host.id = 'resources-fixture';
    host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:var(--background);color:var(--foreground);z-index:100;padding:20px';
    document.body.append(host);
    const root = createRoot(host);
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 100;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#b9d8fc'; ctx.fillRect(0, 0, 240, 100);
    ctx.fillStyle = '#182e48'; ctx.font = '18px sans-serif'; ctx.fillText('Local material image', 12, 55);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    await db.videos.put({ id: 'widget-resources', name: '本地图片测试', createdAt: Date.now() });
    await db.frames.add({ videoId: 'widget-resources', ts: 1, kind: 'slide', blob });
    await db.frames.add({ videoId: 'widget-resources', ts: 2, kind: 'slide', blob: new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/png' }) });
    window.__assetHelpers = { widgetImageReferences, loadWidgetImages };
    window.__preflight = code => createToolExecutor('widget-resources', {})('show_widget', { format: 'html', code });
    window.__renderResource = async html => {
      const id = crypto.randomUUID(), payload = { html, id, ref: id, source: 'tool', schemaVersion: 1, kind: 'html' };
      const rowId = await db.chats.add({ videoId: 'widget-resources', sessionId: 9001, role: 'assistant', content: '', widgets: [payload], createdAt: Date.now() });
      root.render(React.createElement(ArtifactEditProvider, { key: id, rowId, disabled: false, onSaved() {} },
        React.createElement(ArtifactEditor, { kind: 'html', source: html, location: 'widget', widgetId: id, widgetRef: id },
          actions => React.createElement(WidgetBlock, { payload, rowId, dark: false, allowPopout: false, editActions: actions }))));
    };
  });
  const host = page.locator('#resources-fixture');
  const frame = () => host.getByTestId('widget-frame').contentFrame();
  const controls = '<label>系数<input type="range" min="1" max="5" value="2"></label><output>2</output><script>document.querySelector("input").oninput=e=>document.querySelector("output").textContent=e.target.value</script>';
  assert.match(await page.evaluate(() => window.__preflight('<div style="background:url(https://blocked.test/bg.png)">背景</div>')), /CSS url/);
  assert.match(await page.evaluate(() => window.__preflight('<img srcset="https://blocked.test/a.png 1x">')), /srcset/);

  const local = '<h2>材料图片与本地交互</h2><img data-wbw-image="#source-image/widget-resources/frame-1000" alt="课程原图">' + controls;
  await page.evaluate(html => window.__renderResource(html), local);
  await frame().getByAltText('课程原图').waitFor({ state: 'visible' });
  assert.equal(await frame().getByAltText('课程原图').evaluate(img => img.naturalWidth), 240);
  assert.equal(await host.getByTestId('widget-notice').count(), 0);
  await frame().getByRole('slider').fill('4');
  assert.equal(await frame().locator('output').innerText(), '4');
  assert.deepEqual(await page.evaluate(() => window.__assetHelpers.widgetImageReferences('<script>const example = `<img data-wbw-image="#source-image/hidden/frame-1">`</script><img data-wbw-image="#source-image/widget-resources/frame-1000">')), ['#source-image/widget-resources/frame-1000']);
  const oversize = await page.evaluate(async () => {
    const results = [];
    await window.__assetHelpers.loadWidgetImages(['#source-image/widget-resources/frame-2000'], item => results.push(item), new AbortController().signal);
    return results;
  });
  assert.match(oversize[0].error, /图片过大/);
  assert.equal(oversize[0].data, undefined);

  // A saved revision bypasses the new compatibility preflight, but real CSP still enforces it.
  const blocked = '<h2>图片失败时仍可操作</h2><div style="height:60px;background:url(https://blocked.test/bg.png?secret=hidden)">背景示例</div>' + controls + '<script>const image=document.createElement("img");image.alt="外部示意图";image.setAttribute("src","https://blocked.test/private.png?token=secret");document.body.append(image)</script>';
  await page.evaluate(html => window.__renderResource(html), blocked);
  await host.getByTestId('widget-notice').getByText('有图片未能显示', { exact: true }).waitFor();
  assert.equal(await host.getByTestId('widget-error').count(), 0);
  await frame().getByRole('img', { name: '外部示意图 · 图片未能显示' }).waitFor();
  await frame().getByRole('slider').fill('5');
  assert.equal(await frame().locator('output').innerText(), '5');
  await host.getByText('运行详情', { exact: true }).click();
  assert.doesNotMatch(await host.getByTestId('widget-notice').innerText(), /secret|private\.png|token=/);
  await host.getByRole('button', { name: '修复此块', exact: true }).click();
  assert.match(await host.getByRole('textbox', { name: '修改要求', exact: true }).inputValue(), /img-src/);
  assert.equal(modelRequests, 0, 'opening repair never starts a paid request');
  await host.getByRole('textbox', { name: '修改要求', exact: true }).fill('保留我已经填写的要求');
  await host.getByRole('button', { name: '收起', exact: true }).click();
  await host.getByRole('button', { name: '修复此块', exact: true }).click();
  assert.equal(await host.getByRole('textbox', { name: '修改要求', exact: true }).inputValue(), '保留我已经填写的要求');
  for (const width of [320, 900]) {
    await page.setViewportSize({ width, height: 800 });
    assert.ok(await host.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${width}px: recovery UI fits`);
  }
  await host.getByRole('button', { name: '收起', exact: true }).click();
  await page.screenshot({ path: `${process.env.TMPDIR || '/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T'}/opencode/widget-resource-recovery.png` });

  await page.evaluate(html => window.__renderResource(html), '<h2>缺失的本机图片</h2><img data-wbw-image="#source-image/deleted/frame-1" alt="已删除原图">' + controls);
  await frame().getByRole('img', { name: /已删除原图.*不存在/ }).waitFor();
  await host.getByTestId('widget-notice').waitFor();
  assert.equal(await host.getByTestId('widget-error').count(), 0);
  await page.evaluate(html => window.__renderResource(html), '<h2>脚本失败</h2><script>throw new Error("示例脚本错误")</script>');
  await host.getByTestId('widget-error').getByText('交互功能运行异常', { exact: true }).waitFor();
  assert.equal(externalRequests, 0, 'neither host nor iframe fetched forbidden resources');
  assert.equal(modelRequests, 0);
  console.log('PASS: generation preflight, local images, byte limits, real CSP, inline image fallback, controls after failure, diagnostic redaction, repair draft preservation, no automatic AI, 320px layout.');
} finally { await browser.close(); }
