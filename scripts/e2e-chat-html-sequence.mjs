import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const sse = (delta, finish_reason = 'stop') => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\ndata: [DONE]\n\n`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    if (window.top !== window) return;
    window.__htmlTestImport = (path) => {
      const resource = performance.getEntriesByType('resource').findLast((entry) => new URL(entry.name).pathname === path);
      return import(resource?.name ?? path);
    };
    if (!localStorage.getItem('wangke-settings')) localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      theme: 'light', providers: [{ id: 'test', name: 'Test', baseUrl: 'https://html-sequence.test/v1', apiKey: 'test', serves: ['chat'], catalogId: 'siliconflow-cn' }],
      llmModel: { providerId: 'test', model: 'test-model' },
    } }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let mode = 'mixed', requests = 0;
  const mixed = '```html\n<div><h3>HTML 第一题</h3><p>1 + 1 = ?</p></div>\n```\n\n第一题的讲解。\n\n~~~html\n<div><h3>HTML 第二题</h3><p>2 + 2 = ?</p></div>\n~~~\n\n第二题的讲解。\n\n<section><h3>HTML 第三题</h3><p>3 + 3 = ?</p></section>\n\n三道题全部输出完成。';
  await context.route('https://html-sequence.test/**', async (route) => {
    const body = route.request().postDataJSON();
    if (!body.stream) return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: '连续 HTML 练习' } }] } });
    requests++;
    if (mode === 'mixed') return route.fulfill({ contentType: 'text/event-stream', body: sse({ role: 'assistant', content: mixed }) });
    if (mode === 'raw-rounds') {
      const number = body.messages.filter((message) => message.role === 'tool').length + 1;
      const question = `<div><h3>连续 HTML 第 ${number} 题</h3></div>`;
      const content = `${number === 2 ? `\`\`\`html\n${question}\n\`\`\`` : question}\n\n第 ${number} 题说明。${number === 3 ? '\n\n分轮出题完成。' : ''}`;
      return route.fulfill({ contentType: 'text/event-stream', body: number === 3 ? sse({ role: 'assistant', content }) : sse({ role: 'assistant', content,
        tool_calls: [{ index: 0, id: `read-${number}`, type: 'function', function: { name: 'grep', arguments: JSON.stringify({ query: `question-${number}` }) } }],
      }, 'tool_calls') });
    }
    const refs = body.messages.filter((message) => message.role === 'tool').flatMap((message) => [...String(message.content).matchAll(/```wbw-widget\n[^\n]+\n```/g)].map((match) => match[0]));
    const number = refs.length + 1;
    const content = refs.length ? `第 ${refs.length} 题讲解。\n\n${refs.at(-1)}\n\n${refs.length === 3 ? '连续出题完成。' : '继续下一题。'}` : '';
    return route.fulfill({ contentType: 'text/event-stream', body: refs.length === 3 ? sse({ role: 'assistant', content }) : sse({ role: 'assistant', content,
      tool_calls: [{ index: 0, id: `question-${number}`, type: 'function', function: { name: 'show_widget', arguments: JSON.stringify({ format: 'html', code: `<section><h3>交互第 ${number} 题</h3><input aria-label="答案 ${number}" /></section>` }) } }],
    }, 'tool_calls') });
  });
  await page.goto(BASE);
  const composer = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await composer.fill('连续输出三道 HTML 题，中间加上讲解。');
  await composer.press('Enter');
  await page.getByText('三道题全部输出完成。', { exact: true }).waitFor();
  const waitDone = () => page.waitForFunction(async () => !(await window.__htmlTestImport('/src/store/courseChat.ts')).useCourseChat.getState().loading);
  await waitDone();
  const htmlAnswers = page.getByTestId('html-answer');
  for (const [index, title] of ['HTML 第一题', 'HTML 第二题', 'HTML 第三题'].entries())
    await htmlAnswers.nth(index).getByTestId('widget-frame').contentFrame().getByText(title, { exact: true }).waitFor();
  assert.equal(await htmlAnswers.count(), 3, 'leading fenced HTML cannot consume later questions');
  assert.equal(await page.locator('.widget-stream-preview__status').count(), 0, 'completed questions are not marked as generating');
  const ordered = [htmlAnswers.nth(0), page.getByText('第一题的讲解。', { exact: true }), htmlAnswers.nth(1),
    page.getByText('第二题的讲解。', { exact: true }), htmlAnswers.nth(2), page.getByText('三道题全部输出完成。', { exact: true })];
  for (let index = 1; index < ordered.length; index++) {
    assert.ok((await ordered[index - 1].boundingBox()).y < (await ordered[index].boundingBox()).y, 'HTML and prose retain their visual order');
  }
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
  const firstSession = await page.evaluate(async () => (await window.__htmlTestImport('/src/store/courseChat.ts')).useCourseChat.getState().activeId);
  await page.reload();
  await page.waitForFunction(async () => (await window.__htmlTestImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  await page.evaluate(async (id) => (await window.__htmlTestImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(id), firstSession);
  await htmlAnswers.nth(2).getByTestId('widget-frame').contentFrame().getByText('HTML 第三题', { exact: true }).waitFor();
  assert.equal(await htmlAnswers.count(), 3, 'refresh retains all three questions');

  mode = 'widgets';
  requests = 0;
  await page.evaluate(async () => (await window.__htmlTestImport('/src/store/courseChat.ts')).useCourseChat.getState().createSession());
  await composer.fill('按顺序出三道交互题，每道之后继续讲解并出下一题。');
  await composer.press('Enter');
  await page.getByText('连续出题完成。', { exact: true }).waitFor();
  await waitDone();
  const blocks = page.getByTestId('widget-block');
  for (let index = 0; index < 3; index++) {
    await blocks.nth(index).getByTestId('widget-frame').contentFrame().getByRole('heading', { name: `交互第 ${index + 1} 题` }).waitFor();
    assert.equal(await page.getByText(`第 ${index + 1} 题讲解。`, { exact: true }).count(), 1, 'later rounds cannot clear or duplicate earlier explanations');
  }
  assert.equal(await blocks.count(), 3, 'three successive HTML tool rounds render three independent questions');
  assert.equal(requests, 4, 'HTML output does not terminate the agent loop');
  const row = await page.evaluate(async () => {
    const { useCourseChat } = await window.__htmlTestImport('/src/store/courseChat.ts');
    return (await window.__htmlTestImport('/src/store/db.ts')).db.chats.get(useCourseChat.getState().messages.at(-1).rowId);
  });
  assert.equal(row.widgets.length, 3);
  for (let number = 1; number <= 3; number++) assert.ok(row.content.includes(`第 ${number} 题讲解。`));

  mode = 'raw-rounds';
  requests = 0;
  await page.evaluate(async () => (await window.__htmlTestImport('/src/store/courseChat.ts')).useCourseChat.getState().createSession());
  await composer.fill('分三轮连续出 HTML 题，不要清空前面的题。');
  await composer.press('Enter');
  await page.getByText('分轮出题完成。', { exact: true }).waitFor();
  await waitDone();
  for (let number = 1; number <= 3; number++) await htmlAnswers.nth(number - 1).getByTestId('widget-frame').contentFrame().getByText(`连续 HTML 第 ${number} 题`, { exact: true }).waitFor();
  assert.equal(await htmlAnswers.count(), 3, 'raw/fenced HTML remains visible across retrieval rounds');
  assert.equal(requests, 3);

  const qa = await page.evaluate(async () => {
    const { runQa } = await window.__htmlTestImport('/src/harness/qaRunner.ts');
    let content = '';
    const result = await runQa({ videoId: 'html-sequence-course', sessionId: 7000, text: '连续三道 HTML 题。' }, {
      onRoundStart: () => { content = ''; },
      onDelta: (delta) => { content += delta; },
    });
    let appended = '';
    const appendResult = await runQa({ videoId: 'html-sequence-course', sessionId: 7001, text: '连续三道 HTML 题。' }, {
      onDelta: (delta) => { appended += delta; },
    });
    return { result, streamed: content, appended, appendResult };
  });
  for (let number = 1; number <= 3; number++) assert.ok(qa.result.content.includes(`连续 HTML 第 ${number} 题`), 'course runner also persists all earlier HTML');
  assert.equal(qa.streamed.trim(), qa.result.content, 'course progress and final content agree across rounds');
  assert.equal(qa.appended.trim(), qa.appendResult.content, 'append-only sinks do not receive duplicated prefixes');
  assert.deepEqual(errors, []);
  console.log('PASS: three mixed HTML questions, ordered prose, refresh, three widget rounds, raw HTML across retrieval rounds, and course runner persistence/progress.');
} finally {
  await browser.close();
}
