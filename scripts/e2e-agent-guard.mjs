/* eslint-disable no-console */
// E2E：agent 循环的三道护栏 + 停止生成（**不需要 API key**）。
//
// 模型流是页内假的：`addInitScript` 换掉 `window.fetch`，`window.__LLM__.queue` 里每条是
// 一轮的 delta。要验的是**我们自己写的状态机**（护栏判定 → 收尾 → 界面文案 / abort），
// 模型说什么与结论无关。
//
// 覆盖点：
//   1. 同一工具 + 同一参数重复调用 → 停，并说清「在重复调用 X」
//   2. 换关键词的多轮检索 → 不该被当成打转（护栏不能误伤）
//   3. 「不限」档（agentRounds = 0）→ 真的跑到第 9 轮以上，不被轮次闸拦住
//   4. 空回复（既无正文也无 tool_calls）→ 不当成正常结束，走强制收尾；收尾也不吭声时
//      兜底文案要说「空回复」，而不是编一个「已到轮次上限 / 0 次工具调用」
//   5. 停止生成按钮 → 点一下就停，已流出的内容保留 + 标「已停止生成」
//
// 用法：npm run preview &  然后 node scripts/e2e-agent-guard.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
/** 假的 OpenAI 兼容端点：请求打到这里就被脚本接管 */
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
page.on('pageerror', (e) => fail(`页面异常：${e.message}`));

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
      // 0 = 「不限」。护栏改成「循环检测 + token 预算 + 停止键」之后，
      // 靠轮数收尾的必要性下降了，这条档位要真的能跑到十几轮
      agentRounds: 0,
    },
    version: 0,
  }));

  const nativeFetch = window.fetch.bind(window);
  window.__LLM__ = { queue: [], calls: 0, requests: [] };
  /**
   * abort 必须被真的实现（真 fetch 会在 abort 时让 promise 以 AbortError reject）。
   * 只照着吐 chunk 的话，「停止生成」那条用例会**假通过**：信号被丢掉，流照常跑完，
   * 于是「已停止生成」永远等不到 —— 而应用侧其实什么都没测到。
   */
  const abortError = () => new DOMException('The user aborted a request.', 'AbortError');
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('/chat/completions')) return nativeFetch(input, init);
    const signal = init?.signal;
    if (signal?.aborted) throw abortError();
    window.__LLM__.calls++;
    try {
      window.__LLM__.requests.push(JSON.parse(init?.body ?? '{}'));
    } catch {
      /* 忽略 */
    }
    const step = window.__LLM__.queue.shift() ?? { chunks: [{ content: '（队列空了）' }] };
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(c) {
        const onAbort = () => {
          try {
            c.error(abortError());
          } catch {
            /* 已关闭 */
          }
        };
        signal?.addEventListener('abort', onAbort);
        try {
          for (const d of step.chunks) {
            if (signal?.aborted) return onAbort();
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`));
            if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
          }
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        } catch (e) {
          c.error(e);
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
}, FAKE_API);

const pushSteps = (steps) =>
  page.evaluate((list) => {
    for (const step of list) window.__LLM__.queue.push(step);
  }, steps);
const text = (t, delayMs = 0) => ({ chunks: [{ content: t }], delayMs });
/** 空回复：这一轮既没有正文也没有 tool_calls（思考链吃光 max_tokens 时的真实形态） */
const empty = () => ({ chunks: [] });
const tool = (name, args) => ({
  chunks: [{ tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }],
});
const toolWithText = (name, args, t) => ({
  chunks: [{ content: t }, { tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }],
});

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

/** 清空会话、播种两门课，回到干净的课程助手页 */
const reset = async (seedVideos = true) => {
  await dbHelper(async (idb, seed) => {
    await new Promise((res, rej) => {
      const tx = idb.transaction(['chats', 'chatSessions', 'videos', 'folders'], 'readwrite');
      tx.objectStore('chats').clear();
      tx.objectStore('chatSessions').clear();
      if (seed) {
        const now = Date.now();
        tx.objectStore('videos').put({ id: 'g-1', name: '南方日报·时政汇总', size: 1, mimeType: 'text/markdown', duration: 0, createdAt: now - 1, status: 'new', kind: 'material', materialFormat: 'md', unitCount: 20, lastUnit: 3 });
        tx.objectStore('videos').put({ id: 'g-2', name: '高等数学', size: 1, mimeType: 'video/mp4', duration: 60, createdAt: now - 2, status: 'new' });
      }
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    return true;
  }, seedVideos);
  await page.goto(`${BASE}/#/chat`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
  await page.evaluate(() => {
    window.__LLM__.calls = 0;
    window.__LLM__.requests = [];
  });
};

const typeAndSend = async (t) => {
  const field = page.locator('.course-chat__input textarea, .course-chat__input input').first();
  await field.waitFor({ timeout: 10000 });
  await field.click();
  await field.fill(t);
  await field.press('Enter');
};

const waitFor = async (fn, { timeout = 15000, step = 100 } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return null;
    await page.waitForTimeout(step);
  }
};

const lastAssistantText = () => page.locator('.course-chat__bubble--ai').last().innerText();

await page.goto(`${BASE}/#/chat`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });

console.log('—— 1. 循环检测：同样的调用再来一遍就停 ——');
await check('第二次调用同一工具同一参数 → 停下并说清在重复什么', async () => {
  await reset();
  await pushSteps([
    toolWithText('list_courses', { limit: 20 }, '先列一下课程。'),
    toolWithText('search_course_library', { query: '南方日报' }, '查一下。'),
    // 与第 2 轮完全相同的调用 → 判为原地打转
    toolWithText('search_course_library', { query: '南方日报' }, '换个说法再查。'),
    text('命中的是《南方日报·时政汇总》。'),
  ]);
  await typeAndSend('把南方日报的文件移到南方日报文件夹');
  const out = await waitFor(async () => {
    const t = await lastAssistantText();
    return t.includes('南方日报') || t.includes('重复') ? t : null;
  }, { timeout: 15000 });
  assert.ok(out, '这一轮应该有收尾回答');
  // 收尾说的是「命中…」，说明护栏把**重复的那次调用**拦下了，并让模型用已查到的材料作答。
  // 判定「确实走了强制收尾」要看请求里 **tools 没了**（而不是去找那句 nudge 文本 ——
  // 模型听话把话说出来时，nudge 根本不会进历史）
  assert.match(out, /南方日报·时政汇总/, `应给出基于已有材料的回答，实际：${out.slice(0, 90)}`);
  const reqs = await page.evaluate(() => window.__LLM__.requests);
  const closeOut = reqs[reqs.length - 1];
  assert.equal(closeOut.tools, undefined, '收尾那一轮必须是不带 tools 的（否则模型还能继续调工具）');
  assert.equal(closeOut.stream, true);
});

await check('兜底文案也要说清「在重复调用哪个」', async () => {
  await reset();
  await pushSteps([
    toolWithText('list_courses', { limit: 20 }, '先列课程。'),
    toolWithText('search_course_library', { query: '南方日报' }, '查。'),
    toolWithText('search_course_library', { query: '南方日报' }, '再查。'),
    // 收尾轮与宽限轮都不吭声 → 走兜底
    tool('search_course_library', { query: '南方日报' }),
    tool('list_courses', { limit: 20 }),
  ]);
  await typeAndSend('把南方日报的文件移到南方日报文件夹');
  const out = await waitFor(async () => {
    const t = await lastAssistantText();
    return t.includes('重复') ? t : null;
  }, { timeout: 20000 });
  assert.ok(out, '兜底文案应出现');
  assert.match(out, /重复调用/, '要说清是因为重复调用才停的');
  assert.match(out, /search_course_library/, '要点名是哪个工具在重复');
  assert.doesNotMatch(out, /未获得回答/, '不该再出现「（未获得回答）」');
});

console.log('—— 2. 护栏不能误伤：换关键词的多轮检索 ——');
await check('每次都换关键词 → 不被当成打转，一直查到收尾', async () => {
  await reset();
  const steps = [];
  const words = ['南方日报', '时政', '评论', '社论', '头条', '时评', '政策', '会议', '党建'];
  for (const w of words) steps.push(toolWithText('search_course_library', { query: w }, `查「${w}」。`));
  steps.push(text('九个关键词查完了，南方日报相关的都在《时政汇总》里。'));
  await pushSteps(steps);
  await typeAndSend('南方日报的材料都讲了什么');
  const out = await waitFor(async () => {
    const t = await lastAssistantText();
    return t.includes('九个关键词') ? t : null;
  }, { timeout: 20000 });
  assert.ok(out, '换关键词的九轮检索不该被拦下来');
  const calls = await page.evaluate(() => window.__LLM__.calls);
  assert.ok(calls >= 10, `应至少发 10 次请求（9 轮 + 收尾），实际 ${calls}`);
});

console.log('—— 3. 「不限」档：轮数闸真的不拦 ——');
await check('agentRounds = 0 时跑到 12 轮以上也不停', async () => {
  await reset();
  const steps = [];
  // 参数必须每轮都不同：参数完全相同会被**循环检测**拦掉（那是对的），
  // 用同一组参数测「不限」会变成在测另一件事
  for (let i = 0; i < 12; i++) {
    steps.push(toolWithText('list_courses', { status: 'all', limit: 20 + i }, `第 ${i + 1} 轮。`));
  }
  steps.push(text('第 12 轮才收尾。'));
  await pushSteps(steps);
  await typeAndSend('帮我盘点课程库');
  const out = await waitFor(async () => {
    const t = await lastAssistantText();
    return t.includes('第 12 轮才收尾') ? t : null;
  }, { timeout: 25000 });
  assert.ok(out, '「不限」档下 12 轮应该能跑完');
  const calls = await page.evaluate(() => window.__LLM__.calls);
  assert.ok(calls >= 13, `应至少发 13 次请求（12 轮 + 收尾），实际 ${calls}`);
});

console.log('—— 4. 空回复：不能当成正常结束 ——');
await check('模型返回空回复 → 强制收尾（收尾请求里 tools 消失）并给出总结', async () => {
  await reset();
  await pushSteps([
    toolWithText('list_courses', { limit: 20 }, '先列一下课程。'),
    // 这一轮啥也没回：既不调工具也不说话。以前这里被当成「正常收工」直接 return，
    // 界面上只剩一句凭空的「用完了 0 次工具调用，已到轮次上限」
    empty(),
    text('刚才那条回复是空的。我已经列完课程，可以继续。'),
  ]);
  await typeAndSend('课程库里有哪些课');
  const out = await waitFor(async () => {
    const t = await lastAssistantText();
    return t.includes('列完课程') ? t : null;
  }, { timeout: 15000 });
  assert.ok(out, '空回复之后应该还能拿到一句总结（强制收尾）');
  const reqs = await page.evaluate(() => window.__LLM__.requests);
  const closeOut = reqs[reqs.length - 1];
  assert.equal(closeOut.tools, undefined, '收尾那一轮必须不带 tools（否则模型还能继续调工具）');
});

await check('收尾也不吭声 → 兜底文案说「空回复」，不编「轮次上限 / 0 次工具调用」', async () => {
  await reset();
  await pushSteps([
    toolWithText('list_courses', { limit: 20 }, '先列课程。'),
    empty(),
    // 收尾轮与宽限轮都空 → 走兜底文案
    empty(),
    empty(),
  ]);
  await typeAndSend('课程库里有哪些课');
  const out = await waitFor(async () => {
    const t = await lastAssistantText();
    return t.includes('空回复') ? t : null;
  }, { timeout: 20000 });
  assert.ok(out, '兜底文案应出现，并说清是空回复');
  assert.match(out, /空回复/, '要说清模型这一轮啥也没回');
  assert.doesNotMatch(out, /轮次上限/, '轮次闸那一刻根本没触发，不该提它');
  assert.doesNotMatch(out, /0 次/, '不该把设置里的哨兵值（0 = 不限）当轮次印出来');
  assert.doesNotMatch(out, /未获得回答/, '不该再出现「（未获得回答）」');
});

await check('每轮 max_tokens 给到模型输出上限（不再写死 2048）', async () => {
  await reset();
  await pushSteps([text('一句话回答。')]);
  await typeAndSend('你好');
  // 先等回答真的上屏（请求是异步发的，断言得太早会读到空数组 —— 假失败）
  const out = await waitFor(async () => {
    const t = await lastAssistantText();
    return t.includes('一句话回答') ? t : null;
  }, { timeout: 15000 });
  assert.ok(out, '应拿到回答');
  const reqs = await page.evaluate(() => window.__LLM__.requests);
  assert.ok(reqs.length > 0, '应发出过请求');
  // test-model 元数据缺失 → 上限假定 8192；窗口 32768 比它大，所以上限生效
  assert.equal(reqs[0].max_tokens, 8192, '应给到模型输出上限');
});

await check('模型窗口远大于设置值时，按真实窗口给（不被保守估值压住）', async () => {
  await reset();
  // 播种一份模型元数据：该模型输出上限 384k、上下文 1049k，而设置里的窗口只有 32768。
  // 若拿设置值当上限，max_tokens 会被压到 ~2 万，白扔模型能力。
  await page.evaluate(() => {
    const meta = { updatedAt: Date.now(), models: { 'test-model': { context: 1049000, output: 384000, vision: false, reasoning: false, toolCall: true } } };
    localStorage.setItem('wangke-model-meta', JSON.stringify(meta));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
  await page.evaluate(() => {
    window.__LLM__.calls = 0;
    window.__LLM__.requests = [];
  });
  await pushSteps([text('一句话回答。')]);
  await typeAndSend('你好');
  const out = await waitFor(async () => {
    const t = await lastAssistantText();
    return t.includes('一句话回答') ? t : null;
  }, { timeout: 15000 });
  assert.ok(out, '应拿到回答');
  const reqs = await page.evaluate(() => window.__LLM__.requests);
  // 384k 上限、1049k 窗口、输入很小 → 给满 384k
  assert.equal(reqs[0].max_tokens, 384000, '应给到该模型的输出上限，而不是被设置里的 32768 压住');
});

await check('输入变大时 max_tokens 跟着降（每轮重算，不写死）', async () => {
  await reset();
  // ⚠️ 必须清掉上一条播种的元数据：localStorage 跨 reset 保留，而 `reset()` 只清 IndexedDB。
  // 留着它的话上限是 384k，窗口 1049k，要塞满 140 万字才触发收紧 —— 那不叫测试。
  await page.evaluate(() => localStorage.removeItem('wangke-model-meta'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
  await page.evaluate(() => {
    window.__LLM__.calls = 0;
    window.__LLM__.requests = [];
  });
  // 无元数据时上限假定 8192、窗口 32768 → 输入要超过 14576 token（估算 0.7/字，约 2 万字）
  // 余量才会低于 8192 而收紧
  await pushSteps([
    toolWithText('list_courses', { limit: 20 }, '查'.repeat(22000)),
    text('查完了。'),
  ]);
  await typeAndSend('课程库里有哪些课');
  const out = await waitFor(async () => {
    const t = await lastAssistantText();
    return t.includes('查完了') ? t : null;
  }, { timeout: 20000 });
  assert.ok(out, '应拿到回答');
  const reqs = await page.evaluate(() => window.__LLM__.requests);
  assert.ok(reqs.length >= 2, `应至少两轮请求，实际 ${reqs.length}`);
  const first = reqs[0].max_tokens;
  const last = reqs[reqs.length - 1].max_tokens;
  assert.ok(last < first, `输入变大后额度应收紧：第一轮 ${first} → 末轮 ${last}`);
});

console.log('—— 5. 停止生成 ——');
await check('点停止 → 立刻停，已流出的内容保留并标注', async () => {
  await reset();
  // 一个慢的流：3 块 × 600ms，点停要发生在它还没说完的时候
  await pushSteps([{ chunks: [{ content: '正在' }, { content: '慢慢' }, { content: '说完' }], delayMs: 600 }]);
  await typeAndSend('讲个长故事');
  const stop = page.locator('[data-testid="chat-stop"]');
  await stop.waitFor({ timeout: 10000 });
  assert.ok(await stop.isVisible(), '生成中应出现停止按钮');
  // 先等它真的开始吐字，再按停
  await waitFor(async () => (await lastAssistantText()).length > 0, { timeout: 8000 });
  await stop.click();
  const out = await waitFor(async () => {
    const t = await lastAssistantText();
    return t.includes('已停止生成') ? t : null;
  }, { timeout: 10000 });
  assert.ok(out, '点停后应标记「已停止生成」');
  assert.doesNotMatch(out, /回答失败/, '停止不是错误，不该报「回答失败」');
  // 「已停止生成」出现后还要把落库那次 await 等完，所以这里等而不是直接断言
  const gone = await waitFor(async () => (await page.locator('[data-testid="chat-stop"]').count()) === 0, {
    timeout: 5000,
  });
  assert.ok(gone, '停止后按钮应消失（回到可发送状态）');
  const input = page.locator('.course-chat__input textarea, .course-chat__input input').first();
  const editable = await waitFor(async () => (await input.isDisabled()) === false, { timeout: 5000 });
  assert.ok(editable, '停止后输入框应恢复可输入');
});

await check('停止的内容会落库（刷新后还在）', async () => {
  const rows = await dbHelper(async (idb) => {
    const tx = idb.transaction('chats', 'readonly');
    const all = await new Promise((res, rej) => {
      const q = tx.objectStore('chats').getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    return all;
  });
  const stopped = rows.find((r) => r.role === 'assistant' && r.content.includes('已停止生成'));
  assert.ok(stopped, '被停止的那条回答应落库（否则刷新就没了）');
});

await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);
