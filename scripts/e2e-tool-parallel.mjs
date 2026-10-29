import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const sse = (delta, finish_reason = 'stop') => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\ndata: [DONE]\n\n`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    window.__parallelImport = path => {
      const resource = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(resource?.name ?? path);
    };
    if (!localStorage.getItem('wangke-settings')) localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      theme: 'light', providers: [{ id: 'test', name: 'Test', baseUrl: 'https://parallel.test/v1', apiKey: 'test', serves: ['chat'], catalogId: 'siliconflow-cn' }],
      llmModel: { providerId: 'test', model: 'test-model' },
    } }));
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  let requests = 0, results;
  await context.route('https://parallel.test/**', async route => {
    const body = route.request().postDataJSON();
    if (!body.stream) return route.fulfill({ json: { choices: [{ message: { content: '并行读取测试' } }] } });
    if (++requests === 1) {
      await page.evaluate(() => { window.__gateReads = true; });
      return route.fulfill({ contentType: 'text/event-stream', body: sse({ role: 'assistant', tool_calls: [0, 1].map(index => ({
        index, id: `details-${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `/courses/parallel-${index}/info` }) },
      })) }, 'tool_calls') });
    }
    results = body.messages.filter(message => message.role === 'tool');
    return route.fulfill({ contentType: 'text/event-stream', body: sse({ role: 'assistant', content: '两门课程已并行读取完成。' }) });
  });
  await page.goto(BASE);
  await page.evaluate(async () => {
    const { db } = await window.__parallelImport('/src/store/db.ts');
    await db.videos.bulkPut([0, 1].map(i => ({ id: `parallel-${i}`, name: `并行课程 ${i + 1}`, size: 0, mimeType: 'video/mp4', duration: 60, createdAt: Date.now(), status: 'new' })));
    const original = db.videos.get.bind(db.videos);
    window.__readGates = {};
    db.videos.get = async key => {
      if (window.__gateReads && ['parallel-0', 'parallel-1'].includes(key) && !Object.hasOwn(window.__readGates, key)) await new Promise(resolve => { window.__readGates[key] = resolve; });
      return original(key);
    };
  });
  const composer = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await composer.fill('同时读取这两门课程的详情。'); await composer.press('Enter');
  try { await page.waitForFunction(() => Object.keys(window.__readGates).length === 2); }
  catch (error) {
    console.error({ requests, errors, text: await page.locator('body').innerText(), gates: await page.evaluate(() => Object.keys(window.__readGates)) });
    throw error;
  }
  const items = page.getByTestId('tool-trace-item');
  assert.equal(await items.count(), 2);
  assert.equal(await page.locator('[data-testid="tool-trace-item"][data-status="running"]').count(), 2);
  await page.getByText('正在并行调用 2 个工具…', { exact: true }).first().waitFor();
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
  await page.evaluate(() => window.__readGates['parallel-1']());
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="tool-trace-item"]')].map(el => el.dataset.status).join(',') === 'running,done');
  assert.equal(requests, 1, 'model must await all results');
  await page.evaluate(() => { window.__gateReads = false; window.__readGates['parallel-0'](); });
  await page.getByText('两门课程已并行读取完成。', { exact: true }).waitFor();
  await page.waitForFunction(async () => !(await window.__parallelImport('/src/store/courseChat.ts')).useCourseChat.getState().loading);
  assert.deepEqual(results.map(r => r.tool_call_id), ['details-0', 'details-1']);
  const saved = await page.evaluate(async () => {
    const { useCourseChat } = await window.__parallelImport('/src/store/courseChat.ts');
    const { db } = await window.__parallelImport('/src/store/db.ts');
    return db.chats.get(useCourseChat.getState().messages.at(-1).rowId);
  });
  assert.deepEqual(saved.tools.map(t => [t.id, t.status]), [['0:details-0', 'done'], ['0:details-1', 'done']]);
  assert.match(saved.tools[0].result, /并行课程 1/); assert.match(saved.tools[1].result, /并行课程 2/);
  await page.reload();
  await page.waitForFunction(async () => (await window.__parallelImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  await page.evaluate(async session => (await window.__parallelImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(session), saved.sessionId);
  await page.getByText('两门课程已并行读取完成。', { exact: true }).waitFor();
  const reloaded = await page.evaluate(async () => (await window.__parallelImport('/src/store/courseChat.ts')).useCourseChat.getState().messages.at(-1).tools);
  assert.deepEqual(reloaded, saved.tools); assert.deepEqual(errors, []);
  console.log('PASS: two simultaneous Chat tools, reverse completion, correct IDs/results, persistence and reload.');
} finally { await browser.close(); }
