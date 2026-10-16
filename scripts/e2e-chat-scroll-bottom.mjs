/* eslint-disable no-console */
// E2E：对话页的「回到底部」按钮（**不需要 API key**）。
//
// 覆盖点：
//   1. 打开会话时自动落到底部 → 按钮隐藏（贴底时它不该冒出来）
//   2. 往上滚 → 按钮浮出；滚回底部 → 又隐藏
//   3. 点按钮 → 平滑回到底部，按钮再次隐藏
//   4. 系统开了「减少动态效果」时，点按钮仍然到位（只是不平滑）
//   5. 用户滚上去之后，**流式追加的新内容不再把人拽回底部**（粘底松开）
//
// 前四条直接往 IndexedDB 种一条写好的长回答（渲染层，不碰模型流，快且稳，同
// e2e-chat-sources 的取舍）；第五条必须真的触发一次「内容增长」，所以那一段用
// 页内假模型流（addInitScript 换掉 window.fetch），一次都不花 API。
//
// 用法：npm run preview &  然后 node scripts/e2e-chat-scroll-bottom.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
/** 课程库助手的 videoId 哨兵值（会话与消息都挂在它下面） */
const AID = '__library_assistant__';
const FAKE_API = 'https://sf.test/v1';

let failed = 0;
const ok = (m) => console.log(`✅ ${m}`);
const fail = (m) => {
  console.error(`❌ ${m}`);
  failed++;
};
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(`${name}\n   ${e.message}`);
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) =>
  fail(`页面异常：${e.message}\n${String(e.stack ?? '').split('\n').slice(0, 6).join('\n')}`),
);

// 假模型流：第五条用例要真的让正文长高，模型那边只要吐字符串就行（同 e2e-chat-trace）。
await page.addInitScript(
  ({ baseUrl, aid }) => {
    localStorage.setItem(
      'wangke-settings',
      JSON.stringify({
        state: {
          providers: [
            { id: 'sf', name: '硅基流动', baseUrl, apiKey: 'k', serves: ['chat', 'vision', 'asr'], catalogId: 'siliconflow-cn' },
          ],
          llmModel: { providerId: 'sf', model: 'test-model' },
          visionModel: { providerId: 'sf', model: 'test-model' },
          asrModel: { providerId: 'sf', model: 'test-model' },
          contextWindow: 32768,
          agentRounds: 6,
        },
        version: 2,
      }),
    );
    // 这一段只是为了把正文撑长，内容本身不重要。
    window.__LONG__ = '这一段是用来把消息流撑高的，多写几句就够长了，方便观察滚动行为。';
    const nativeFetch = window.fetch.bind(window);
    window.__LLM__ = { queue: [] };
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.includes('/chat/completions')) return nativeFetch(input, init);
      const step = window.__LLM__.queue.shift() ?? { chunks: [{ content: '（没有脚本可播）' }] };
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(c) {
            for (const d of step.chunks) {
              c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`));
              if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
            }
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
  },
  { baseUrl: FAKE_API, aid: AID },
);

// ── 原始 IndexedDB 工具（只种状态，不种文件）────────────────────────────────
const dbHelper = (fn, arg) =>
  page.evaluate(
    async ([body, payload]) => {
      const run = new Function(`return (${body})`)();
      const req = indexedDB.open('wangke');
      const idb = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const out = await run(idb, payload);
      idb.close();
      return out;
    },
    [fn.toString(), arg ?? null],
  );

/** 一条长到必须滚动才能读完的助手回答（几十个段落就够撑满 900px 视口） */
const LONG_ANSWER = Array.from(
  { length: 60 },
  (_, i) => `第 ${i + 1} 段：这里只是把回答写长一点，好让消息区真的能滚起来。`,
).join('\n\n');

const seed = () =>
  dbHelper(
    async (idb, { aid, answer }) => {
      const now = Date.now();
      await new Promise((res, rej) => {
        const tx = idb.transaction(['chatSessions', 'chats'], 'readwrite');
        tx.objectStore('chatSessions').clear();
        tx.objectStore('chats').clear();
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      const tx = idb.transaction(['chatSessions', 'chats'], 'readwrite');
      const add = (store, row) =>
        new Promise((res, rej) => {
          const r = store.add(row);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      const session = await add(tx.objectStore('chatSessions'), { videoId: aid, title: '滚动用例', createdAt: now - 2000 });
      await add(tx.objectStore('chats'), { videoId: aid, sessionId: session, role: 'user', content: '写一段长回答', createdAt: now - 1900 });
      await add(tx.objectStore('chats'), { videoId: aid, sessionId: session, role: 'assistant', content: answer, createdAt: now - 1800 });
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      return session;
    },
    { aid: AID, answer: LONG_ANSWER },
  );

/** 读一次「贴底距离 + 按钮显隐」 */
const readState = () =>
  page.evaluate(() => {
    const sc = document.querySelector('[data-testid="course-chat-messages"]');
    const btn = document.querySelector('[data-testid="chat-scroll-bottom"]');
    const cs = btn ? getComputedStyle(btn) : null;
    return {
      distance: Math.round(sc.scrollHeight - sc.clientHeight - sc.scrollTop),
      scrollable: sc.scrollHeight - sc.clientHeight,
      btnShow: btn ? btn.getAttribute('data-show') : null,
      btnVisibility: cs ? cs.visibility : null,
      btnOpacity: cs ? cs.opacity : null,
    };
  });

const scrollTo = (top) =>
  page.evaluate((t) => {
    const sc = document.querySelector('[data-testid="course-chat-messages"]');
    sc.scrollTop = t === 'bottom' ? sc.scrollHeight : t;
  }, top);

/**
 * 等**计算后的** visibility 到位。
 * 不能只等 `data-show`：`visibility` 是跟着 150ms 过渡走的（收起时它必须撑到淡出结束
 * 才翻成 hidden，否则按钮会在淡出中途突然消失），所以 data-show 一变就读计算值会读到上一态。
 */
const waitBtnVisibility = (want, { timeout = 5000 } = {}) =>
  page.waitForFunction(
    (w) => getComputedStyle(document.querySelector('[data-testid="chat-scroll-bottom"]')).visibility === w,
    want,
    { timeout },
  );

const openChat = async () => {
  await page.goto(`${BASE}/#/chat`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
};

// ── 开跑 ────────────────────────────────────────────────────────────────────
await openChat();
await seed();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
await page.waitForFunction(
  () => document.querySelector('[data-testid="course-chat-messages"]')?.innerText.includes('第 60 段'),
  null,
  { timeout: 20000 },
);

console.log('—— 1. 打开即在底部，按钮隐藏 ——');
await check('会话打开时消息区可滚动且已落到底部', async () => {
  await page.waitForFunction(
    () => {
      const sc = document.querySelector('[data-testid="course-chat-messages"]');
      return sc.scrollHeight - sc.clientHeight - sc.scrollTop <= 24;
    },
    null,
    { timeout: 10000 },
  );
  const s = await readState();
  assert.ok(s.scrollable > 200, `消息区应当能滚动（可滚范围=${s.scrollable}）`);
  assert.ok(s.distance <= 24, `打开会话应当停在底部（距底=${s.distance}）`);
});

await check('贴底时「回到底部」按钮隐藏', async () => {
  await waitBtnVisibility('hidden');
  const s = await readState();
  assert.notEqual(s.btnShow, 'true', '贴底时 data-show 不该是 true');
  assert.equal(s.btnVisibility, 'hidden', '贴底时按钮必须 visibility:hidden（否则还占 Tab 顺序）');
});

console.log('—— 2. 上滚 / 回底 的显隐 ——');
await check('往上滚 → 按钮浮出', async () => {
  await scrollTo(0);
  await waitBtnVisibility('visible');
  // 淡入是 150ms 的过渡，visibility 一到就等于「开始淡入」了 —— 再等不透明度走完，
  // 断言「真的完全显形」而不是「刚开始显形」。
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('[data-testid="chat-scroll-bottom"]')).opacity === '1',
    null,
    { timeout: 5000 },
  );
  const s = await readState();
  assert.equal(s.btnShow, 'true', '滚上去之后 data-show 要为 true');
});

await check('滚回底部 → 按钮又隐藏', async () => {
  await scrollTo('bottom');
  await waitBtnVisibility('hidden');
  const s = await readState();
  assert.equal(s.btnShow, 'false', '回到贴底后 data-show 要为 false');
  assert.equal(s.btnOpacity, '0', '回到贴底后按钮要淡出');
});

console.log('—— 3. 点按钮回到底部 ——');
await check('滚动后点按钮 → 平滑回到底部并再次隐藏', async () => {
  await scrollTo(0);
  await waitBtnVisibility('visible');
  await page.click('[data-testid="chat-scroll-bottom"]');
  await page.waitForFunction(
    () => {
      const sc = document.querySelector('[data-testid="course-chat-messages"]');
      return sc.scrollHeight - sc.clientHeight - sc.scrollTop <= 24;
    },
    null,
    { timeout: 5000 },
  );
  await waitBtnVisibility('hidden');
  const s = await readState();
  assert.ok(s.distance <= 24, `点按钮后应当到底（距底=${s.distance}）`);
});

console.log('—— 4. 减少动态效果 ——');
await check('prefers-reduced-motion：点按钮仍然到位（不平滑）', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await scrollTo(0);
  await waitBtnVisibility('visible');
  await page.click('[data-testid="chat-scroll-bottom"]');
  await page.waitForFunction(
    () => {
      const sc = document.querySelector('[data-testid="course-chat-messages"]');
      return sc.scrollHeight - sc.clientHeight - sc.scrollTop <= 24;
    },
    null,
    { timeout: 3000 },
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

console.log('—— 5. 滚上去后，流式新内容不把人拽回底部 ——');
await check('上滚后追加流式内容 → 视图留在原处，按钮保持可见', async () => {
  await scrollTo(0);
  await waitBtnVisibility('visible');
  const beforeCount = await page.locator('[data-testid="chat-message-actions"]').count();
  // 一条 step 带 25 段正文：流式渲染会把消息区继续撑高一大截
  await page.evaluate(() => {
    window.__LLM__.queue.push({
      chunks: Array.from({ length: 25 }, () => ({ content: window.__LONG__ + '\n\n' })),
      delayMs: 15,
    });
  });
  const field = page.locator('.course-chat__input').first();
  await field.click();
  await field.fill('再问一句');
  await field.press('Enter');
  // 等这条回答落库（操作行 +1），说明内容确实已经长长了一截
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="chat-message-actions"]').length > n,
    beforeCount,
    { timeout: 30000 },
  );
  await page.waitForTimeout(500);
  const top = await page.evaluate(
    () => document.querySelector('[data-testid="course-chat-messages"]').scrollTop,
  );
  const s = await readState();
  assert.ok(top < 60, `滚上去之后新内容不该把人拽回底部（scrollTop=${top}）`);
  assert.ok(s.distance > 200, `新内容应当把底部推得更远（距底=${s.distance}）`);
  assert.equal(s.btnVisibility, 'visible', '视图不在底部时按钮要一直可见');
});

await context.close();
await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);
