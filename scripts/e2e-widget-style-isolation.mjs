import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Disposable browser storage and a fake edit model: no user chats or API tokens.
await mkdir(new URL('../e2e-shots/', import.meta.url), { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  const errors = [], requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    if (window.top !== window) return;
    window.__styleTestImport = (path) => {
      const resource = performance.getEntriesByType('resource').findLast((entry) => new URL(entry.name).pathname === path);
      return import(resource?.name ?? path);
    };
    if (!localStorage.getItem('wangke-settings')) localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      theme: 'light', fontScale: 'standard', accentColor: 'blue',
      providers: [{ id: 'test', name: 'Test', baseUrl: 'https://style.test/v1', apiKey: 'test', serves: ['chat'], catalogId: 'siliconflow-cn' }],
      llmModel: { providerId: 'test', model: 'test-model' },
    } }));
  });
  await page.route('https://style.test/**', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: JSON.stringify({ edits: [{ search: '第一幅交互图', replace: '局部修改预览' }] }) } }] } });
  });
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).waitFor();
  await page.waitForFunction(async () => (await window.__styleTestImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  // Isolation must not silently flatten the surrounding prose. Compare safe
  // Markdown geometry against the library's original defaults in the same app.
  await page.evaluate(async () => {
    const React = (await window.__styleTestImport('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await window.__styleTestImport('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { XMarkdown } = await window.__styleTestImport('/node_modules/.vite/deps/@ant-design_x-markdown.js');
    const { Markdown } = await window.__styleTestImport('/src/components/markdown/Markdown.tsx');
    const host = document.createElement('div');
    host.id = 'prose-style-comparison';
    host.hidden = true;
    document.body.append(host);
    const content = '段落一\n\n段落二 `inline`\n\n- one\n- two\n\n```js\nconst x = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---';
    const root = createRoot(host);
    root.render(React.createElement('div', null,
      React.createElement('div', { id: 'scoped-prose' }, React.createElement(Markdown, { content })),
      React.createElement('div', { id: 'original-prose' }, React.createElement(XMarkdown, { content }))));
    window.__proseStyleRoot = root;
  });
  await page.locator('#scoped-prose hr').waitFor({ state: 'attached' });
  const proseStyles = await page.evaluate(() => ['scoped-prose', 'original-prose'].map((id) =>
    [...document.getElementById(id).querySelectorAll('p, ul, li, pre, code, table, th, td, hr')].map((el) => {
      const style = getComputedStyle(el);
      return { tag: el.tagName, ...Object.fromEntries(['margin', 'padding', 'font-size', 'line-height', 'border-radius', 'display', 'list-style-type'].map((key) => [key, style.getPropertyValue(key)])) };
    })));
  assert.deepEqual(proseStyles[0], proseStyles[1], 'prose spacing, lists, code and tables retain their existing appearance');
  await page.evaluate(() => { window.__proseStyleRoot.unmount(); document.getElementById('prose-style-comparison').remove(); });
  const initial = '先观察参数，再对照结果。';
  const { rowId, sessionId } = await page.evaluate(async (content) => {
    const { db } = await window.__styleTestImport('/src/store/db.ts');
    const { useCourseChat } = await window.__styleTestImport('/src/store/courseChat.ts');
    const sessionId = await db.chatSessions.add({ videoId: '__library_assistant__', title: '样式隔离回归', createdAt: Date.now() });
    const rowId = await db.chats.add({ sessionId, videoId: '__library_assistant__', role: 'assistant', content, createdAt: Date.now() });
    await useCourseChat.getState().loadSession(sessionId);
    return { rowId, sessionId };
  }, initial);
  await page.getByText(initial, { exact: true }).waitFor();
  const mainStyles = () => page.evaluate(() => Object.fromEntries(['body', '.course-chat__composer', '.course-chat', 'textarea[aria-label="给 AI 助手发送消息"]'].map((selector) => {
    const style = getComputedStyle(document.querySelector(selector));
    return [selector, Object.fromEntries(['color', 'background-color', 'font-family', 'font-size', 'opacity', 'position', '--style-escape'].map((key) => [key, style.getPropertyValue(key)]))];
  })));
  const baseline = await mainStyles();
  const css = 'body { --style-escape: escaped; } .course-chat__composer { opacity: .2 !important; } textarea { color: rgb(255, 0, 0) !important; }';
  const raw = `${initial}\n\n<div><style>${css}</style><aside id="chat-override" class="fixed inset-0 dark course-chat__composer" data-theme="dark" style="position:fixed;inset:0;color:red">类名不能覆盖聊天</aside></div>`;
  // Real chat renderer, with tags and CSS split across stream updates.
  for (const end of [raw.indexOf('<style') + 4, raw.indexOf('<style') + 7, raw.indexOf('</style>'), raw.indexOf('</style>') + 8, raw.length]) {
    await page.evaluate(async (content) => {
      const { useCourseChat } = await window.__styleTestImport('/src/store/courseChat.ts');
      useCourseChat.setState((state) => ({ messages: state.messages.map((message) => ({ ...message, content, streaming: true })) }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, raw.slice(0, end));
    assert.deepEqual(await mainStyles(), baseline, `stream prefix ${end} cannot style the host`);
  }
  const widget = (title, styled) => `<section id="explorer"><h3>${title}</h3><label>系数<input type="range" min="1" max="5" value="2"></label><p>参数变化只在此图重绘。</p></section>${styled ? '<style>body { --style-escape: inside-frame; } p { color: rgb(21, 128, 61); } button, textarea { font-size: 36px; } .course-chat__composer { opacity: .1; }</style>' : ''}<script>document.querySelector('section').dataset.run = String(Math.random());</script>`;
  const widgets = [{ id: 'style-first', ref: 'style-first-ref', html: widget('第一幅交互图', true) }, { id: 'style-second', ref: 'style-second-ref', html: widget('第二幅交互图', false) }];
  const fence = (lang, source) => '```' + lang + '\n' + source + '\n```';
  const content = [raw,
    `<div><svg><style>${css}</style><text>SVG 旁路</text></svg><math><mtext><style>${css}</style>MathML 旁路</mtext></math><strong>语义强调仍保留</strong></div>`,
    '公式仍正常：$x^2 + 1$。', fence('wbw-widget', 'style-first-ref'),
    '调整下面的系数，对照两个结果。', fence('wbw-widget', 'style-second-ref'),
    fence('html', `<div><style>${css}</style><p class="fixed inset-0" style="position:fixed">静态预览不执行样式</p></div>`),
    '| 参数 | 值 |\n| --- | ---: |\n| a | 2 |', fence('js', 'const coefficient = 2;'),
  ].join('\n\n');
  await page.evaluate(async ({ rowId, sessionId, content, widgets }) => {
    const { db } = await window.__styleTestImport('/src/store/db.ts');
    await db.chats.update(rowId, { content, widgets, widget: widgets.at(-1) });
    const { useCourseChat } = await window.__styleTestImport('/src/store/courseChat.ts');
    useCourseChat.setState({ loaded: false });
    await useCourseChat.getState().loadSession(sessionId);
  }, { rowId, sessionId, content, widgets });
  const blocks = page.locator('[data-testid="editable-artifact"] > [data-testid="widget-block"]');
  const first = () => blocks.nth(0).getByTestId('widget-frame').contentFrame();
  const second = () => blocks.nth(1).getByTestId('widget-frame').contentFrame();
  await first().getByRole('slider').waitFor();
  await second().getByRole('slider').waitFor();
  assert.equal(await blocks.count(), 2);
  assert.deepEqual(await mainStyles(), baseline, 'mixed raw HTML, SVG, MathML, previews and widgets cannot style the chat');
  const rawElement = page.locator('aside').filter({ hasText: /^类名不能覆盖聊天$/ });
  for (const attr of ['class', 'style', 'id', 'data-theme']) assert.equal(await rawElement.getAttribute(attr), null, `${attr} is not a host styling hook`);
  assert.equal(await page.locator('.x-markdown style, .x-markdown link').count(), 0);
  assert.equal(await page.locator('strong').getByText('语义强调仍保留', { exact: true }).count(), 1);
  await page.locator('.katex').waitFor();
  await page.getByTestId('widget-stream-preview').getByText('静态预览不执行样式', { exact: true }).waitFor();
  const table = page.getByTestId('md-table').locator('table');
  assert.equal(await table.evaluate((el) => getComputedStyle(el).display), 'table', 'scoped Markdown retains full-width table layout');
  assert.equal(await table.evaluate((el) => getComputedStyle(el).borderTopWidth), '2px');
  assert.equal(await first().locator('body').evaluate((el) => getComputedStyle(el).getPropertyValue('--style-escape').trim()), 'inside-frame', 'widget CSS still runs inside its own document');
  assert.equal(await second().locator('body').evaluate((el) => getComputedStyle(el).getPropertyValue('--style-escape').trim()), '', 'widget styles do not cross to siblings');
  const siblingToken = await second().locator('section').getAttribute('data-run');
  await blocks.first().getByTestId('widget-more').click();
  await page.getByTestId('widget-edit').click();
  const panel = page.getByTestId('artifact-edit-panel');
  const description = panel.getByText('先看效果，再决定是否替换。其他正文和图形不变。', { exact: true });
  assert.deepEqual(await description.evaluate((el) => ({ top: getComputedStyle(el).marginTop, bottom: getComputedStyle(el).marginBottom, size: getComputedStyle(el).fontSize })), { top: '4px', bottom: '0px', size: '12px' }, 'editor keeps its own spacing, not Markdown paragraph margins');
  await panel.getByRole('textbox', { name: '修改要求', exact: true }).fill('只改此图标题');
  await panel.getByRole('button', { name: '生成局部修改', exact: true }).click();
  await panel.getByTestId('artifact-edit-preview').getByTestId('widget-frame').contentFrame().getByText('局部修改预览', { exact: true }).waitFor();
  assert.equal(requests.length, 1);
  await panel.getByText('查看修改前后源码', { exact: true }).click();
  const sourceStyle = await panel.locator('pre').first().evaluate((el) => ({ margin: getComputedStyle(el).margin, padding: getComputedStyle(el).padding, background: getComputedStyle(el).backgroundColor }));
  assert.deepEqual(sourceStyle, { margin: '0px', padding: '0px', background: 'rgba(0, 0, 0, 0)' }, 'source comparison does not inherit chat code-block chrome');
  await panel.getByText('查看修改前后源码', { exact: true }).click();
  assert.deepEqual(await mainStyles(), baseline, 'opening and generating an edit never changes composer styles');
  assert.equal(await second().locator('section').getAttribute('data-run'), siblingToken);
  await panel.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.screenshot({ path: 'e2e-shots/widget-style-isolation-desktop.png' });
  await page.evaluate(async () => (await window.__styleTestImport('/src/store/settings.ts')).useSettings.getState().update({ theme: 'dark' }));
  await first().locator('html[data-wbw-theme="dark"]').waitFor();
  const darkBaseline = await mainStyles();
  const withoutResponsiveFontSize = (styles) => Object.fromEntries(Object.entries(styles).map(([selector, values]) =>
    [selector, Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'font-size'))]));
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    await panel.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px has no host overflow`);
    // Mobile deliberately raises editable text to 16px to prevent browser zoom.
    assert.deepEqual(withoutResponsiveFontSize(await mainStyles()), withoutResponsiveFontSize(darkBaseline), `${width}px keeps the host palette and visibility`);
    if (width === 390) await page.screenshot({ path: 'e2e-shots/widget-style-isolation-mobile.png' });
  }
  const beforeReload = await mainStyles();
  await page.reload();
  await page.waitForFunction(async () => (await window.__styleTestImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  await page.evaluate(async (id) => (await window.__styleTestImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(id), sessionId);
  await first().getByRole('slider').waitFor();
  assert.deepEqual(await mainStyles(), beforeReload, 'history remains isolated after refresh');
  const stored = await page.evaluate(async (id) => (await window.__styleTestImport('/src/store/db.ts')).db.chats.get(id), rowId);
  assert.equal(stored.content, content, 'presentation sanitization never rewrites stored prose');
  assert.equal(stored.widgets[0].html, widgets[0].html, 'preview never auto-applies');
  assert.deepEqual(errors, []);
  console.log('PASS: streamed/history CSS injection blocked; raw styling hooks removed; independent iframe styles; prose math/tables preserved; editor spacing/source chrome isolated; preview and refresh safe; 320/390/768px light/dark layout.');
} finally { await browser.close(); }
