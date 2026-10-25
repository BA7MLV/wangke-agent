import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const base = process.env.BASE_URL || 'http://localhost:5188';
  await page.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.addInitScript(() => {
    if (!localStorage.getItem('wangke-settings')) localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: {
      uiLanguage: 'zh-CN',
      agentInstructions: '',
      providers: [{ id: 'test', name: 'Test', baseUrl: 'https://markdown.test/v1', apiKey: 'fake-test-key', serves: ['chat'], catalogId: '' }],
      llmModel: { providerId: 'test', model: 'test-model' },
    } }));
    window.__markdownTestImport = path => {
      const resource = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(resource?.name ?? path);
    };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.evaluate(async () => {
    const reactModule = await import('/node_modules/.vite/deps/react.js');
    const React = reactModule.default || reactModule;
    const client = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = client.default || client;
    const { Markdown } = await import('/src/components/markdown/Markdown.tsx');
    const host = document.createElement('div');
    host.id = 'markdown-test';
    host.style.cssText = 'position:fixed;inset:0;background:white;padding:16px;overflow:auto;z-index:99999';
    document.body.append(host);
    const root = createRoot(host);
    window.renderMarkdown = (content, streaming) => root.render(React.createElement(Markdown, {
      content, streaming: { hasNextChunk: streaming, tail: streaming },
    }));
  });
  const host = page.locator('#markdown-test');
  for (const source of ['$x_i^2$', '\\(x_i^2\\)', '$$\\frac{a}{b}$$', '\\[\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\\]']) {
    for (let end = 1; end <= source.length; end++) {
      await page.evaluate(({ source, end }) => window.renderMarkdown(`公式：${source.slice(0, end)}`, true), { source, end });
      // Flush React and the library's streaming effect at each character boundary.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (end < source.length) assert.equal(await host.locator('.katex').count(), 0);
    }
    await host.locator('.katex').waitFor();
    assert.equal(await host.locator('math').count(), 1, 'accessible MathML');
    await page.evaluate(source => window.renderMarkdown(`公式：${source}`, false), source);
    await host.locator('.katex').waitFor();
  }
  await page.evaluate(() => window.renderMarkdown('$\\notACommand{x}$', false));
  await host.locator('.md-math-error').waitFor();
  await page.evaluate(() => window.renderMarkdown('$x_i', false));
  await host.locator('.md-math-error').waitFor({ state: 'detached' });
  assert.match(await host.innerText(), /\$x_i/);
  await page.evaluate(() => window.renderMarkdown('| a | b |\n|---|---|\n| $x$ | **bold** |\n\n`$literal$`\n\n$20 and $30', false));
  await host.locator('table .katex').waitFor();
  assert.equal(await host.locator('strong').innerText(), 'bold');
  assert.equal(await host.locator('code').innerText(), '$literal$');
  assert.match(await host.innerText(), /\$20 and \$30/);
  const table = '| 公式 | 说明 |\n|---|---|\n| $|x|$ | 绝对值 |\n| $P(A|B)$ | 条件概率 |\n| $\\|v\\|$ | 范数 |';
  for (const streaming of [true, false]) {
    await page.evaluate(({ table, streaming }) => window.renderMarkdown(table, streaming), { table, streaming });
    const count = streaming ? 2 : 3; // The final row has no newline until generation finishes.
    await page.waitForFunction(count => document.querySelectorAll('#markdown-test td .katex').length === count, count);
    assert.equal(await host.locator('td').count(), count * 2);
    assert.deepEqual(await host.locator('td annotation').allTextContents(), ['|x|', 'P(A|B)', '\\|v\\|'].slice(0, count));
    assert.deepEqual(await host.locator('td:nth-child(2)').allTextContents(), ['绝对值', '条件概率', '范数'].slice(0, count));
  }
  for (const [source, selector, text] of [
    ['**正在输出', 'strong', '正在输出'],
    ['[参考资料](https://exam', 'span', '参考资料'],
    ['`const value', 'code', 'const value'],
  ]) {
    await page.evaluate(source => window.renderMarkdown(source, true), source);
    await page.waitForFunction(text => document.querySelector('#markdown-test')?.textContent?.includes(text), text);
    assert.ok(await host.locator(selector).count());
    assert.equal(await host.locator('a').count(), 0, 'no incomplete URL navigation');
  }
  assert.deepEqual(errors, []);
  console.log('Browser streaming Markdown: character splits, KaTeX, MathML, errors, stop, table and code passed.');

  // Exercise both actual Chat pipelines, including table components and persisted history.
  const answer = ['$x_i^2$', '\\(x_i^2\\)', '$$\\frac{a}{b}$$', '\\[\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\\]', table].join('\n\n');
  await page.route('https://markdown.test/**', route => {
    if (!route.request().postDataJSON()?.stream) return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: '公式测试' } }] } });
    const chunks = [...answer].map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('');
    return route.fulfill({ contentType: 'text/event-stream', body: `${chunks}data: [DONE]\n\n` });
  });
  const checkChat = async selector => {
    await page.waitForFunction(selector => document.querySelectorAll(`${selector} .katex`).length === 7, selector);
    const messages = page.locator(selector);
    assert.equal(await messages.locator('math').count(), 7);
    assert.equal(await messages.locator('.md-math-error').count(), 0);
    assert.deepEqual(await messages.locator('td annotation').allTextContents(), ['|x|', 'P(A|B)', '\\|v\\|']);
  };
  await page.goto(`${base}/#/`);
  const libraryInput = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await libraryInput.fill('展示这些公式。');
  await libraryInput.press('Enter');
  await checkChat('[data-testid="course-chat-messages"]');
  await page.waitForFunction(async () => !(await window.__markdownTestImport('/src/store/courseChat.ts')).useCourseChat.getState().loading);
  await page.reload();
  await checkChat('[data-testid="course-chat-messages"]');
  await page.evaluate(async () => {
    const { saveMarkdownMaterial } = await window.__markdownTestImport('/src/materials/markdownFile.ts');
    await saveMarkdownMaterial('math-chat-material', '# 公式测试\n\n用于验证普通 Markdown 阅读与问答。', '', '公式测试.md');
    location.hash = '/player/math-chat-material';
  });
  await page.getByTestId('md-edit-toggle').click();
  await page.getByTestId('md-editor').locator('.cm-content').fill('# 修改后的 Markdown\n\n普通文件仍然保存。');
  await page.getByTestId('md-edit-toggle').click();
  await page.getByTestId('material-reader').getByText('普通文件仍然保存。', { exact: true }).waitFor();
  const stored = await page.evaluate(async () => {
    const { getMaterialFile } = await window.__markdownTestImport('/src/store/fileStore.ts');
    const { db } = await window.__markdownTestImport('/src/store/db.ts');
    return { text: await (await getMaterialFile('math-chat-material')).text(),
      blocks: await db.materialBlocks.where('materialId').equals('math-chat-material').toArray(),
      instructions: JSON.parse(localStorage.getItem('wangke-settings')).state.agentInstructions };
  });
  assert.match(stored.text, /普通文件仍然保存/);
  assert.ok(stored.blocks.some(block => block.text.includes('普通文件仍然保存')));
  assert.equal(stored.instructions, '');
  await page.getByRole('button', { name: '打开学习助手', exact: true }).click();
  const materialInput = page.getByRole('textbox', { name: '给学习助手发送消息' });
  await materialInput.fill('展示这些公式。');
  await materialInput.press('Enter');
  await checkChat('[data-testid="chat-list"]');
  await page.getByTestId('chat-stop').waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('button', { name: '打开学习助手', exact: true }).click();
  await checkChat('[data-testid="chat-list"]');
  assert.deepEqual(errors, []);
  console.log('Library and material Chat: all delimiters, TeX pipes in tables and history reload passed; ordinary Markdown saving/reindexing passed.');
} finally {
  await browser.close();
}
