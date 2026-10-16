/* eslint-disable no-console */
// E2E：思考链的四个形态 + 会话里的工具链（**不需要 API key**）。
//
// 模型流是**页内假的**（`window.__LLM__.queue` 脚本化 SSE，同 e2e-course-chat-cards），
// 逐块 enqueue + 真实 setTimeout，所以应用侧看到的是真的流式 —— 这一点是必须的：
// 「思考中」是**时间上**的中间态，一次性到达的假流根本走不到它。
//
// 覆盖点：
//   1. 中间态：data-mode=live、上下双箭头（两个 chevron path）、实时「已用时 x 秒」在跳
//   2. 中间态收起：向右箭头 + 标题只留「正在思考」，**不挂**实时用时；再展开能恢复
//   3. 固定区域：240px + overflow auto + 顶/底渐隐**各自**开关 + 自动滚到底
//   4. 工具链：跑的时候展开（标题报当前动作）、每行有动作/对象/耗时/结果摘要
//   5. 跑完自动收起：思考链 → 思考过程（不带用时）、工具链 → 计数
//   6. 展开：已思考用时 x 秒 + 吸顶；正文不限高
//   7. 刷新回放：工具链跟着落库的记录一起回来
//
// 用法：npm run preview &  然后 node scripts/e2e-chat-trace.mjs
//      （也可以 BASE_URL=http://localhost:5173 打 dev server）
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
/** 假的 OpenAI 兼容端点：只要请求打到这里就被脚本接管 */
const FAKE_API = 'https://sf.test/v1';
const SHOTS = 'e2e-shots';

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
page.on('pageerror', (e) => fail(`页面异常：${e.message}`));

// ── 设置 + 假模型流 ──────────────────────────────────────────────────────────
await page.addInitScript((baseUrl) => {
  localStorage.setItem('wangke-settings', JSON.stringify({
    state: {
      providers: [
        {
          id: 'sf',
          name: '硅基流动',
          baseUrl,
          apiKey: 'test-key',
          serves: ['chat', 'vision', 'asr'],
          catalogId: 'siliconflow-cn',
        },
      ],
      llmModel: { providerId: 'sf', model: 'test-model' },
      visionModel: { providerId: 'sf', model: 'test-model' },
      asrModel: { providerId: 'sf', model: 'test-model' },
      contextWindow: 32768,
      agentRounds: 6,
    },
    version: 2,
  }));

  const nativeFetch = window.fetch.bind(window);
  window.__LLM__ = { queue: [], requests: [] };
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('/chat/completions')) return nativeFetch(input, init);
    let body = {};
    try {
      body = JSON.parse(init?.body ?? '{}');
    } catch {
      /* 交给下面按空 body 处理 */
    }
    window.__LLM__.requests.push(body);
    const step = window.__LLM__.queue.shift() ?? { chunks: [{ content: '（没有脚本可播）' }] };
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for (const delta of step.chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
          if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
}, FAKE_API);

const pushSteps = (steps) =>
  page.evaluate((list) => {
    for (const step of list) window.__LLM__.queue.push(step);
  }, steps);

// ── 播种课程库（让 list_courses 有真东西可返回）────────────────────────────────
const seed = (videos) =>
  page.evaluate(async (rows) => {
    const req = indexedDB.open('wangke');
    const idb = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    await new Promise((res, rej) => {
      const tx = idb.transaction(['videos'], 'readwrite');
      const vs = tx.objectStore('videos');
      for (const v of rows) vs.put(v);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    idb.close();
    return true;
  }, videos);

const COURSES = [
  { id: 'c-math', name: '高等数学（上）', createdAt: 3, duration: 3600, kind: 'video', status: 'new' },
  { id: 'c-xingce', name: '行测判断推理', createdAt: 2, duration: 2400, kind: 'video', status: 'new' },
];

await page.goto(`${BASE}/#/chat`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
await seed(COURSES);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });

/**
 * 中间态要看得见，三件事都得成立：
 * - 思考链足够长（首页 240px 的框装不下 → 才谈得上溢出的渐隐与自动滚）
 * - 每一块之间有真实间隔（否则断言还没跑，流就结束了）
 * - 两轮各留一段足够长的窗口：**工具跑完但整轮还没结束**那段是「工具链展开着显示结果」的唯一时间
 */
const LONG = '先把问题拆成几段来看：这一段是用来把思考链撑长的，重复几遍就够高了。';
const thinkChunks = (n) => Array.from({ length: n }, () => ({ reasoning_content: LONG.repeat(10) }));

await pushSteps([
  // 第 1 轮：想一会儿 → 调工具
  {
    chunks: [
      ...thinkChunks(8),
      {
        tool_calls: [
          {
            index: 0,
            id: 'call_list_courses',
            type: 'function',
            function: { name: 'list_courses', arguments: JSON.stringify({ status: 'unstarted' }) },
          },
        ],
      },
    ],
    delayMs: 350,
  },
  // 第 2 轮：接着想 → 出正文（这一轮的 8 块就是「工具链跑完还开着」的观察窗口）
  {
    chunks: [...thinkChunks(8), { content: '你库里有两门课都还没开始：高等数学（上）与行测判断推理。' }],
    delayMs: 350,
  },
]);

const send = async (text) => {
  const field = page
    .locator('.course-chat__input textarea, .course-chat__input input, textarea.course-chat__input')
    .first();
  await field.waitFor({ timeout: 10000 });
  await field.click();
  await field.fill(text);
  await field.press('Enter');
};

const chain = page.locator('.reasoning-chain').first();
const bubble = page.locator('.course-chat__message--ai').first();

/**
 * 把工具链 toggle 出现过的每个状态都记下来（问答见 §2）。挂 MutationObserver 而不是轮询：
 * 「跑动中」只有几毫秒，从 Node 侧按帧去问是没有胜算的。characterData 也要盯 ——
 * 标题是文字节点替换，不一定伴随 childList 变化。按 JSON 去重，避免上百条重复。
 */
await page.evaluate(() => {
  window.__toolTraceStates = [];
  const seen = new Set();
  const grab = () => {
    const toggle = document.querySelector('[data-testid="tool-trace-toggle"]');
    if (!toggle) return;
    const trace = document.querySelector('[data-testid="tool-trace"]');
    const state = {
      text: (toggle.textContent || '').trim(),
      expanded: toggle.getAttribute('aria-expanded') === 'true',
      running: trace?.getAttribute('data-running') === 'true',
    };
    const key = JSON.stringify(state);
    if (seen.has(key)) return;
    seen.add(key);
    window.__toolTraceStates.push(state);
  };
  new MutationObserver(grab).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-expanded', 'data-running'],
  });
  grab();
});

await send('我有哪些课还没开始？');

// ── 1. 中间态 ────────────────────────────────────────────────────────────────
await page.waitForSelector('[data-testid="reasoning-elapsed"]', { timeout: 15000 });

await check('中间态：live + 标题「正在思考」+ 上下双箭头', async () => {
  assert.equal(await chain.getAttribute('data-mode'), 'live');
  assert.equal((await chain.locator('.reasoning-chain__title').innerText()).trim(), '正在思考');
  assert.equal(
    await chain.locator('.reasoning-chain__toggle svg path').count(),
    2,
    '中间态的图标该是上下双箭头（两条 chevron），不是单条下箭头',
  );
});

await check('中间态：实时用时在跳', async () => {
  const elapsed = page.locator('[data-testid="reasoning-elapsed"]').first();
  const a = (await elapsed.innerText()).trim();
  assert.match(a, /^已用时 \d+(\.\d)? 秒$/);
  await page.waitForTimeout(800);
  const b = (await elapsed.innerText()).trim();
  assert.notEqual(a, b, `两条读数应该不一样：${a} / ${b}`);
});

/**
 * 思考中手动收起 = 第三种形态（`data-mode=closed`，但不是「已完成」那种收起）。
 * 这里要盯的是「用时**只在展开的思考中**出现」：收起是「别占我地方」，
 * 而一个每 250ms 跳一下的数字恰恰最占注意力，既然折了就不该继续动。
 */
await check('中间态收起：向右箭头、标题无用时；再展开恢复 live', async () => {
  await chain.locator('.reasoning-chain__toggle').click();
  assert.equal(await chain.getAttribute('data-mode'), 'closed');
  assert.equal((await chain.locator('.reasoning-chain__title').innerText()).trim(), '正在思考');
  assert.equal(
    await page.locator('[data-testid="reasoning-elapsed"]').count(),
    0,
    '思考中收起后不该还挂着一个跳动的用时',
  );
  await bubble.screenshot({ path: `${SHOTS}/chat-trace-1b-collapsed.png` });

  await chain.locator('.reasoning-chain__toggle').click();
  assert.equal(await chain.getAttribute('data-mode'), 'live', '再点开该回到中间态');
  await page.waitForSelector('[data-testid="reasoning-elapsed"]', { timeout: 5000 });
});

await check('中间态：固定区域 240px + 溢出 + 自动滚到底 + 顶部渐隐', async () => {
  const box = await chain.locator('.reasoning-chain__body').evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      maxHeight: cs.maxHeight,
      overflowY: cs.overflowY,
      mask: cs.maskImage || cs.webkitMaskImage || '',
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
  assert.equal(box.maxHeight, '240px');
  assert.equal(box.overflowY, 'auto');
  assert.ok(box.scrollHeight > box.clientHeight + 40, '思考链该溢出固定区域');
  assert.ok(box.scrollTop > 0, '流式续写该自动滚到底');
  assert.match(box.mask, /linear-gradient/, '顶部溢出时该有渐隐');
});

await bubble.screenshot({ path: `${SHOTS}/chat-trace-1-live.png` });
ok('截图：中间态（思考中）');

// ── 2. 工具链（跑动中展开）──────────────────────────────────────────────────
/**
 * 为什么不在 Node 侧 `waitForFunction` 去抓「跑动中」那一瞬：`list_courses` 读的是本地
 * Dexie，几毫秒就返回了，那个窗口比轮询间隔还短。抓不抓得到全看机器忙不忙 ——
 * 症状正是最坏的一种：**单跑全绿、进一键跑分就红**，红得还很有说服力（「跑动中没展开」），
 * 其实什么都没测到。在页面里记状态则与轮询频率无关，断言反而更严：
 * 要求的是一组**同时**成立的条件（展开 + data-running + 标题报当前动作）。
 */
await check('工具链：跑的时候展开、标题报当前动作、结果落行', async () => {
  /**
   * 等的是「观察记录里**曾经**出现过这个状态」，不是「此刻正是这个状态」。
   * 这一点是关键：前者与轮询时机无关，后者又回到赌那一瞬。观察器把历史留着，
   * 所以哪怕工具早已跑完、标题早变成「已调用 1 个工具」，这条也照样能命中 ——
   * 而且必须等（本轮第 1 段思考要走完才轮到调工具，§1 跑完时工具还没发生）。
   */
  let acting = true;
  try {
    await page.waitForFunction(
      () =>
        (window.__toolTraceStates || []).some(
          (s) => s.running && s.expanded && /整理课程清单/.test(s.text),
        ),
      null,
      { timeout: 20000 },
    );
  } catch {
    acting = false;
  }
  const seen = await page.evaluate(() => window.__toolTraceStates || []);
  assert.ok(
    acting,
    `没观察到「跑动中 + 展开 + 标题报当前动作」这个状态。观察到的：${JSON.stringify(seen)}`,
  );

  // 工具跑完：状态转 done、结果摘要那一行有东西。这一条是**稳定**的（done 之后一直挂着），
  // 所以可以放心等。
  const item = page.locator('[data-testid="tool-trace-item"]').first();
  await page.waitForSelector('li[data-status="done"]', { timeout: 20000 });
  assert.ok(
    (await item.innerText()).includes('整理课程清单'),
    `工具链该用中文动作短语：${await item.innerText()}`,
  );
  assert.ok(
    (await item.innerText()).includes('高等数学'),
    `结果摘要该带上工具真的返回的内容：${await item.innerText()}`,
  );
  // 此刻整轮还没结束（工具链跟的是 streaming），所以这一张截的是「跑完展开着显示结果」
  await bubble.screenshot({ path: `${SHOTS}/chat-trace-2-tool-running.png` });
});

// ── 3. 跑完自动收起 ─────────────────────────────────────────────────────────
await check('跑完自动收起：思考链 → 思考过程（不带用时）、工具链 → 计数', async () => {
  /**
   * 等**整轮结束**，而不是等思考链收起 —— 两者不是一回事：
   * 正文一开始流，思考链就收起（那是「答案已经在写了」），而整轮还远没结束，
   * 此刻工具链仍然是展开的（它跟的是 `streaming`）。消息操作行是整轮结束的信号，
   * 它只在 `!streaming && content && rowId` 时出现。
   */
  await page.waitForSelector('[data-testid="chat-message-actions"]', { timeout: 40000 });
  assert.equal(await chain.getAttribute('data-mode'), 'closed');
  assert.equal((await chain.locator('.reasoning-chain__title').innerText()).trim(), '思考过程');
  assert.equal(
    await page.locator('[data-testid="reasoning-elapsed"]').count(),
    0,
    '收起态不该再挂一个实时用时',
  );
  const toggle = page.locator('[data-testid="tool-trace-toggle"]').first();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', '跑完该收起');
  assert.match(await toggle.innerText(), /已调用 1 个工具/);
  await bubble.screenshot({ path: `${SHOTS}/chat-trace-3-done.png` });
});

// ── 4. 展开：已思考用时 + 吸顶 ───────────────────────────────────────────────
await check('展开：已思考用时 x 秒 + 吸顶 + 正文不限高', async () => {
  await chain.locator('.reasoning-chain__toggle').click();
  assert.equal(await chain.getAttribute('data-mode'), 'expanded');
  assert.match((await chain.locator('.reasoning-chain__title').innerText()).trim(), /^已思考用时 /);
  const box = await chain.locator('.reasoning-chain__toggle').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { position: cs.position, top: cs.top };
  });
  assert.equal(box.position, 'sticky');
  assert.equal(box.top, '0px');
  const body = await chain.locator('.reasoning-chain__body').evaluate((el) => ({
    maxHeight: getComputedStyle(el).maxHeight,
  }));
  assert.equal(body.maxHeight, 'none', '展开态该全部铺开，不再限高');
  await bubble.screenshot({ path: `${SHOTS}/chat-trace-4-expanded.png` });
});

await check('工具链也能自己展开看逐条', async () => {
  await page.locator('[data-testid="tool-trace-toggle"]').first().click();
  assert.equal(await page.locator('[data-testid="tool-trace-toggle"]').first().getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('[data-testid="tool-trace-item"]').count(), 1);
  await bubble.screenshot({ path: `${SHOTS}/chat-trace-5-tool-expanded.png` });
});

// ── 5. 刷新回放（工具链跟着落库的记录一起回来）───────────────────────────────
await check('刷新后历史消息里也有工具链', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="tool-trace-toggle"]', { timeout: 15000 });
  const toggle = page.locator('[data-testid="tool-trace-toggle"]').first();
  assert.match(await toggle.innerText(), /已调用 1 个工具/);
  await toggle.click();
  const item = page.locator('[data-testid="tool-trace-item"]').first();
  assert.ok((await item.innerText()).includes('高等数学'), `回放的摘要该还在：${await item.innerText()}`);
  // 历史里的思考链：没落「实时用时」这个中间态字段，收起态就是朴素的「思考过程」
  assert.equal((await chain.locator('.reasoning-chain__title').innerText()).trim(), '思考过程');
  await page.locator('.course-chat__message--ai').first().screenshot({ path: `${SHOTS}/chat-trace-6-replay.png` });
});

await browser.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个失败`);
process.exitCode = failed === 0 ? 0 : 1;
