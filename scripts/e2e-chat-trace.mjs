// HeroUI 统一处理过程：脚本化 SSE，不访问真实模型、不消耗 API 配额。
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

await page.addInitScript(() => {
  localStorage.setItem('wangke-settings', JSON.stringify({ state: {
    providers: [{ id: 'sf', name: '测试接口', baseUrl: 'https://sf.test/v1', apiKey: 'test-key', serves: ['chat'], catalogId: '' }],
    llmModel: { providerId: 'sf', model: 'test-model' }, contextWindow: 32768, agentRounds: 6,
  }, version: 2 }));
  const nativeFetch = window.fetch.bind(window);
  window.__LLM__ = { queue: [] };
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('/chat/completions')) return nativeFetch(input, init);
    const step = window.__LLM__.queue.shift() ?? { chunks: [{ content: '测试回答' }] };
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      async start(controller) {
        for (const delta of step.chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
          if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
});

try {
  await page.goto(`${BASE}/#/chat`);
  await page.getByTestId('course-chat-page').waitFor();
  await page.evaluate(() => {
    window.__LLM__.queue.push(
      { delayMs: 350, chunks: [
        ...Array.from({ length: 4 }, () => ({ reasoning_content: '先查看课程列表。' })),
        { tool_calls: [{ index: 0, id: 'read-courses', type: 'function', function: { name: 'read', arguments: '{"path":"/courses"}' } }] },
      ] },
      { delayMs: 350, chunks: [
        ...Array.from({ length: 4 }, () => ({ reasoning_content: '根据查询结果整理建议。' })),
        { content: '课程列表已检查。' }, { content: '你可以先导入课程，' }, { content: '再按学习目标安排进度。' },
      ] },
    );
  });
  const field = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await field.fill('看看我的课程，再给学习建议');
  await field.press('Enter');
  const process = page.getByTestId('response-process').last();
  const toggle = process.getByTestId('response-process-toggle');
  await toggle.waitFor();
  assert.match(await toggle.innerText(), /正在分析问题/);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', '默认紧凑，不铺开推理正文');
  await toggle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'HeroUI 支持键盘展开');
  const analysisToggle = process.locator('.response-process__analysis-toggle').first();
  await analysisToggle.click();
  assert.match(await process.locator('[aria-label="分析记录"]').first().innerText(), /先查看课程列表/);

  await page.waitForFunction(() => document.querySelectorAll('.response-process__analysis').length === 2);
  assert.match(await toggle.innerText(), /正在分析问题/, '工具结束后继续分析，不根据正文猜状态');
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="response-process"]');
    return node && !node.hasAttribute('data-streaming');
  });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', '完成时不收起用户手动展开的过程');
  const kinds = await process.locator('.response-process__steps > li').evaluateAll((nodes) =>
    nodes.map((node) => node.querySelector('.response-process__analysis') ? 'reasoning' : 'tool'));
  assert.deepEqual(kinds, ['reasoning', 'tool', 'reasoning']);
  assert.match(await process.getByTestId('tool-trace-item').innerText(), /读取资源[\s\S]*完成[\s\S]*\/courses/);
  assert.equal(await page.locator('.reasoning-chain, .tool-trace').count(), 0, '不再并列两套过程入口');

  const stored = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    return (await db.chats.toArray()).find((row) => row.role === 'assistant');
  });
  assert.ok(stored.tools[0].reasoningOffset > 0, '实际工具回调保存顺序偏移');
  assert.equal(stored.tools[0].status, 'done');
  await mkdir('e2e-shots', { recursive: true });
  await page.screenshot({ path: 'e2e-shots/response-process-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'e2e-shots/response-process-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.reload();
  await page.getByTestId('response-process-toggle').waitFor();
  assert.equal(await page.getByTestId('response-process-toggle').getAttribute('aria-expanded'), 'false');
  await page.getByTestId('response-process-toggle').click();
  assert.equal(await page.locator('.response-process__analysis').count(), 2, '刷新后交错顺序仍可回放');

  // 隔离浏览器的历史 fixture：失败、停止与旧数据（不依赖 Vite HMR 后的 store 模块实例）。
  await page.evaluate(async (row) => {
    const { db } = await import('/src/store/db.ts');
    await db.chats.put({ ...row,
      content: '检索暂时不可用，你可以稍后重试。',
      reasoning: '检查可用资料。',
      tools: [{ name: 'read', detail: '/courses/很长的资料名称'.repeat(15), status: 'error', result: '工具执行失败：资料暂时无法读取', ms: 1200 },
        { name: 'grep', detail: '继续检索', status: 'running' }],
    });
  }, stored);
  await page.reload();
  const failed = page.getByTestId('response-process');
  await failed.locator('.response-process__failure').waitFor();
  assert.equal(await failed.getByTestId('response-process-toggle').getAttribute('aria-expanded'), 'false');
  assert.match(await failed.locator('.response-process__failure').innerText(), /资料暂时无法读取/, '收起时仍露出失败原因');
  await failed.getByTestId('response-process-toggle').click();
  assert.match(await failed.innerText(), /早期记录未保存/);
  assert.match(await failed.getByTestId('tool-trace-item').last().innerText(), /未完成/, '停止后不保留进行中状态');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'e2e-shots/response-process-mobile-error.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await failed.getByTestId('response-process-toggle').focus();
  await page.keyboard.press('Space');
  assert.equal(await failed.getByTestId('response-process-toggle').getAttribute('aria-expanded'), 'false');

  // 视频/材料侧栏复用同一组件，而非只有主页的展示更新。
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const videoId = 'process-panel-test';
    await db.videos.put({ id: videoId, name: '过程记录测试课程', size: 1, mimeType: 'video/mp4',
      duration: 100, createdAt: Date.now(), status: 'transcribed' });
    await db.segments.add({ videoId, idx: 0, start: 0, end: 5, text: '测试字幕', status: 1 });
    const sessionId = await db.chatSessions.add({ videoId, title: '过程记录测试', createdAt: Date.now() });
    await db.chats.add({ videoId, sessionId, role: 'assistant', content: '根据课程原文整理回答。',
      createdAt: Date.now(), reasoning: '先查课程再整理', tools: [
        { name: 'grep', detail: '课程重点', status: 'done', result: '找到 2 段内容', ms: 120, reasoningOffset: 4 },
      ] });
  });
  await page.goto(`${BASE}/#/player/process-panel-test`);
  await page.getByTestId('study-assistant-toggle').waitFor();
  const chatTab = page.getByTestId('panel-tab-chat');
  if (!(await chatTab.isVisible())) await page.getByTestId('study-assistant-toggle').click();
  await chatTab.click();
  const panelToggle = page.getByTestId('response-process-toggle');
  await panelToggle.waitFor();
  assert.equal(await panelToggle.getAttribute('aria-expanded'), 'false');
  await panelToggle.click();
  assert.match(await page.getByTestId('tool-trace-item').innerText(), /找到 2 段内容/);
  assert.equal(await page.locator('.response-process__analysis').count(), 2);
  assert.deepEqual(errors, []);
  console.log('PASS: 真实流式阶段、键盘开合、用户选择保持、有序步骤、持久化回放、失败可见、停止、旧数据、窄屏、减少动效与视频侧栏');
} catch (error) {
  console.error(await page.evaluate(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    return { messages: useCourseChat.getState().messages, visible: document.querySelector('[data-testid="course-chat-page"]')?.innerText };
  }));
  throw error;
} finally {
  await browser.close();
}
