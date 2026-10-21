// 保留原思考链：默认展开、实时计时/跟随、完成收起、回看吸顶，工具以内联记录呈现。
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

async function checkToolRail(process) {
  const rail = await process.evaluate((node) => {
    const entries = node.querySelector('.reasoning-chain__entries');
    const icon = node.querySelector('.response-process__tool-icon');
    const body = node.querySelector('.reasoning-chain__body');
    const width = parseFloat(getComputedStyle(entries).borderLeftWidth);
    return { width, line: entries.getBoundingClientRect().left + width / 2,
      icon: icon.getBoundingClientRect().left + icon.getBoundingClientRect().width / 2,
      unclipped: icon.getBoundingClientRect().left >= body.getBoundingClientRect().left };
  });
  assert.equal(rail.width, 1, '过程竖线改为 1px');
  assert.ok(Math.abs(rail.line - rail.icon) < 1 && rail.unclipped, `图标居中在线上且不被滚动区裁掉：${JSON.stringify(rail)}`);
}

async function checkViewportFade(scrollSelector) {
  const metrics = await page.evaluate((selector) => {
    const scroll = document.querySelector(selector);
    const fade = scroll.parentElement.querySelector('.chat-viewport-fade');
    const rect = fade.getBoundingClientRect();
    return { bottom: rect.bottom, height: rect.height, scrollBottom: scroll.getBoundingClientRect().bottom,
      pointerEvents: getComputedStyle(fade).pointerEvents, hidden: fade.getAttribute('aria-hidden'),
      intercepts: !!document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 2)?.closest('.chat-viewport-fade'),
      layers: [...fade.children].map((layer) => ({ height: layer.getBoundingClientRect().height,
        blur: getComputedStyle(layer).backdropFilter, mask: getComputedStyle(layer).maskImage })) };
  }, scrollSelector);
  assert.ok(metrics.height > 0 && metrics.layers.every((layer) => layer.height > 0 && layer.height <= 64)
    && Math.abs(metrics.bottom - metrics.scrollBottom) < 1,
    `模糊固定在视区底边，采样仅占窄条：${JSON.stringify(metrics)}`);
  assert.equal(metrics.pointerEvents, 'none');
  assert.equal(metrics.hidden, 'true');
  assert.equal(metrics.intercepts, false, '装饰层不遮挡输入、点击或选择');
  assert.deepEqual(metrics.layers.map((layer) => layer.blur), ['blur(1px)', 'blur(2px)', 'blur(4px)']);
  assert.ok(metrics.layers.every((layer) => layer.mask.includes('linear-gradient')));
  return metrics;
}

async function checkLastMessageVisible(scrollSelector) {
  const gap = await page.locator(scrollSelector).evaluate(async (scroll) => {
    scroll.scrollTop = scroll.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const last = [...scroll.querySelectorAll('[data-chat-message]')].at(-1);
    const fade = scroll.parentElement.querySelector('.chat-viewport-fade');
    return fade.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
  });
  assert.ok(gap >= -1, `滚到底后最后一条消息完整露在模糊带上方：${gap}px`);
}

try {
  await page.goto(`${BASE}/#/chat`);
  await page.getByTestId('course-chat-page').waitFor();
  await page.evaluate(() => {
    window.__LLM__.queue.push(
      { delayMs: 400, chunks: [
        ...Array.from({ length: 8 }, () => ({ reasoning_content: '先查看课程列表。\n梳理已有的学习资料，再确定需要读取的内容。\n'.repeat(5) })),
        { tool_calls: [{ index: 0, id: 'read-courses', type: 'function', function: { name: 'read', arguments: '{"path":"/courses"}' } }] },
      ] },
      { delayMs: 400, chunks: [
        ...Array.from({ length: 8 }, () => ({ reasoning_content: '根据查询结果整理建议。\n保留课程信息中的实际结论。\n'.repeat(5) })),
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
  assert.match(await toggle.innerText(), /正在思考/);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', '恢复原版进行中默认展开');
  const elapsed = process.getByTestId('reasoning-elapsed');
  await elapsed.waitFor();
  const firstTime = await elapsed.innerText();
  await page.waitForTimeout(450);
  assert.notEqual(await elapsed.innerText(), firstTime, '仅展开时显示的实时计时继续更新');
  const body = process.locator('.reasoning-chain__body');
  await page.waitForFunction(() => {
    const el = document.querySelector('.reasoning-chain__body--live');
    return el && el.scrollHeight > el.clientHeight && el.scrollTop > 0;
  });
  assert.ok(await body.evaluate((el) => el.clientHeight <= 241), '仍使用原版限高视口');
  await body.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(500);
  assert.equal(await body.evaluate((el) => el.scrollTop), 0, '手动回滚后不被新 token 拉回底部');
  await mkdir('e2e-shots', { recursive: true });
  await page.screenshot({ path: 'e2e-shots/reasoning-process-streaming.png' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'HeroUI 支持键盘收起');
  assert.equal(await elapsed.count(), 0, '收起时不显示跳动的计时');
  await page.waitForFunction(() => document.querySelector('.reasoning-chain__summary')?.textContent.includes('1 次工具调用'));
  await page.waitForFunction(() => document.querySelector('.reasoning-chain__title')?.textContent.includes('正在思考'));
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', '工具切换和继续思考不强行展开');
  await toggle.click();
  await page.waitForFunction(() => document.querySelectorAll('.response-process__text').length === 2);
  assert.match(await toggle.innerText(), /正在思考/);
  assert.equal(await process.locator('.disclosure').count(), 0, '只有原思考链一个入口，没有嵌套分析折叠');
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="response-process"]');
    return node && !node.hasAttribute('data-streaming');
  });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', '恢复原版完成后自动收起');
  await page.waitForFunction(() => document.querySelector('.reasoning-chain__title')?.textContent.includes('思考过程'));
  assert.match(await toggle.innerText(), /思考过程[\s\S]*1 次工具调用/);
  assert.equal(await elapsed.count(), 0);
  await toggle.click();
  await page.waitForTimeout(500);
  const kinds = await body.locator('.reasoning-chain__entries > .response-process__text, .reasoning-chain__entries > .response-process__tool').evaluateAll((nodes) =>
    nodes.map((node) => node.classList.contains('response-process__text') ? 'reasoning' : 'tool'));
  assert.deepEqual(kinds, ['reasoning', 'tool', 'reasoning']);
  assert.match(await process.getByTestId('tool-trace-item').innerText(), /读取资源 · \/courses[\s\S]*完成/);
  assert.equal(await page.locator('.reasoning-chain').count(), 1, '直接复用原思考链');
  assert.equal(await page.locator('.tool-trace').count(), 0, '工具不再另起面板');
  assert.equal(await body.evaluate((el) => getComputedStyle(el).maxHeight), 'none', '回看展开全文，不嵌套滚动');
  await toggle.evaluate((el) => el.blur());
  await process.getByTestId('tool-trace-item').scrollIntoViewIfNeeded();
  await checkToolRail(process);
  const fadeBefore = await checkViewportFade('.course-chat__messages');
  await page.screenshot({ path: 'e2e-shots/reasoning-process-tools.png' });
  await page.evaluate(() => { document.documentElement.classList.add('dark'); });
  await page.screenshot({ path: 'e2e-shots/reasoning-process-tools-dark.png' });
  await page.evaluate(() => { document.documentElement.classList.remove('dark'); });

  // 真滚动验证吸顶，而不只检查 position: sticky 的声明。
  const sticky = await page.evaluate(async () => {
    const scroll = document.querySelector('.course-chat__messages');
    const chain = document.querySelector('.reasoning-chain');
    const heading = chain.querySelector('.reasoning-chain__heading');
    const start = chain.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    scroll.scrollTop = start + 240;
    await frame();
    const a = heading.getBoundingClientRect().top;
    scroll.scrollTop += 100;
    await frame();
    return { a, b: heading.getBoundingClientRect().top, position: getComputedStyle(heading).position };
  });
  assert.equal(sticky.position, 'sticky');
  assert.ok(Math.abs(sticky.a - sticky.b) < 2 && sticky.a >= 0 && sticky.a < 100, `回看标题吸顶：${JSON.stringify(sticky)}`);
  assert.equal((await checkViewportFade('.course-chat__messages')).bottom, fadeBefore.bottom, '消息滚动不带走底边模糊');
  await page.screenshot({ path: 'e2e-shots/reasoning-process-sticky.png' });
  await checkLastMessageVisible('.course-chat__messages');
  await page.locator('.course-chat__messages').evaluate((el) => { el.scrollTop = 0; });

  const stored = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    return (await db.chats.toArray()).find((row) => row.role === 'assistant');
  });
  assert.ok(stored.tools[0].reasoningOffset > 0, '实际工具回调保存顺序偏移');
  assert.equal(stored.tools[0].status, 'done');
  await page.screenshot({ path: 'e2e-shots/reasoning-process-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const mobileHeading = await toggle.boundingBox();
  assert.ok(mobileHeading.x >= 0 && mobileHeading.x + mobileHeading.width <= 391, '手机吸顶标题也在可视区内');
  await checkToolRail(process);
  await checkViewportFade('.course-chat__messages');
  await process.getByTestId('tool-trace-item').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'e2e-shots/reasoning-process-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.reload();
  await page.getByTestId('response-process-toggle').waitFor();
  assert.equal(await page.getByTestId('response-process-toggle').getAttribute('aria-expanded'), 'false');
  await page.getByTestId('response-process-toggle').click();
  assert.equal(await page.locator('.response-process__text').count(), 2, '刷新后交错顺序仍可回放');

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
  await failed.locator('.reasoning-chain__failure').waitFor();
  assert.equal(await failed.getByTestId('response-process-toggle').getAttribute('aria-expanded'), 'false');
  assert.match(await failed.locator('.reasoning-chain__failure').innerText(), /资料暂时无法读取/, '收起时仍露出失败原因');
  await failed.getByTestId('response-process-toggle').click();
  await page.waitForTimeout(450);
  assert.match(await failed.innerText(), /早期记录未保存/);
  assert.match(await failed.getByTestId('tool-trace-item').last().innerText(), /未完成/, '停止后不保留进行中状态');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'e2e-shots/reasoning-process-mobile-error.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await failed.getByTestId('response-process-toggle').focus();
  await page.keyboard.press('Space');
  assert.equal(await failed.getByTestId('response-process-toggle').getAttribute('aria-expanded'), 'false');

  // 视频/材料侧栏复用同一组件，而非只有主页的展示更新。
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const videoId = 'process-panel-test';
    await db.videos.put({ id: videoId, name: '过程记录测试课程', size: 1, mimeType: 'video/mp4',
      duration: 100, createdAt: Date.now(), status: 'transcribed' });
    await db.segments.add({ videoId, idx: 0, start: 0, end: 5, text: '测试字幕', status: 1 });
    const sessionId = await db.chatSessions.add({ videoId, title: '过程记录测试', createdAt: Date.now() });
    await db.chats.add({ videoId, sessionId, role: 'assistant', content: '根据课程原文整理回答。',
      createdAt: Date.now(), reasoning: '先查课程再整理。\n'.repeat(80), tools: [
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
  assert.equal(await page.locator('.response-process__text').count(), 2);
  await page.waitForTimeout(450);
  await checkToolRail(page.getByTestId('response-process'));
  const panelFade = await checkViewportFade('.chat-list-wrap');
  assert.ok(await page.locator('.chat-list-wrap').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom)) >= panelFade.height,
    '最后一条消息可完整滚出模糊带');
  const panelSticky = await page.evaluate(async () => {
    const scroll = document.querySelector('.chat-list-wrap');
    const heading = document.querySelector('.reasoning-chain__heading');
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    scroll.scrollTop = 200;
    await frame();
    const a = heading.getBoundingClientRect().top;
    scroll.scrollTop += 100;
    await frame();
    return { a, b: heading.getBoundingClientRect().top, top: scroll.getBoundingClientRect().top, scrollTop: scroll.scrollTop };
  });
  assert.ok(panelSticky.scrollTop >= 300 && Math.abs(panelSticky.a - panelSticky.b) < 2
    && Math.abs(panelSticky.a - panelSticky.top) < 8, `侧栏回看也吸顶：${JSON.stringify(panelSticky)}`);
  await page.screenshot({ path: 'e2e-shots/reasoning-process-panel-fade.png' });
  await checkLastMessageVisible('.chat-list-wrap');

  // 确认卡片仍在原位置作答；过程标题不把「等待人」说成「正在思考」。
  await page.goto(`${BASE}/#/chat`);
  await field.waitFor();
  await page.evaluate(() => {
    window.__LLM__.queue.push(
      { chunks: [{ reasoning_content: '需要先确认学习偏好。' }, { tool_calls: [
        { index: 0, id: 'ask-preference', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({
          question: '你希望如何学习？', options: ['先看重点', '逐节学习'], allowCustom: true,
        }) } },
      ] }] },
      { delayMs: 250, chunks: [{ reasoning_content: '按你选择的方式整理。' }, { content: '先看重点，再回看原文。' }] },
    );
  });
  await field.fill('先问我学习偏好，再推荐');
  await field.press('Enter');
  const ask = page.getByTestId('ask-card');
  await ask.waitFor();
  const askProcess = page.getByTestId('response-process').filter({ hasText: '需要先确认学习偏好。' });
  const askToggle = askProcess.getByTestId('response-process-toggle');
  await page.waitForFunction(() => [...document.querySelectorAll('.reasoning-chain__title')].at(-1)?.textContent.includes('等待你的回答'));
  assert.equal(await askProcess.getByTestId('reasoning-elapsed').count(), 0, '等用户时不继续跳计时');
  assert.equal(await page.locator('.course-chat__composer [data-testid="ask-card"]').count(), 1, '不改变原卡片作答入口');
  await askToggle.click();
  assert.equal(await askToggle.getAttribute('aria-expanded'), 'false');
  await ask.locator('.ask-option', { hasText: '先看重点' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="ask-card"]')?.getAttribute('data-answered') === 'true');
  await page.waitForFunction(() => !document.querySelector('.reasoning-chain[data-streaming]'));
  await askToggle.click();
  assert.match(await askProcess.getByTestId('tool-trace-item').innerText(), /已收到你的回应/);
  assert.equal(await askProcess.getByTestId('tool-trace-item').getAttribute('data-status'), 'done');
  assert.deepEqual(errors, []);
  console.log('PASS: 1px 竖线与居中图标、视区底部渐进模糊/点击穿透/末条完整可见、原版实时跟随/计时/开合、主页/侧栏吸顶、手机/深色、历史回放与确认卡片');
} catch (error) {
  console.error(await page.evaluate(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    return { messages: useCourseChat.getState().messages.map((m) => ({ key: m.key, streaming: m.streaming, phase: m.processPhase })),
      visible: document.querySelector('[data-testid="course-chat-page"]')?.innerText.slice(-1600) };
  }));
  throw error;
} finally {
  await browser.close();
}
