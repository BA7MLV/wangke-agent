// Focused browser integration; Vite dev server required for store imports.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4193';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  localStorage.setItem('wangke-settings', JSON.stringify({ state: {
    providers: [{ id: 'cache-test', name: 'Cache test', baseUrl: 'https://api.openai.com/v1', apiKey: 'mock', protocol: 'openai-chat', catalogId: '', serves: ['chat'] }],
    llmModel: { providerId: 'cache-test', model: 'gpt-4.1' }, contextWindow: 131072, agentRounds: 6,
  }, version: 0 }));
  window.cacheTest = { queue: [], requests: [] };
  const original = window.fetch.bind(window);
  window.fetch = async (url, init) => {
    if (!String(url).includes('/chat/completions')) return original(url, init);
    window.cacheTest.requests.push(JSON.parse(init.body));
    const next = window.cacheTest.queue.shift();
    if (!next) throw new Error('unexpected model request');
    const events = [{ choices: [{ delta: next, finish_reason: next.tool_calls ? 'tool_calls' : 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 500 } } }];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
});
const attach = () => page.evaluate(async () => {
  // Reuse Vite's actual module URL (including its HMR timestamp), otherwise a
  // second store instance can be created while the dev server is already warm.
  const url = performance.getEntriesByType('resource').map(r => r.name).find(u => /\/src\/store\/courseChat\.ts(?:\?|$)/.test(u)) ?? '/src/store/courseChat.ts';
  window.chatStore = (await import(url)).useCourseChat;
  window.testDb = (await import('/src/store/db.ts')).db;
  await window.chatStore.getState().bootstrap();
});
const call = (id, name, args) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
try {
  await page.goto(`${base}/#/chat`); await attach();
  await page.waitForFunction(() => window.chatStore.getState().loaded);
  for (const restored of [false, true]) {
    const suffix = restored ? 'restored' : 'live';
    await page.evaluate(async queue => {
      window.cacheTest.queue = queue;
      await window.chatStore.getState().createSession();
      void window.chatStore.getState().send('请先读取技能目录，再问我学习方向');
    }, [call(`read-${suffix}`, 'read', { path: '/skills' }), call(`ask-${suffix}`, 'ask_user', { question: '学习方向？', options: ['基础', '进阶'] }), { content: '选择已收到。' }]);
    await page.waitForFunction(() => !!window.chatStore.getState().pendingAsk || !window.chatStore.getState().loading && window.chatStore.getState().messages.length > 0);
    assert.ok(await page.evaluate(() => !!window.chatStore.getState().pendingAsk), JSON.stringify(await page.evaluate(() => ({ messages: window.chatStore.getState().messages, requests: window.cacheTest.requests.length }))));
    const session = await page.evaluate(() => window.chatStore.getState().activeId);
    if (restored) {
      await page.reload(); await attach();
      await page.evaluate(async id => { window.cacheTest.queue = [{ content: '从断点完成。' }]; await window.chatStore.getState().loadSession(id); }, session);
      await page.waitForFunction(() => !!window.chatStore.getState().pendingAsk?.restored);
    }
    await page.evaluate(async () => window.chatStore.getState().answerAsk('基础'));
    await page.waitForFunction(() => !window.chatStore.getState().loading);
    const before = await page.evaluate(() => window.cacheTest.requests.at(-1));
    await page.reload(); await attach();
    await page.evaluate(async id => {
      window.cacheTest.queue = [{ content: '继续讲解。' }];
      await window.chatStore.getState().loadSession(id);
      await window.chatStore.getState().send('继续讲解');
    }, session);
    const after = await page.evaluate(() => window.cacheTest.requests.at(-1));
    assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages, `${suffix}: durable request prefix`);
    const toolCalls = after.messages.flatMap(m => m.tool_calls ?? []);
    assert.equal(toolCalls.filter(c => c.id === `ask-${suffix}`).length, 1, `${suffix}: ask envelope is not duplicated`);
    assert.equal(after.messages.filter(m => m.role === 'tool' && m.tool_call_id === `ask-${suffix}`).length, 1);
    assert.equal(after.prompt_cache_key, before.prompt_cache_key);
    assert.deepEqual(after.tools, before.tools);
    console.log(`${suffix}: ask/result pairing, raw read evidence, stable schemas/key and exact cross-turn prefix after reload passed`);
  }
  await page.evaluate(async () => (await import('/src/components/settingsDialogStore.ts')).openSettings('models'));
  const card = page.getByTestId('prompt-cache-usage');
  await card.getByRole('button', { name: '读取统计' }).click();
  await page.getByTestId('prompt-cache-total').waitFor();
  assert.match(await card.textContent(), /50%/);
  const href = await card.getByRole('link', { name: '导出基线 JSON' }).getAttribute('href');
  assert.equal(JSON.parse(decodeURIComponent(href.split(',').slice(1).join(','))).total.cacheHitRate, .5);
  await page.setViewportSize({ width: 360, height: 780 });
  await card.scrollIntoViewIfNeeded();
  assert.ok(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  assert.deepEqual(errors, []);
  console.log('Cache baseline UI: weighted rate, JSON export and 360px layout passed (mock provider usage, no live requests)');
} catch (error) {
  console.error('Browser diagnostic:', await page.locator('body').innerText(), errors);
  throw error;
} finally { await browser.close(); }
