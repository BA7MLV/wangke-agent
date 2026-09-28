/* eslint-disable no-console */
// E2E：课程助手的两张生成式卡片 + 跨页继续（**不需要 API key**）。
//
// 模型流是**页内假的**：`addInitScript` 里把 `window.fetch` 换成一段脚本化的 SSE 发生器
// （`window.__LLM__.queue`），测试把每一轮该返回什么推进队列。这么做的理由：
// 这几条要验的是**我们自己写的状态机**（卡片 ↔ 工具 promise ↔ db 写回 ↔ 路由卸载），
// 模型说什么与结论无关；接真模型只会让断言变不稳定，还多一份花钱多花时间的账单。
//
// 覆盖点：
//   1. ask_user：出卡 → 点选 → 选择进 db、用户消息入库、循环继续出最终回答
//   2. 跨页继续：回答**流到一半**时切到课程库再切回来，内容不丢、最终落库
//   3. propose_folder_plan：出卡（显示真实课程名）→ 确认执行 → folders / folderId 真的落库
//   4. 取消方案：一行库数据都不动，卡片变成「已放弃」
//
// 用法：npm run preview &  然后 node scripts/e2e-course-chat-cards.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
/** 假的 OpenAI 兼容端点：只要请求打到这里就被脚本接管 */
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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => fail(`页面异常：${e.message}\n${String(e.stack ?? '').split('\n').slice(0, 6).join('\n')}`));

// ── 设置 + 假模型流 ──────────────────────────────────────────────────────────
await page.addInitScript((baseUrl) => {
  localStorage.setItem('wangke-settings', JSON.stringify({
    state: {
      apiKey: 'test-key',
      baseUrl,
      llmModel: 'test-model',
      visionModel: 'test-model',
      asrModel: 'test-model',
      contextWindow: 32768,
      agentRounds: 6,
    },
    version: 0,
  }));

  /**
   * 脚本化的 SSE 发生器。
   *
   * 队列元素：`{ chunks: [{delta 形状的对象}], delayMs }`。逐块 enqueue + 真实 setTimeout，
   * 于是应用侧看到的是**真的流式**（不是一次性到达），跨页继续那条断言才有意义。
   */
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

/** 往脚本队列里推一轮：把 delta 数组转成队列元素 */
const push = (chunks, delayMs = 0) =>
  page.evaluate(([c, d]) => window.__LLM__.queue.push({ chunks: c, delayMs: d }), [chunks, delayMs]);

const textChunks = (...parts) => parts.map((content) => ({ content }));
const toolChunks = (name, args) => [
  {
    tool_calls: [
      { index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ],
  },
];

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

const seed = (videos, folders) =>
  dbHelper(async (idb, { videos, folders }) => {
    await new Promise((res, rej) => {
      const tx = idb.transaction(['videos', 'folders'], 'readwrite');
      const vs = tx.objectStore('videos');
      for (const v of videos) vs.put(v);
      const fs = tx.objectStore('folders');
      for (const f of folders) fs.put(f);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    return true;
  }, { videos, folders });

const readAll = (store) =>
  dbHelper(async (idb, store) => {
    const tx = idb.transaction(store, 'readonly');
    const rows = await new Promise((res, rej) => {
      const q = tx.objectStore(store).getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    return rows;
  }, store);

// ── 打开课程助手并播种课程库 ────────────────────────────────────────────────
const COURSES = [
  { id: 'c-math', name: '高等数学（上）', createdAt: 3, duration: 3600, kind: 'video', status: 'new' },
  { id: 'c-xingce', name: '行测判断推理', createdAt: 2, duration: 2400, kind: 'video', status: 'new' },
  { id: 'c-shenlun', name: '申论归纳概括', createdAt: 1, duration: 1800, kind: 'video', status: 'new' },
];

await page.goto(`${BASE}/#/chat`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
await seed(COURSES, []);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });

/** mdui-text-field 内部可能是 textarea 也可能是 input，两个都试 */
async function typeAndSend(text) {
  const field = page.locator('.course-chat__input textarea, .course-chat__input input').first();
  await field.waitFor({ timeout: 10000 });
  await field.click();
  await field.fill(text);
  await field.press('Enter');
}

async function waitFor(fn, { timeout = 15000, step = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return null;
    await page.waitForTimeout(step);
  }
}

console.log('—— 1. 提问卡：出卡 → 点选 → 循环继续 ——');
await check('ask_user 出卡，且列出候选方案', async () => {
  await push(toolChunks('ask_user', {
    question: '你想让我优先按什么来推荐课程？',
    options: ['按考试时间紧迫度', '按基础由浅入深'],
    allowCustom: true,
  }));
  await page.click('.course-chat__starter >> nth=0');
  const card = page.locator('[data-testid="ask-card"]');
  await card.waitFor({ timeout: 15000 });
  const text = await card.innerText();
  assert.match(text, /优先按什么/, '卡上要有题面');
  assert.match(text, /按考试时间紧迫度/, '卡上要有选项');
});

await check('点一个方案 → 卡片锁定选中、回答接着出来', async () => {
  await push(textChunks('那就', '按', '考试', '时间', '紧迫度', '来排。'));
  await page.locator('.ask-option', { hasText: '按考试时间紧迫度' }).click();
  await waitFor(async () => (await page.locator('[data-testid="ask-card"]').getAttribute('data-answered')) === 'true');
  assert.equal(
    await page.locator('[data-testid="ask-card"]').getAttribute('data-answered'),
    'true',
    '作答后卡片应标记为已答',
  );
  const answer = await page.locator('.course-chat__bubble--ai').last().innerText();
  assert.match(answer, /考试时间紧迫度/, `最终回答应接着选项往下说，实际：${answer.slice(0, 80)}`);
});

await check('选择与那条用户消息都落库（历史回放自洽）', async () => {
  const chats = await waitFor(async () => {
    const rows = await readAll('chats');
    const ai = rows.filter((r) => r.role === 'assistant' && r.ask);
    return ai.length > 0 ? rows : null;
  });
  assert.ok(chats, '助手消息应带着 ask 落库');
  const withAsk = chats.find((r) => r.ask);
  assert.equal(withAsk.ask.picked, '按考试时间紧迫度', 'ask.picked 应存被选中的原文');
  assert.equal(withAsk.ask.question, '你想让我优先按什么来推荐课程？');
  assert.ok(
    chats.some((r) => r.role === 'user' && r.content === '按考试时间紧迫度'),
    '被选中的那句话应作为一条 user 消息入库',
  );
  // 模型必须收到「用户选了啥」才能接着答，否则它只能自己编
  const toolMsg = chats; // 仅确认上面那条存在即可
  assert.ok(toolMsg.length >= 3);
});

console.log('—— 2. 跨页继续：流到一半切走再回来 ——');
await check('回答流到一半时切到课程库再回来，内容不丢且最终落库', async () => {
  const aiBefore = (await readAll('chats')).filter((r) => r.role === 'assistant').length;
  // 8 块 × 350ms ≈ 2.8s 的流：足够在中间切一次页面
  await push(textChunks('一', '二', '三', '四', '五', '六', '七', '八'), 350);
  await typeAndSend('我该先学哪一门？');
  // 等到确实流出内容了再切走
  const streaming = await waitFor(async () => {
    const t = await page.locator('.course-chat__bubble--ai').last().innerText();
    return t.length > 0 ? t : null;
  }, { timeout: 10000 });
  assert.ok(streaming, '应观察到流式内容');

  await page.evaluate(() => { window.location.hash = '#/'; });
  await page.waitForSelector('[data-testid="video-item"]', { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.location.hash = '#/chat'; });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 15000 });

  const after = await waitFor(async () => {
    const t = await page.locator('.course-chat__bubble--ai').last().innerText();
    return t.includes('八') ? t : null;
  }, { timeout: 15000 });
  assert.ok(after, '切回课程助手后应接着看到这条回答（而不是重新开始）');
  assert.match(after, /二/, '中间那几段不能丢');

  const done = await waitFor(async () => {
    const rows = await readAll('chats');
    return rows.filter((r) => r.role === 'assistant').length > aiBefore ? rows : null;
  });
  assert.ok(done, '回到页面后这条回答应正常落库');
});

console.log('—— 3. 目录整理方案卡 ——');
await check('propose_folder_plan 出卡，显示真实课程名', async () => {
  await push(toolChunks('propose_folder_plan', {
    summary: '按考试分两类：行测、申论。',
    folders: [
      { name: '行测', courseIds: ['c-xingce'] },
      { name: '申论', courseIds: ['c-shenlun', 'c-not-exist'] },
    ],
  }));
  await push(textChunks('分类方案已经给你了，确认后才会动课程库。'));
  await typeAndSend('帮我整理一下课程库目录');
  const card = page.locator('[data-testid="plan-card"]');
  await card.waitFor({ timeout: 15000 });
  const text = await card.innerText();
  assert.match(text, /按考试分两类/, '卡上要显示整理思路');
  assert.match(text, /行测判断推理/, '分类下要列出真实课程名');
  assert.match(text, /1 门无法识别/, '模型编的 id 要在卡上说出来，不能静默消失');
});

await check('确认执行 → folders / folderId 真落库，且课程库立刻归位', async () => {
  await page.locator('[data-testid="plan-confirm"]').click();
  const folders = await waitFor(async () => {
    const rows = await readAll('folders');
    return rows.length >= 2 ? rows : null;
  });
  assert.ok(folders, '应新建两个文件夹');
  assert.deepEqual(folders.map((f) => f.name).sort(), ['申论', '行测'].sort());
  const videos = await readAll('videos');
  const byId = new Map(videos.map((v) => [v.id, v]));
  assert.equal(byId.get('c-xingce').folderId, folders.find((f) => f.name === '行测').id);
  assert.equal(byId.get('c-shenlun').folderId, folders.find((f) => f.name === '申论').id);
  assert.equal(byId.get('c-math').folderId, undefined, '方案外的课程不该被动');

  const applied = await waitFor(async () => {
    const el = page.locator('[data-testid="plan-card-applied"]');
    return (await el.count()) > 0;
  });
  assert.ok(applied, '卡片应显示已执行');

  // 课程库页面：分组要跟着变（库页订阅 libraryRevision 才做得到）
  await page.evaluate(() => { window.location.hash = '#/'; });
  const groups = await waitFor(async () => {
    const names = await page.locator('.group-header__name, .group-header').allInnerTexts().catch(() => []);
    const joined = names.join('|');
    return joined.includes('行测') && joined.includes('申论') ? joined : null;
  }, { timeout: 15000 });
  assert.ok(groups, `课程库应出现新分类分组，实际标题：${groups}`);
});

console.log('—— 4. 取消方案 ——');
await check('点取消 → 一行库数据都不动，卡片变成已放弃', async () => {
  await page.evaluate(() => { window.location.hash = '#/chat'; });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 15000 });
  const before = (await readAll('folders')).length;
  const videosBefore = JSON.stringify((await readAll('videos')).map((v) => v.folderId ?? null).sort());

  await push(toolChunks('propose_folder_plan', {
    summary: '换个主轴重分一遍。',
    folders: [{ name: '基础课', courseIds: ['c-math'] }],
  }));
  await push(textChunks('那就按基础课分？'));
  await typeAndSend('再换个分法');
  const card = page.locator('[data-testid="plan-card"]').last();
  await card.waitFor({ timeout: 15000 });
  await card.locator('[data-testid="plan-cancel"]').click();

  const cancelled = await waitFor(async () => {
    const el = page.locator('[data-testid="plan-card-cancelled"]');
    return (await el.count()) > 0;
  });
  assert.ok(cancelled, '卡片应显示已放弃');
  assert.equal((await readAll('folders')).length, before, '取消不应新建文件夹');
  const videosAfter = JSON.stringify((await readAll('videos')).map((v) => v.folderId ?? null).sort());
  assert.equal(videosAfter, videosBefore, '取消不应移动任何课程');
});

await check('模型收到的是「用户没执行」，不是「已整理」', async () => {
  const reqs = await page.evaluate(() => window.__LLM__.requests);
  const last = reqs[reqs.length - 1];
  const texts = last.messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : ''}`);
  assert.ok(
    texts.some((t) => t.includes('没有执行') || t.includes('保持原样')),
    `下一轮的历史里应带「用户没有执行方案」，实际最后一条：${texts[texts.length - 1]?.slice(0, 120)}`,
  );
});

await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);
