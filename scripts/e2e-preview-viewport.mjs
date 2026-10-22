import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 850 } });
    await page.goto(process.env.BASE_URL || 'http://localhost:5173');
    await page.evaluate(async () => {
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const client = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { createRoot } = client.default || client;
      const { default: Html } = await import('/src/components/StreamingHtmlPreview.tsx');
      const { default: Svg } = await import('/src/components/mermaid/SvgBlock.tsx');
      const host = document.createElement('div');
      host.id = 'preview-viewport-test';
      host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:var(--background);padding:16px;z-index:99999';
      document.body.append(host);
      const root = createRoot(host);
      window.renderPreview = (kind, source, closed = false) => root.render(kind === 'html'
        ? React.createElement(Html, { html: source, isStreaming: !closed })
        : React.createElement(Svg, { code: source, closed }));
    });
    const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => window.renderPreview('html', '<p>第一段</p>'));
    await flush();
    const html = page.getByTestId('widget-stream-preview');
    const initial = await html.boundingBox();
    await page.evaluate(() => {
      window.firstPreviewNode = document.querySelector('.widget-stream-preview__frozen p');
      window.renderPreview('html', '<p>第一段</p>' + '<p>追加内容</p>'.repeat(80));
    });
    await flush();
    assert(await page.evaluate(() => window.firstPreviewNode === document.querySelector('.widget-stream-preview__frozen p')), 'completed HTML nodes stay mounted');
    const grown = await html.boundingBox();
    assert(grown.height > initial.height && grown.height <= 553, 'HTML grows only to viewport cap');
    assert(await html.evaluate(el => el.scrollHeight > el.clientHeight), 'long HTML remains scrollable');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 2000"><rect width="300" height="2000" fill="gray"/>';
    await page.evaluate(source => window.renderPreview('svg', source), svg);
    await page.getByTestId('live-svg').waitFor();
    const canvas = page.locator('#preview-viewport-test .xmd-mermaid-canvas');
    assert((await canvas.boundingBox()).height <= 553, 'streaming SVG respects viewport cap');
    await page.evaluate(source => window.renderPreview('svg', source + '</svg>', true), svg);
    await page.getByTestId('live-svg').waitFor({ state: 'detached' });
    assert((await canvas.boundingBox()).height <= 553, 'completed SVG retains the same cap');
    assert(await canvas.evaluate(el => el.scrollHeight > el.clientHeight), 'full diagram is reachable by scrolling');
    console.log(`Preview ${width}px: incremental HTML, bounded HTML/SVG heights and full-content scrolling passed.`);
    await page.close();
  }
} finally {
  await browser.close();
}
