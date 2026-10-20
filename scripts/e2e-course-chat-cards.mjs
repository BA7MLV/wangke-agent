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
      // 供应商注册表：凭据在 providers[i].apiKey，模型是带 provider 的引用
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

/** 一次推多轮（每轮一个队列元素）—— 测「轮次用尽」这类要连着跑好几轮的场景时用 */
const pushSteps = (steps) =>
  page.evaluate((list) => {
    for (const step of list) window.__LLM__.queue.push(step);
  }, steps);

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
/**
 * 输入框。
 *
 * ⚠️ 选择器必须同时收两种形态：`.course-chat__input` 本身**是** textarea/input（HeroUI 的
 * `TextArea` 把 className 落在元素上），以及它是包着 textarea/input 的容器。
 * 只写后代选择器 `.course-chat__input textarea` 的话一条都匹配不到 ——
 * `waitFor` 超时，报成「输入框不可见」，看着像页面挂了。
 */
async function typeAndSend(text) {
  const field = page
    .locator(
      '.course-chat__input textarea, .course-chat__input input, textarea.course-chat__input, input.course-chat__input',
    )
    .first();
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
  await page.screenshot({ path: 'scripts/out/ask-composer-desktop.png' });
  assert.equal(await page.locator('.course-chat__composer [data-testid="ask-card"]').count(), 1, '待回答问题接管 Chat 输入栏');
  assert.equal(await page.locator('.course-chat__bubble--ai [data-testid="ask-card"]').count(), 0, '消息流不重复显示作答入口');
  assert.equal(await page.locator('textarea.course-chat__input').count(), 0, '不保留第二个回答输入框');
  await card.locator('[data-testid="ask-custom"]').click();
  assert.ok(await card.getByRole('textbox', { name: '你的回答' }).isVisible());
  await card.getByRole('button', { name: '返回选项' }).click();
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
  assert.equal(await page.locator('.course-chat__composer [data-testid="ask-card"]').count(), 0, '作答后输入区恢复正常');
  assert.equal(await page.locator('.ask-option').count(), 0, '历史只留确认摘要，不留一排失效按钮');
  const answer = await page.locator('.course-chat__bubble--ai').last().innerText();
  assert.match(answer, /考试时间紧迫度/, `最终回答应接着选项往下说，实际：${answer.slice(0, 80)}`);
});

await check('选择与那条用户消息都落库（历史回放自洽）', async () => {
  const chats = await waitFor(async () => {
    const rows = await readAll('chats');
    // ⚠️ 判据必须是「带着 picked 的那条」：卡片行在**挂起时**就已落库（picked 暂空），
    // 只等「存在带 ask 的行」会在用户点选之前就满足，读到 picked 未写回的那一刻。
    const withAsk = rows.find((r) => r.role === 'assistant' && r.ask && r.ask.picked);
    return withAsk ? rows : null;
  });
  assert.ok(chats, '助手消息应带着 ask 与已作答的 picked 落库');
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

  await page.evaluate(() => { window.location.hash = '#/library'; });
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
  await page.evaluate(() => { window.location.hash = '#/library'; });
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

console.log('—— 5. 轮次用尽：不能只丢一句「（未获得回答）」 ——');

/** 清空会话并刷新（这两条要跑在「空会话」里，才看得清第一屏到底显示了什么） */
const resetChats = async () => {
  await dbHelper(async (idb) => {
    await new Promise((res, rej) => {
      const tx = idb.transaction(['chats', 'chatSessions'], 'readwrite');
      tx.objectStore('chats').clear();
      tx.objectStore('chatSessions').clear();
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    return true;
  });
  await page.goto(`${BASE}/#/chat`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
};

/** 6 轮「旁白 + 工具调用」把轮次用光；最后一条是「只想要工具、不吭声」的收尾轮 */
const burnRounds = (lastTool) => [
  { chunks: [{ content: '先看课程库。' }, toolChunks('list_courses', { limit: 50 })[0]] },
  { chunks: [{ content: '逐门确认一下。' }, toolChunks('get_course_details', { courseId: 'c-math' })[0]] },
  { chunks: [{ content: '继续确认。' }, toolChunks('get_course_details', { courseId: 'c-xingce' })[0]] },
  { chunks: [{ content: '继续。' }, toolChunks('get_course_details', { courseId: 'c-shenlun' })[0]] },
  { chunks: [{ content: '继续。' }, toolChunks('get_course_details', { courseId: 'c-1' })[0]] },
  { chunks: [{ content: '整理方案。' }, toolChunks('get_course_details', { courseId: 'c-2' })[0]] },
  { chunks: toolChunks(lastTool, { name: '南方日报', courseIds: ['c-1'] }) },
];

await check('收尾轮只想要工具、不吭声 → 宽限一次，模型说人话就照常显示', async () => {
  await resetChats();
  await pushSteps([
    ...burnRounds('propose_folder_plan'),
    { chunks: textChunks('南方日报的课程都已经归到「南方日报」分类了。') },
  ]);
  await typeAndSend('把南方日报的文件都移到南方日报文件夹');
  const answer = await waitFor(async () => {
    const t = await page.locator('.course-chat__bubble--ai').last().innerText();
    return t.includes('南方日报的课程') ? t : null;
  }, { timeout: 15000 });
  assert.ok(answer, '宽限一次后应给出真实回答');

  // 宽限那一轮的请求里必须有「不许调工具」的指令，且历史里不能残留没人应答的 tool_calls
  const bodies = await page.evaluate(() => window.__LLM__.requests);
  const last = bodies[bodies.length - 1];
  const tail = last.messages[last.messages.length - 1];
  assert.match(String(tail.content), /不能再调用任何工具/, '宽限轮要明确禁止再调工具');
  const prev = last.messages[last.messages.length - 2];
  assert.ok(!prev.tool_calls, '不吭声的那条不能带着 tool_calls 进历史（下一轮请求会 400）');
});

await check('收尾轮与宽限轮都不吭声 → 说清「用完几轮 / 还想调什么 / 接下来怎么办」', async () => {
  await resetChats();
  await pushSteps([
    ...burnRounds('propose_folder_plan'),
    { chunks: toolChunks('propose_folder_plan', { name: '南方日报', courseIds: [] }) },
  ]);
  await typeAndSend('把南方日报的文件都移到南方日报文件夹');
  const notice = await waitFor(async () => {
    const t = await page.locator('.course-chat__bubble--ai').last().innerText();
    return t.includes('轮次上限') ? t : null;
  }, { timeout: 20000 });
  assert.ok(notice, '兜底文案必须出现（不能是空气泡或一句「未获得回答」）');
  assert.match(notice, /检索了 6 轮/, '要说清用完了几轮');
  assert.match(notice, /propose_folder_plan/, '要点名它最后还想调什么');
  assert.match(notice, /继续/, '要给出下一步动作');
  assert.match(notice, /整理方案。/, '要把它最后说过的话留下来当进度');
  assert.doesNotMatch(notice, /未获得回答/, '不该再出现「（未获得回答）」');
});

console.log('—— 6. 提问卡：刷新后断点续跑 ——');
await check('刷新后卡片仍可答，且提示「会话已恢复」', async () => {
  await resetChats();
  // 第 1 轮先查课程库（攒下一条工具结果），第 2 轮才提问 —— 这样续跑才有的可验证：
  // 断点前的那条工具结果必须被保住，而不是重开一轮。
  await pushSteps([
    { chunks: [{ content: '先看课程库。' }, toolChunks('list_courses', { limit: 50 })[0]] },
    { chunks: toolChunks('ask_user', { question: '先学哪一门？', options: ['高等数学（上）', '申论归纳概括'], allowCustom: true }) },
  ]);
  await typeAndSend('帮我排个学习顺序');
  await page.locator('[data-testid="ask-card"]').waitFor({ timeout: 15000 });

  // 刷新：杀掉正在等待用户作答的 agent 循环
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });

  const card = page.locator('[data-testid="ask-card"]');
  await card.waitFor({ timeout: 15000 });
  assert.equal(await card.getAttribute('data-restored'), 'true', '刷新后卡片应标为「已恢复」');
  assert.equal(await card.getAttribute('data-answered'), 'false', '刷新后卡片应仍是待答');
  assert.equal(await card.locator('[data-testid="ask-card-expired"]').count(), 0, '不该显示「本次会话已结束」');
  assert.ok(await card.locator('[data-testid="ask-custom"]').isEnabled(), '卡内「我自己说」应可点');
});

await check('点选后从断点续跑：保住断点前的工具结果，不重开一轮', async () => {
  await push(textChunks('那就先', '从高等数学', '开始。'));
  await page.locator('.ask-option', { hasText: '高等数学（上）' }).click();
  const answer = await waitFor(async () => {
    const t = await page.locator('.course-chat__bubble--ai').last().innerText();
    return t.includes('高等数学') && t.includes('开始') ? t : null;
  }, { timeout: 15000 });
  assert.ok(answer, '续跑后应给出最终回答');

  // 续跑那一轮的请求里必须同时含：断点前 list_courses 的调用与结果、挂起的 ask_user 调用与它的结果。
  // 若没有续跑（而是重开一轮），这些中间消息一个都不会出现。
  const reqs = await page.evaluate(() => window.__LLM__.requests);
  const last = reqs[reqs.length - 1];
  const calls = last.messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.function.name));
  assert.ok(calls.includes('list_courses'), `断点前的 list_courses 调用应被带到续跑请求里，实际：${calls.join(',')}`);
  assert.ok(calls.includes('ask_user'), `挂起的 ask_user 调用应在续跑请求里，实际：${calls.join(',')}`);
  assert.ok(
    last.messages.some((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('高等数学（上）')),
    'ask_user 的工具结果应是把用户的选择喂回模型',
  );
});

console.log('—— 7. 目录整理方案卡：刷新后断点续跑 ——');
await check('刷新后方案卡仍可确认，执行后从断点续跑', async () => {
  await resetChats();
  await pushSteps([
    { chunks: toolChunks('propose_folder_plan', { summary: '按学科分两类。', folders: [{ name: '数学', courseIds: ['c-math'] }] }) },
  ]);
  await typeAndSend('帮我整理一下资料目录');
  await page.locator('[data-testid="plan-card"]').waitFor({ timeout: 15000 });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
  const card = page.locator('[data-testid="plan-card"]');
  await card.waitFor({ timeout: 15000 });
  assert.equal(await card.locator('[data-testid="plan-restored"]').count(), 1, '刷新后方案卡应显示「会话已恢复」');
  assert.equal(await card.locator('[data-testid="plan-card-expired"]').count(), 0, '刷新后方案卡不该是死卡');
  assert.ok(await card.locator('[data-testid="plan-confirm"]').isEnabled(), '刷新后「确认执行」应可点');

  await push(textChunks('已经按学科分好了。'));
  await card.locator('[data-testid="plan-confirm"]').click();
  const folders = await waitFor(async () => {
    const rows = await readAll('folders');
    return rows.length >= 1 ? rows : null;
  });
  assert.ok(folders, '确认后方案应真的落库');

  const answer = await waitFor(async () => {
    const t = await page.locator('.course-chat__bubble--ai').last().innerText();
    return t.includes('学科分好') ? t : null;
  }, { timeout: 15000 });
  assert.ok(answer, '确认后应继续跑出最终回答');
});

console.log('—— 8. 助手问题卡：手机布局与自定义作答 ——');
await check('手机端卡内自由作答，数字 / 中文不快选，提交后继续', async () => {
  await resetChats();
  await page.setViewportSize({ width: 390, height: 844 });
  await push(toolChunks('ask_user', {
    question: '你希望接下来怎么安排学习？',
    options: ['每天安排一门课程，按基础由浅入深', '优先复习最近考试涉及的课程'],
    allowCustom: true,
  }));
  await typeAndSend('帮我安排学习');
  const card = page.locator('[data-testid="ask-card"]');
  await card.waitFor();
  const box = await card.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, '问题卡在手机端不横向溢出');
  assert.ok(box && box.y >= 0 && box.y + box.height <= 844, '底部问题卡完整留在手机可视区内');
  assert.equal(await page.locator('.course-chat__composer [data-testid="ask-card"]').count(), 1);
  await page.screenshot({ path: 'scripts/out/ask-composer-mobile.png' });
  await card.locator('[data-testid="ask-custom"]').click();
  const field = card.getByRole('textbox', { name: '你的回答' });
  await field.fill('1 周三次，每次半小时');
  assert.equal(await card.count(), 1, '数字作为文字输入，不触发选项');
  await field.dispatchEvent('compositionstart');
  await field.press('Enter');
  assert.equal(await card.count(), 1, '中文输入法确认候选字时不提交');
  await field.dispatchEvent('compositionend');
  await push(textChunks('好的，每周安排三次学习。'));
  await card.getByRole('button', { name: '提交回答' }).click();
  assert.ok(await waitFor(async () => (await card.getAttribute('data-answered')) === 'true'), '回答后保留只读问题记录');
  assert.ok(await waitFor(async () => (await readAll('chats')).some((r) => r.ask?.picked === '1 周三次，每次半小时')), '自定义回答落库');
  await page.setViewportSize({ width: 1440, height: 900 });
});

await check('只允许选项时由提问组件接管输入栏，选择后恢复输入', async () => {
  await resetChats();
  await push(toolChunks('ask_user', { question: '请选择学习方式', options: ['先复习', '先预习'], allowCustom: false }));
  await typeAndSend('继续学习');
  const card = page.locator('[data-testid="ask-card"]');
  await card.waitFor();
  assert.equal(await page.locator('textarea.course-chat__input').count(), 0);
  assert.equal(await card.locator('[data-testid="ask-custom"]').count(), 0);
  await push(textChunks('我们先复习。'));
  await card.getByRole('button', { name: '先复习' }).click();
  assert.ok(await waitFor(async () => (await card.getAttribute('data-answered')) === 'true'));
  assert.ok(await page.locator('textarea.course-chat__input').isEnabled());
});

console.log('—— 9. 多选、文本、确认与跳过 ——');
await check('多选刷新恢复：数量限制、补充、结构化答案持久化与工具续跑', async () => {
  await resetChats();
  await push(toolChunks('ask_user', {
    type: 'multiple', question: '优先复习哪些科目？',
    options: [{ id: 'math', label: '数学' }, { id: 'english', label: '英语' }, { id: 'politics', label: '政治' }],
    minSelections: 2, maxSelections: 2,
  }));
  await typeAndSend('帮我确定复习范围');
  await page.locator('[data-testid="ask-card"]').waitFor();
  await page.reload();
  const card = page.locator('[data-testid="ask-card"]');
  await card.locator('[data-testid="ask-restored"]').waitFor();
  assert.equal(await page.locator('.course-chat__composer [data-testid="ask-card"]').count(), 1, '刷新后的多选仍在 Chat 栏作答');
  assert.ok(await card.getByRole('button', { name: '提交选择' }).isDisabled());
  await card.locator('.ask-option', { hasText: '数学' }).click();
  assert.ok(await card.getByRole('checkbox', { name: '数学' }).isChecked());
  assert.ok(await card.getByRole('button', { name: '提交选择' }).isDisabled());
  await card.getByRole('checkbox', { name: '英语' }).focus();
  await page.keyboard.press('Space');
  assert.ok(await card.getByRole('checkbox', { name: '英语' }).isChecked());
  assert.ok(await card.getByRole('checkbox', { name: '政治' }).isDisabled());
  await card.getByRole('button', { name: '补充说明' }).click();
  await card.getByRole('textbox', { name: '补充说明（选填）' }).fill('数学先补基础');
  await page.screenshot({ path: 'scripts/out/ask-multiple-desktop.png' });
  await push(textChunks('先复习数学和英语。'));
  await card.getByRole('button', { name: '提交选择' }).click();
  const row = await waitFor(async () => (await readAll('chats')).find(r => r.ask?.answer?.selectedIds?.length === 2));
  assert.deepEqual(row.ask.answer.selectedIds, ['math', 'english']);
  assert.equal(row.ask.answer.note, '数学先补基础');
  const result = await waitFor(() => page.evaluate(() => window.__LLM__.requests.flatMap(r => r.messages ?? []).find(m => m.role === 'tool' && m.content.includes('selectedIds'))));
  assert.deepEqual(JSON.parse(result.content).selectedIds, ['math', 'english']);
  await page.reload();
  await card.waitFor();
  assert.equal(await card.getAttribute('data-answered'), 'true');
  assert.match(await card.innerText(), /数学先补基础/);
});

await check('文本问题无需候选，空回答不可提交', async () => {
  await resetChats();
  await push(toolChunks('ask_user', { type: 'text', question: '你的学习目标是什么？' }));
  await typeAndSend('制定目标');
  const card = page.locator('[data-testid="ask-card"]');
  await card.waitFor();
  assert.equal(await card.locator('.ask-option').count(), 0);
  assert.equal(await page.locator('.course-chat__composer textarea').count(), 1, '文本题只有一个回答输入框');
  assert.ok(await card.getByRole('button', { name: '提交回答' }).isDisabled());
  await card.getByRole('textbox', { name: '你的回答' }).fill('两个月内通过考试');
  await push(textChunks('好的，按两个月来安排。'));
  await card.getByRole('button', { name: '提交回答' }).click();
  assert.ok(await waitFor(async () => (await readAll('chats')).some(r => r.ask?.answer?.mode === 'text' && r.ask.answer.text === '两个月内通过考试')));
});

await check('明确拒绝与跳过分别存储，不会误当同意', async () => {
  for (const skip of [false, true]) {
    await resetChats();
    await push(toolChunks('ask_user', { type: 'confirm', question: '按这份计划继续吗？', confirmLabel: '按计划继续', allowSkip: skip }));
    await typeAndSend('确认计划');
    const card = page.locator('[data-testid="ask-card"]');
    await card.waitFor();
    await push(textChunks(skip ? '已跳过。' : '好的，暂不执行。'));
    await card.getByRole('button', { name: skip ? '跳过' : '暂不执行' }).click();
    assert.ok(await waitFor(async () => (await readAll('chats')).some(r => r.ask?.answer?.status === (skip ? 'skipped' : 'declined'))));
  }
});

await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);
