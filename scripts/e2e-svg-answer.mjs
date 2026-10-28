import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5188';
const svg = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#6a11cb;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#2575fc;stop-opacity:1" /> >
    </linearGradient>
  </defs>
  <circle cx="100" cy="100" r="80" fill="url(#grad1)" />
  <text x="100" y="110" font-family="Arial, sans-serif" font-size="20" fill="white" text-anchor="middle">SVG</text>
</svg>`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    if (window.top !== window) return;
    window.__svgImport = path => {
      const resource = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(resource?.name ?? path);
    };
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: {
      theme: 'light', providers: [{ id: 'test', name: 'Test', baseUrl: 'https://svg-answer.test/v1', apiKey: 'test', serves: ['chat'], catalogId: '' }],
      llmModel: { providerId: 'test', model: 'test-model' },
    } }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { default: AssistantContent } = await import('/src/components/AssistantContent.tsx');
    const { Markdown } = await import('/src/components/markdown/Markdown.tsx');
    const { MarkdownCode, MarkdownPre } = await import('/src/components/mermaid/markdown.tsx');
    const host = document.createElement('div');
    host.id = 'svg-answer-test';
    host.style.cssText = 'position:fixed;inset:0;background:var(--background);padding:24px;overflow:auto;z-index:9999';
    document.body.append(host);
    const root = ReactDOM.createRoot(host);
    const components = { code: MarkdownCode, pre: MarkdownPre };
    window.renderSvgAnswer = (content, streaming = false) => root.render(React.createElement(AssistantContent, { content, streaming },
      (text, active) => React.createElement(Markdown, { content: text, components, streaming: { hasNextChunk: active } })));
    window.unmountSvgTest = () => { root.unmount(); host.remove(); };
  });
  const host = page.locator('#svg-answer-test');
  const canvas = host.getByTestId('svg-canvas');
  for (const lang of ['svg', 'xml', '', 'html', 'image/svg+xml']) {
    await page.evaluate(source => window.renderSvgAnswer(source), `这是一个 SVG 示例：\n\n\`\`\`${lang}\n${svg}\n\`\`\`\n\n后续说明。`);
    await canvas.locator('circle').waitFor();
    assert.equal(await host.getByTestId('svg-block').getAttribute('data-phase'), 'ok', lang);
    assert.equal(await canvas.locator('linearGradient stop').count(), 2);
    assert.equal(await canvas.locator('stop').first().evaluate(el => getComputedStyle(el).stopColor), 'rgb(106, 17, 203)');
    assert.equal(await canvas.locator('circle').getAttribute('fill'), 'url(#grad1)');
    assert.equal(await canvas.locator('text').textContent(), 'SVG');
    assert.equal(await host.locator('pre').count(), 0, 'SVG preview is not wrapped in a source code block');
    await host.getByText('后续说明。', { exact: true }).waitFor();
  }
  for (const source of [svg, svg.split('\n').map(line => '    ' + line).join('\n')]) {
    await page.evaluate(source => window.renderSvgAnswer(source), '前文\n\n' + source + '\n\n后文');
    await canvas.locator('circle').waitFor();
    await host.getByText('后文', { exact: true }).waitFor();
    assert.equal(await host.locator('pre').count(), 0);
  }
  const xmlFence = '```xml\n' + svg + '\n```';
  for (const end of [4, svg.indexOf('<circle'), svg.indexOf('<text'), svg.length]) {
    await page.evaluate(source => window.renderSvgAnswer(source, true), '```xml\n' + svg.slice(0, end));
    await host.getByTestId('svg-block').waitFor();
    assert.equal(await host.getByTestId('svg-error').count(), 0, 'partial SVG does not flash an error');
  }
  await page.evaluate(source => window.renderSvgAnswer(source), xmlFence);
  await canvas.locator('circle').waitFor();
  await host.getByTestId('svg-more').click();
  await page.getByTestId('svg-source-toggle').click();
  assert.equal(await host.getByTestId('svg-source').textContent(), svg, 'source is not silently repaired');
  for (const width of [390, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await host.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'no mobile overflow');
  }
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
  for (const source of ['```xml\n<catalog><item>ordinary XML</item></catalog>\n```', '```js\n' + svg + '\n```', '`<svg></svg>`']) {
    await page.evaluate(source => window.renderSvgAnswer(source), source);
    await page.waitForFunction(() => document.querySelector('#svg-answer-test code'));
    assert.equal(await host.getByTestId('svg-block').count(), 0, 'ordinary code and inline code are not promoted');
  }
  const bad = '<svg width="100" height="100"><rect fill="url(https://blocked.test/a.svg#x)"/></svg>';
  await page.evaluate(source => window.renderSvgAnswer(source), '```xml\n' + bad + '\n```');
  await host.getByTestId('svg-error').waitFor();
  assert.match(await host.getByTestId('svg-error').innerText(), /外部资源/);
  assert.equal(await host.getByTestId('svg-canvas').count(), 0);
  await page.evaluate(() => window.unmountSvgTest());

  // Actual library conversation and persisted history, not just the standalone renderer.
  const answer = '这是一个简单的 SVG 示例：\n\n' + xmlFence + '\n\n可以查看或复制源码。';
  await context.route('https://svg-answer.test/**', route => route.request().postDataJSON()?.stream
    ? route.fulfill({ contentType: 'text/event-stream', body: [...answer].map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('') + 'data: [DONE]\n\n' })
    : route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: 'SVG 示例' } }] } }));
  const composer = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await composer.fill('输出一个 svg 试试看');
  await composer.press('Enter');
  await page.getByTestId('svg-canvas').locator('circle').waitFor();
  await page.waitForFunction(async () => !(await window.__svgImport('/src/store/courseChat.ts')).useCourseChat.getState().loading);
  await page.reload();
  await page.getByTestId('svg-canvas').locator('circle').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: screenshot gradient SVG via svg/xml/unlabelled/html/MIME fences, raw and indented SVG, streaming, source menu, security, mobile layout, actual conversation and history reload.');
} finally { await browser.close(); }
