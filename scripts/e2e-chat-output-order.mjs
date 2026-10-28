import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 950 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    if (window.top !== window) return;
    window.__orderImport = (path) => import(performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path)?.name ?? path);
    if (!localStorage.getItem('wangke-settings')) localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      providers: [{ id: 'test', name: 'Test', baseUrl: 'https://order.test/v1', apiKey: 'test', serves: ['chat'], catalogId: '' }],
      llmModel: { providerId: 'test', model: 'test-model' },
    } }));
    const nativeFetch = window.fetch.bind(window);
    window.__order = { round: 0, release: {}, refs: [] };
    window.fetch = async (input, init) => {
      if (!String(typeof input === 'string' ? input : input.url).includes('order.test')) return nativeFetch(input, init);
      const body = JSON.parse(init.body);
      if (!body.stream) return Response.json({ choices: [{ message: { content: '输出顺序测试' } }] });
      const state = window.__order;
      const round = ++state.round;
      const reference = body.messages.filter(m => m.role === 'tool').map(m => String(m.content).match(/```wbw-widget\n[^\n]+\n```/)?.[0]).find(Boolean);
      const code = '<section><h3>交互题目</h3><input aria-label="临时答案" /><script>document.querySelector("section").dataset.execution=String(Math.random())</script></section>';
      const args = JSON.stringify({ format: 'html', code });
      const call = (name, arguments_, id) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: arguments_ } }] });
      const chunks = round === 1 ? [
        { reasoning_content: '第一段分析' }, { content: '先给你一个初步结论。' },
        call('read', '{"path":"/courses"}', 'read-order'),
      ] : round === 2 ? [
        { reasoning_content: '检索之后继续分析' }, { content: '下面生成交互题目。' },
        call('show_widget', args.slice(0, 80), 'draw-order'),
        { tool_calls: [{ index: 0, function: { arguments: args.slice(80) } }] },
      ] : [
        { reasoning_content: '题目生成后继续分析' }, { content: '这是图卡后的解释。\n\n' },
        { content: reference.slice(0, 12) }, { content: reference.slice(12) },
        { content: '\n\n```html\n<section><h3>后续 HTML</h3></section>\n```\n\n顺序验证完成。' },
      ];
      return new Response(new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          for (let index = 0; index < chunks.length; index++) {
            const gate = `${round}-${index}`;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: chunks[index] }] })}\n\n`));
            await new Promise(resolve => { state.release[gate] = resolve; });
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE);
  const composer = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await composer.fill('检查输出顺序，给出交互题目并解释。');
  await composer.press('Enter');
  const release = async (gate) => {
    await page.waitForFunction(gate => !!window.__order.release[gate], gate);
    await page.evaluate(gate => window.__order.release[gate](), gate);
  };
  await page.getByText('第一段分析', { exact: true }).waitFor();
  await release('1-0');
  await page.getByText('先给你一个初步结论。', { exact: true }).waitFor();
  await release('1-1');
  await release('1-2');
  await page.getByText('检索之后继续分析', { exact: true }).waitFor();
  assert.equal(await page.getByText('先给你一个初步结论。', { exact: true }).count(), 1, 'plain prose survives tool round');
  const before = page.getByText('先给你一个初步结论。', { exact: true });
  assert.ok(await before.evaluate(node => !!(node.compareDocumentPosition([...document.querySelectorAll('.response-process__text')].find(el => el.textContent.includes('检索之后'))) & Node.DOCUMENT_POSITION_FOLLOWING)), 'later process stays after earlier output');
  await release('2-0');
  await page.getByText('下面生成交互题目。', { exact: true }).waitFor();
  await release('2-1');
  await release('2-2');
  await page.getByTestId('widget-stream-preview').waitFor();
  await release('2-3');
  const frame = page.getByTestId('widget-frame').contentFrame();
  await frame.getByRole('heading', { name: '交互题目' }).waitFor();
  const execution = await frame.locator('section').getAttribute('data-execution');
  await frame.getByRole('textbox', { name: '临时答案' }).fill('保留我的输入');
  await page.getByText('题目生成后继续分析', { exact: true }).waitFor();
  await release('3-0');
  await page.getByText('这是图卡后的解释。', { exact: true }).waitFor();
  await release('3-1');
  await release('3-2');
  await release('3-3');
  await page.getByText('顺序验证完成。', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('widget-block').count(), 1, 'model echo does not duplicate a visual');
  assert.equal(await frame.locator('section').getAttribute('data-execution'), execution, 'later references do not remount the visual');
  await release('3-4');
  await page.waitForFunction(async () => !(await window.__orderImport('/src/store/courseChat.ts')).useCourseChat.getState().loading);
  assert.equal(await frame.locator('section').getAttribute('data-execution'), execution, 'persisting the answer does not reset the iframe');
  assert.equal(await frame.getByRole('textbox', { name: '临时答案' }).inputValue(), '保留我的输入');
  assert.equal(await frame.locator('section').evaluate(() => window.__wbw.persistent), true, 'promoted iframe gains persistence without a reload');
  const snapshot = async () => page.locator('.course-chat__bubble--ai').last().evaluate(el => [...el.querySelectorAll('[data-testid="response-process"], p, iframe')]
    .filter(node => node.matches('[data-testid="response-process"], iframe') || !node.closest('.reasoning-chain, [data-testid="widget-block"]'))
    .map(node => node.matches('iframe') ? 'WIDGET' : node.matches('[data-testid="response-process"]') ? 'PROCESS' : node.textContent.trim()).filter(Boolean));
  const ordered = await snapshot();
  assert.ok(ordered.indexOf('下面生成交互题目。') < ordered.indexOf('WIDGET'));
  assert.ok(ordered.indexOf('WIDGET') < ordered.indexOf('这是图卡后的解释。'));
  assert.deepEqual(ordered.slice(0, 9), ['PROCESS', '先给你一个初步结论。', 'PROCESS', '下面生成交互题目。',
    'PROCESS', 'WIDGET', 'PROCESS', '这是图卡后的解释。', '顺序验证完成。']);
  const sessionId = await page.evaluate(async () => (await window.__orderImport('/src/store/courseChat.ts')).useCourseChat.getState().activeId);
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
  await page.reload();
  await page.waitForFunction(async () => (await window.__orderImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  await page.evaluate(async id => (await window.__orderImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(id), sessionId);
  await page.getByTestId('widget-frame').contentFrame().getByRole('heading', { name: '交互题目' }).waitFor();
  assert.deepEqual(await snapshot(), ordered, 'history replays exactly the same process/content order');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS: true incremental stream, text/process/widget chronology, duplicate references, iframe state through persistence, reload and mobile.');
} finally {
  await browser.close();
}
