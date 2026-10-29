import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5188';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, reducedMotion: 'reduce' });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = [];
  const external = [];
  await page.route('https://blocked.test/**', route => { external.push(route.request().url()); return route.abort(); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.evaluate(async () => {
    // Reuse Vite's loaded module URLs after HMR, especially the shared edit context.
    const load = path => {
      const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(entry?.name ?? path);
    };
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { default: AssistantContent } = await load('/src/components/AssistantContent.tsx');
    const { ArtifactEditProvider } = await load('/src/components/ArtifactEditor.tsx');
    const { default: ResponseProcess } = await load('/src/components/ResponseProcess.tsx');
    const { Markdown } = await load('/src/components/markdown/Markdown.tsx');
    const { MarkdownCode, MarkdownPre } = await load('/src/components/mermaid/markdown.tsx');
    const { db } = await load('/src/store/db.ts');
    const { openLegacyHtmlWork } = await load('/src/store/legacyHtmlWorks.ts');
    window.legacyCache = async source => {
      const [first, second] = await Promise.all([openLegacyHtmlWork(source, 991), openLegacyHtmlWork(source, 991)]);
      return { first, second, row: await db.chats.get(991) };
    };
    await db.chats.put({ id: 991, sessionId: 991, videoId: 'html-test', role: 'assistant', content: '', createdAt: Date.now() });
    const host = document.createElement('div');
    host.id = 'html-answer-test';
    document.getElementById('root').style.display = 'none';
    host.style.cssText = 'position:relative;background:var(--background);padding:24px;overflow:auto';
    document.body.append(host);
    const root = ReactDOM.createRoot(host, { identifierPrefix: 'html-answer-test-' });
    window.renderHtmlAnswer = async (source, streaming = false, directMarkdown = false) => {
      await db.chats.update(991, { content: source });
      root.render(React.createElement(ArtifactEditProvider, { rowId: 991, content: source, disabled: streaming, onSaved: () => {} },
      React.createElement(ResponseProcess, { reasoning: '1. **分析请求**：展示 HTML 示例。\n2. **注意**：不编造课程数据。\n\n```html\n<button>仅为思考源码</button>\n```', streaming }),
      directMarkdown ? React.createElement(Markdown, { content: source, components: { code: MarkdownCode, pre: MarkdownPre } })
        : React.createElement(AssistantContent, { content: source, streaming }, text => React.createElement(Markdown, { content: text, components: { code: MarkdownCode, pre: MarkdownPre } }))));
    };
  });
  const source = '<!doctype html><html><head><style>body { color: rgb(12, 34, 56); } .example { display: grid; gap: 12px; background: rgb(225, 240, 250); padding: 24px; } h1 { font-size: 28px; }</style></head><body><main class="example"><h1>HTML 样式正常</h1><p>这是演示，不是真实课程数据。</p><button onclick="document.body.dataset.executed=2">交互按钮</button><a href="https://blocked.test/">禁止外部导航</a></main><script>document.body.dataset.executed=1</script><meta http-equiv="refresh" content="0;url=https://blocked.test/"></body></html>';
  const answer = `这里是 HTML 作品：\n\n\`\`\`html interactive\n${source}\n\`\`\`\n\n后续说明不丢失。`;
  await page.evaluate(source => window.renderHtmlAnswer(source, true), '```html interactive\n<style>body{color:red}</style><main><h1>生成中的示例</h1>');
  await page.getByTestId('widget-stream-preview').getByText('生成中的示例').waitFor();
  assert.equal(await page.getByTestId('widget-frame').count(), 0, 'partial code is inert');
  await page.evaluate(source => window.renderHtmlAnswer(source), `\`\`\`html\n${source}\n\`\`\``);
  await page.locator('#html-answer-test pre code').filter({ hasText: '<!doctype html>' }).waitFor();
  assert.equal(await page.getByTestId('widget-frame').count(), 0, 'ordinary source examples never create an iframe');
  assert.equal(await page.getByRole('button', { name: '运行交互', exact: true }).count(), 0);
  await page.evaluate(source => window.renderHtmlAnswer(source), answer);
  await page.getByText('后续说明不丢失。', { exact: true }).waitFor();
  const frame = page.getByTestId('html-answer').getByTestId('widget-frame');
  const content = frame.contentFrame();
  await content.getByRole('heading', { name: 'HTML 样式正常' }).waitFor();
  assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
  assert.deepEqual(await content.locator('.example').evaluate(el => {
    const style = getComputedStyle(el);
    return [style.display, style.backgroundColor, style.padding, style.color];
  }), ['grid', 'rgb(225, 240, 250)', '24px', 'rgb(12, 34, 56)']);
  assert.equal(await content.locator('body').getAttribute('data-executed'), '1');
  const cache = await page.evaluate(source => window.legacyCache(source), source);
  assert.equal(cache.first.id, cache.second.id, 'concurrent legacy adaptation is idempotent');
  assert.equal(cache.row.legacyHtmlWorks.length, 1);
  assert.equal(cache.first.source, 'legacy-html');
  assert.equal(cache.row.content, answer, 'normalization preserves original message source');
  await content.getByRole('button').click();
  assert.equal(await content.locator('body').getAttribute('data-executed'), '2');
  assert.equal(await content.locator('a').getAttribute('href'), null);
  assert.ok(await content.locator('body').evaluate(() => { try { return !parent.document.body; } catch { return true; } }));
  assert.notEqual(await page.locator('body').evaluate(el => getComputedStyle(el).color), 'rgb(12, 34, 56)', 'CSS cannot leak into host');
  const more = page.getByTestId('html-answer').getByRole('button', { name: '更多 HTML 操作' });
  assert.equal(await page.getByRole('button', { name: '复制 HTML', exact: true }).count(), 0, 'no loose HTML action buttons');
  assert.equal(await page.getByRole('button', { name: '修改此 HTML', exact: true }).count(), 0);
  await more.click();
  const menu = page.getByRole('menu');
  for (const name of ['在新页面打开', '修改 HTML', '复制 HTML', '查看 HTML 源码']) {
    await menu.getByRole('menuitem', { name, exact: true }).waitFor();
    assert.equal(await menu.getByRole('menuitem', { name, exact: true }).locator('svg').count(), 1, `${name} has an icon and label`);
  }
  if (process.env.MENU_SCREENSHOT_PATH) await page.screenshot({ path: process.env.MENU_SCREENSHOT_PATH });
  await menu.getByRole('menuitem', { name: '复制 HTML', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source, 'copy preserves untouched original source');
  await more.click();
  const popupEvent = page.waitForEvent('popup');
  await menu.getByRole('menuitem', { name: '在新页面打开', exact: true }).click();
  const popup = await popupEvent;
  const popupFrame = popup.getByTestId('widget-frame').contentFrame();
  await popupFrame.getByRole('heading', { name: 'HTML 样式正常' }).waitFor();
  await popup.getByRole('heading', { name: 'HTML 预览', exact: true }).waitFor();
  assert.equal(await popup.evaluate(() => window.opener), null);
  assert.equal(await popupFrame.locator('body').getAttribute('data-executed'), '1', 'popout runs the same isolated work');
  assert.equal(await popupFrame.locator('a').getAttribute('href'), null);
  assert.ok(!popup.url().includes('doctype') && !popup.url().includes('HTML%20'), 'source is not exposed in the URL');
  await popup.close();
  await more.click();
  await menu.getByRole('menuitem', { name: '查看 HTML 源码', exact: true }).click();
  assert.equal(await page.getByTestId('html-answer-source').textContent(), source, 'source remains complete and unmodified');
  assert.equal(page.context().pages().length, 1, 'source expands in the original message, not another page');
  await more.click();
  await menu.getByRole('menuitem', { name: '收起 HTML 源码', exact: true }).click();
  assert.equal(await page.getByTestId('html-answer-source').count(), 0);
  await more.click();
  await menu.getByRole('menuitem', { name: '修改 HTML', exact: true }).click();
  await page.getByRole('textbox', { name: '修改要求', exact: true }).waitFor();
  await page.getByTestId('artifact-edit-panel').getByRole('button', { name: '收起', exact: true }).click();
  await page.getByTestId('response-process-toggle').click();
  const reasoning = page.locator('.response-process__text');
  assert.equal(await reasoning.locator('strong').first().innerText(), '分析请求');
  assert.equal(await reasoning.locator('ol > li').count(), 2);
  assert.equal(await reasoning.getByTestId('widget-frame').count(), 0, 'reasoning never executes HTML fences');
  for (const width of [390, 1100]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.locator('#html-answer-test').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  }
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
  // The shared code renderer and raw HTML path must agree with the chat splitter.
  await page.evaluate(source => window.renderHtmlAnswer(source, false, true), `\`\`\`html interactive\n${source}\n\`\`\``);
  await content.getByRole('heading', { name: 'HTML 样式正常' }).waitFor();
  await page.evaluate(source => window.renderHtmlAnswer(source), source);
  await page.getByTestId('html-code-example').waitFor();
  assert.equal(await page.getByTestId('widget-frame').count(), 0, 'bare HTML is escaped source, not an execution declaration');
  for (const direct of [false, true]) {
    const malicious = '<svg onload="parent.__escaped = true"><script>parent.__escaped = true</script></svg><img src="https://blocked.test/x" onerror="parent.__escaped = true">';
    await page.evaluate(({ source, direct }) => window.renderHtmlAnswer(source, false, direct), { source: `\`\`\`html\n${malicious}\n\`\`\``, direct });
    await page.locator('#html-answer-test pre code').filter({ hasText: '<svg onload=' }).waitFor();
    assert.equal(await page.getByTestId('widget-frame').count(), 0);
    assert.equal(await page.evaluate(() => window.__escaped), undefined);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, [], 'examples, normalization and ordinary code never load external resources');
  console.log('PASS: explicit interactive works, inert examples/streaming/reasoning, untouched source, isolated CSS, raw/fenced/popout renderers, mobile/desktop layout.');
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: 'test-results/html-answer-failure.png' });
    console.error((await page.locator('body').innerText()).slice(-5000));
    console.error(await page.locator('body').ariaSnapshot());
  }
  throw error;
} finally { await browser.close(); }
