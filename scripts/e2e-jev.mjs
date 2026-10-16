#!/usr/bin/env node
// Dev server E2E：独立浏览器存储 + 页内假网关，不使用用户数据、真实 Key 或付费 API。
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.text().includes('[Sym] 未知图标')) errors.push(message.text());
});
await page.addInitScript(() => {
  if (!localStorage.getItem('wangke-settings')) {
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      contextWindow: 32768,
      providers: [{ id: 'sf', name: '假网关', baseUrl: 'https://fake-llm.test/v1', apiKey: 'fake-llm-key', protocol: 'openai-chat', serves: ['chat'], catalogId: '' }],
      llmModel: { providerId: 'sf', model: 'test-model' },
    } }));
  }
  window.__JEV__ = { requests: [], chats: [], mode: 'ok' };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/systemone')) {
      const body = JSON.parse(init.body);
      window.__JEV__.requests.push(body);
      if (window.__JEV__.mode === 'fail') return new Response('', { status: 503 });
      if (window.__JEV__.mode === 'hold') {
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      }
      if (window.__JEV__.mode === 'defer') {
        await new Promise((resolve) => window.__JEV__.release = resolve);
      }
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: id === 'turn_1' ? 0.99 : 0.01 }])) });
    }
    if (url === 'https://fake-llm.test/v1/chat/completions') {
      window.__JEV__.chats.push(JSON.parse(init.body));
      const delta = { choices: [{ delta: { content: 'Jev 集成测试回答。' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url === 'https://fake-llm.test/v1/models') return Response.json({ data: [{ id: 'test-model' }] });
    if (url.startsWith('https://models.dev/')) return Response.json({});
    return nativeFetch(input, init);
  };
});

try {
  await page.goto(`${base}/#/settings`);
  const card = page.getByTestId('card-jev');
  await card.waitFor();
  assert.equal(await page.evaluate(() => window.__JEV__.requests.length), 0);
  assert.equal(await page.getByRole('checkbox', { name: '讲义技能路由', exact: true }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: '长对话上下文压缩（实验性）', exact: true }).isChecked(), false);
  await page.getByRole('button', { name: '测试 Jev 连接', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '请先填写 Jev API Key' }).waitFor();
  assert.equal(await page.evaluate(() => window.__JEV__.requests.length), 0);
  await page.getByRole('textbox', { name: 'Jev API 地址', exact: true }).fill('https://fake-jev.test/v1');
  await page.locator('input[aria-label="Jev API Key"]').fill('fake-jev-key');
  // HeroUI 的可见点击目标是 Content label，原生 input 被 Control 覆盖。
  await page.getByTestId('jev-skill-routing').locator('label').click();
  const compressionToggle = page.getByRole('checkbox', { name: '长对话上下文压缩（实验性）', exact: true });
  await compressionToggle.focus();
  await compressionToggle.press('Space');
  assert.equal(await compressionToggle.isChecked(), true);
  assert.equal(await page.evaluate(() => window.__JEV__.requests.length), 0, '修改配置不能自动调用 API');
  await page.getByRole('button', { name: '测试 Jev 连接', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
  await page.evaluate(() => window.__JEV__.mode = 'fail');
  await page.getByRole('button', { name: '测试 Jev 连接', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'HTTP 503' }).waitFor();
  await page.reload();
  await card.waitFor();
  assert.equal(await page.getByRole('checkbox', { name: '长对话上下文压缩（实验性）', exact: true }).isChecked(), true);
  assert.equal(await page.locator('input[aria-label="Jev API Key"]').inputValue(), 'fake-jev-key');
  console.log('ok - 默认关闭、配置持久化、显式测试成功与错误提示');

  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, '移动端卡片不横向溢出');
  const input = await page.getByRole('textbox', { name: 'Jev API 地址', exact: true }).boundingBox();
  assert.ok(input.x + input.width <= 390);
  console.log('ok - 手机布局无横向溢出');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  const seed = async () => page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const now = Date.now() - 10_000;
    const id = await db.chatSessions.add({ videoId: '__library_assistant__', title: 'Jev 上下文测试', createdAt: now, updatedAt: now });
    const history = Array.from({ length: 8 }, (_, i) => [
      { videoId: '__library_assistant__', sessionId: id, role: 'user', content: `old-question-${i}: ${'x'.repeat(1200)}`, createdAt: now + i * 2 },
      { videoId: '__library_assistant__', sessionId: id, role: 'assistant', content: `old-answer-${i}: ${'y'.repeat(1200)}`, createdAt: now + i * 2 + 1 },
    ]).flat();
    await db.chats.bulkAdd(history);
    window.__JEV__.requests = [];
    window.__JEV__.chats = [];
    return id;
  });
  const id = await seed();
  await page.reload();
  const ring = page.getByTestId('chat-context-usage');
  await ring.waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="chat-context-usage"]').disabled);
  assert.equal(await page.evaluate(() => window.__JEV__.requests.length), 0, '未满时不自动调用');
  const beforeLabel = await ring.getAttribute('aria-label');
  await page.evaluate(() => window.__JEV__.mode = 'defer');
  await ring.click();
  await page.waitForFunction(() => window.__JEV__.requests.length > 0 && typeof window.__JEV__.release === 'function');
  assert.equal(await ring.getAttribute('data-compression'), 'compressing', await ring.evaluate((el) => el.outerHTML));
  assert.equal(await ring.isDisabled(), true);
  assert.equal(await ring.locator('.t-icon-swap').first().getAttribute('data-state'), 'b');
  const animation = await ring.locator('.ctx-usage__spinner').evaluate((el) => getComputedStyle(el).animationName);
  assert.equal(animation, 'ctx-compress-spin');
  assert.equal(await ring.locator('.ctx-usage__spinner svg').count(), 1);
  await page.evaluate(() => { window.__JEV__.mode = 'ok'; window.__JEV__.release(); });
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-context-usage"]')?.dataset.compression === 'success');
  assert.notEqual(await ring.getAttribute('aria-label'), beforeLabel, '压缩成功用量环下降');
  assert.ok(await ring.locator('.t-success-check[data-state="in"]').count());
  console.log('ok - 点击立即压缩、压缩中禁重入、transitions.dev 图标切换/成功动效与用量回落');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await ring.isVisible(), true, '手机端保留压缩入口');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await ring.locator('.ctx-usage__spinner').evaluate((el) => getComputedStyle(el).animationName), 'none');
  assert.equal(await ring.locator('.t-icon').first().evaluate((el) => getComputedStyle(el).transitionDuration), '0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('ok - 手机可点击，减少动态效果时禁用旋转与图标过渡');

  const requestsAfterManual = await page.evaluate(() => window.__JEV__.requests.length);
  await page.locator('.course-chat__composer textarea').fill('请继续当前课程');
  await page.getByTestId('chat-send').click();
  await page.waitForFunction(() => window.__JEV__.chats.length > 0);
  await page.waitForFunction(() => !document.querySelector('[data-testid="chat-context-usage"]').disabled);
  assert.equal(await page.evaluate(() => window.__JEV__.requests.length), requestsAfterManual, '发送复用手动压缩计划');
  const result = await page.evaluate(async (id) => {
    const { db } = await import('/src/store/db.ts');
    return { requests: window.__JEV__.requests, chats: window.__JEV__.chats, history: await db.chats.where('sessionId').equals(id).toArray() };
  }, id);
  assert.ok(result.requests.length > 0);
  assert.equal(result.chats.length, 1);
  const sent = result.chats[0].messages;
  assert.equal(sent[0].role, 'system');
  assert.equal(sent.at(-1).content, '请继续当前课程');
  assert.ok(!sent.some((message) => message.content?.includes('old-question-1:')));
  assert.ok(sent.some((message) => message.content?.includes('old-question-0:')));
  assert.ok(sent.some((message) => message.content?.includes('old-question-7:')));
  assert.equal(result.history.length, 18, '数据库中的历史不受筛选影响');
  console.log('ok - 真实 UI 发送复用筛选上下文，数据库原记录不变');

  await seed();
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('wangke-settings'));
    stored.state.contextWindow = 15000;
    localStorage.setItem('wangke-settings', JSON.stringify(stored));
  });
  await page.reload();
  await page.waitForFunction(() => window.__JEV__.requests.length > 0);
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-context-usage"]')?.dataset.compression === 'success');
  assert.equal(await page.evaluate(() => window.__JEV__.chats.length), 0);
  console.log('ok - 输入预算到达上限自动压缩，无需先发起 LLM 请求');

  await seed();
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('wangke-settings'));
    stored.state.contextWindow = 32768;
    localStorage.setItem('wangke-settings', JSON.stringify(stored));
  });
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('[data-testid="chat-context-usage"]')?.disabled);
  await page.evaluate(() => window.__JEV__.mode = 'hold');
  await ring.click();
  await page.waitForFunction(() => window.__JEV__.requests.length > 0);
  await page.locator('.course-chat__composer textarea').fill('停止测试');
  await page.getByTestId('chat-send').click();
  await page.getByTestId('chat-stop').click();
  await page.getByTestId('chat-stop').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__JEV__.chats.length), 0);
  assert.deepEqual(errors, []);
  console.log('ok - 等待 Jev 筛选时停止发送，不再发起 LLM 请求；无页面异常');
} finally {
  await browser.close();
}
