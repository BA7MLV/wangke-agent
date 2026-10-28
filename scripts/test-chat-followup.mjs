#!/usr/bin/env node
/**
 * 流式期间的输入（排队 / 插入）**数据层**不变量：真 store + 真 Dexie（fake-indexeddb）+ 假模型流。
 *
 * ## 为什么打在这一层
 *
 * 本轮加的三条不变量全在 store 的生命周期里（见 src/store/courseChat.ts 文件头）：
 * 消息不静默丢失、`pendingAsk` 优先、队列不落库。抽成纯函数测的就不是真实那条路径了。
 * 做法与 `test-lazy-session.mjs` / `test-agent-loop.mjs` 同源：esbuild 把 `src/` 打成
 * **一个** bundle（两个 bundle = 两个 Dexie 实例，测试会假绿），替换 `globalThis.fetch`
 * 成脚本化 SSE，全程零网络、零 key、不起服务。
 *
 * 页面层（输入框常开、排队条四操作、模式钮、黑圆点尾巴）由 `e2e-chat-followup.mjs` 守，
 * 两者不重叠。
 *
 * ## 覆盖的不变量
 *
 * | # | 断言 | 失效时的用户可见症状 |
 * |---|---|---|
 * | A | 生成中 `send` 进队列、**不发请求**、清草稿；答完自动续发并落库 | 打了字按了回车什么都没发生；或重复排两条 |
 * | B | 插入打断本轮：旧消息 `interrupted` + 原因、半截保留、新一轮开跑 | 旧内容被作废；或新问题发不出去 |
 * | C | 没在生成时 `steer` = 普通发送 | 「插入」在空闲时失灵 |
 * | D | 两条 steer 撞车：第二条**降级排队**，一条都不丢 | 连点两下插入，第二条凭空消失 |
 * | E | `pendingAsk` 优先于排队与插入 | 提问卡悬着时打字新起一轮，两条循环交错写消息 |
 * | F | 队列操作：空文本 = 删除、清空、**生成中切会话不挡、队列跟着会话、切回看到仍在流** | 空气泡永远发不出去；生成中切会话丢掉正在流的那条 |
 * | G | `sendQueuedNow` 出队 + 插入 | 闪电键点了没反应，或同一条发两遍 |
 * | H | **两条会话真并发**：切到 B 提问各流各的，内容不互相串 | 切过去不能问；或两条会话的内容串台 |
 *
 * 运行：node scripts/test-chat-followup.mjs
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Node 缺的浏览器 API（同 test-lazy-session.mjs 的两坑注释）────────────────
const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
const persisted = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k) => (persisted.has(k) ? persisted.get(k) : null),
    setItem: (k, v) => persisted.set(k, String(v)),
    removeItem: (k) => persisted.delete(k),
  },
  configurable: true,
  writable: true,
});

// ── 打 bundle（单入口，保证 store / db / settings 是同一份实例）─────────────
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = mkdtempSync(join(tmpdir(), 'chat-followup-'));
const entry = join(OUT, 'entry.ts');
writeFileSync(
  entry,
  [
     `export { useCourseChat } from '${ROOT}apps/web/src/store/courseChat.ts';`,
     `export { useSettings } from '${ROOT}apps/web/src/store/settings.ts';`,
     `export { db } from '${ROOT}apps/web/src/store/db.ts';`,
  ].join('\n'),
);
await build({
  entryPoints: [entry],
  outfile: join(OUT, 'bundle.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  loader: { '.md': 'text' },
  define: { 'process.env.NODE_ENV': '"test"' },
});
const { useCourseChat, useSettings, db } = await import(pathToFileURL(join(OUT, 'bundle.mjs')).href);

// ── 测试台 ─────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.error(`  FAIL - ${name}\n        ${e.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortError = () => new DOMException('The user aborted a request.', 'AbortError');

/**
 * 假网关：队列里取一步；**信号感知**（abort 立刻 error 掉这条流，否则插入与停止
 * 都等不到读取端收手）；`hold` 是一个 Promise，把流挂住不放行 ——
 * 「生成中」这个时间窗口就是这么做出来的。
 */
const llmQueue = [];
let requests = 0;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.includes('/chat/completions')) throw new Error(`本测试不该请求 ${url}`);
  const signal = init?.signal;
  if (signal?.aborted) throw abortError();
  requests++;
  const step = llmQueue.shift() ?? { content: '（没有脚本可播）' };
  const chunks = step.chunks ?? [{ content: step.content }];
  const stream = new ReadableStream({
    async start(controller) {
      const onAbort = () => {
        try {
          controller.error(abortError());
        } catch {
          /* 已关闭 */
        }
      };
      signal?.addEventListener('abort', onAbort);
      try {
        for (const chunk of chunks) {
          if (signal?.aborted) return onAbort();
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: chunk }] })}\n\n`),
          );
          if (step.delayMs) await sleep(step.delayMs);
        }
        if (step.hold) await step.hold;
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      } catch (e) {
        controller.error(e);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

/** 挂一条「说到一半停住」的流，返回放行函数。制造可操作的「生成中」窗口 */
const holdStep = (content) => {
  let release = () => {};
  llmQueue.push({ chunks: [{ content }], hold: new Promise((r) => (release = r)) });
  return { release: () => release() };
};

useSettings.getState().update({
  providers: [
    {
      id: 'sf',
      name: '硅基流动',
      baseUrl: 'https://fake.test/v1',
      apiKey: 'test-key',
      serves: ['chat', 'vision', 'asr'],
      catalogId: 'siliconflow-cn',
    },
  ],
  llmModel: { providerId: 'sf', model: 'test-model' },
  contextWindow: 32768,
  agentRounds: 6,
});

/**
 * 把 store 与库都退回「全新安装」。
 *
 * ⚠️ store 是**模块单例**，`ready` 一旦置 true 就再也不会走 bootstrap ——
 * 所以每个用例前必须手工把 `ready` 按回去。`queued` / `sendMode` 也要一起重置：
 * 它们正是本轮的被测状态，漏了就会从上个用例带过来。
 */
async function fresh() {
  llmQueue.length = 0;
  useCourseChat.setState({
    ready: false,
    sessions: [],
    activeId: null,
    loaded: false,
    messages: [],
    loading: false,
    runningIds: [],
    draft: '',
    queued: [],
    sendMode: 'queue',
    courseCount: null,
    skillIds: undefined,
    contextCourses: [],
    pendingAsk: null,
    pendingPlan: null,
    planApplying: false,
    archivedSessions: [],
  });
  await db.transaction('rw', db.chats, db.chatSessions, async () => {
    await db.chats.clear();
    await db.chatSessions.clear();
  });
}

const state = () => useCourseChat.getState();
const lastAi = () => [...state().messages].reverse().find((m) => m.role === 'ai');
const chatRows = (sessionId) => db.chats.where('sessionId').equals(sessionId).toArray();

const until = async (fn, { timeout = 5000, step = 20 } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待超时');
    await sleep(step);
  }
};

// ── A. 排队：生成中 send 进队列、不发请求、清草稿；答完自动续发 ──────────────
await test('A. 排队投递：进队列不发请求，答完自动续发并落库（队列本身不落库）', async () => {
  await fresh();
  await state().bootstrap();
  assert.equal(state().loaded, true, '草稿态必须 loaded，否则连第一条都发不出去');

  const held = holdStep('第一轮的回答');
  void state().send('问题一');
  await until(() => lastAi()?.content.includes('第一轮'));

  state().setDraft('补一句');
  await state().send('补一句');
  assert.deepEqual(state().queued.map((q) => q.text), ['补一句'], '生成中投递该进队列');
  assert.equal(state().draft, '', '投递后草稿该清空（不清用户会再打一遍）');
  assert.equal(requests, 1, '排队不该立刻发请求');

  // 不变量 3：队列只活在内存里 —— 这话还没交出去，库里不该有它
  const rowsBefore = await chatRows(state().activeId);
  assert.ok(
    !rowsBefore.some((r) => r.role === 'user' && r.content === '补一句'),
    '排队中的话不该落库（它不是历史）',
  );

  // 答完 → 自动续发。答案先备好：续发是 finally 里立刻发起的，晚了就吃到占位句
  llmQueue.push({ content: '补一句的回答' });
  held.release();

  await until(() => state().messages.some((m) => m.role === 'user' && m.content === '补一句'));
  await until(() => lastAi()?.content.includes('补一句的回答'));
  assert.equal(requests, 2, '续发该真的打一次请求');
  assert.deepEqual(state().queued, [], '续发后队列该空');

  const rows = await chatRows(state().activeId);
  assert.ok(
    rows.some((r) => r.role === 'user' && r.content === '补一句'),
    '交出去这一刻才落库：库里该有排队那句',
  );
  assert.ok(
    rows.some((r) => r.role === 'assistant' && r.content.includes('补一句的回答')),
    '续发的那轮也要落库',
  );
});

// ── B. 插入：打断本轮、旧消息标中断原因、半截保留、新一轮开跑 ────────────────
await test('B. 插入：打断本轮、半截保留并标原因、新一轮答新问', async () => {
  await fresh();
  await state().bootstrap();

  const held = holdStep('慢慢');
  llmQueue.push({ content: '改口后的回答' });
  void state().send('问题二');
  await until(() => lastAi()?.content.includes('慢慢'));

  // steer 内部等旧轮收尾再发新的，返回时新一轮已经跑完
  await state().steer('改口');

  const msgs = state().messages;
  const old = msgs.find((m) => m.role === 'ai' && m.content.includes('慢慢'));
  assert.ok(old, '被打断的那条该还在');
  assert.equal(old.interrupted, true, '旧消息该标 interrupted（它没写完，还能续写）');
  assert.equal(
    old.interruptReason,
    '你发了一条新消息，这一轮先停下来',
    `中断原因该说明是被新消息打断，实际：${old.interruptReason}`,
  );
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'ai');
  assert.ok(last.content.includes('改口后的回答'), '新一轮该答新问');

  // 旧行落库时同样带 interrupted + 原因（续写入口靠它）
  const rows = await chatRows(state().activeId);
  const oldRow = rows.find((r) => r.role === 'assistant' && r.content.includes('慢慢'));
  assert.equal(oldRow.interrupted, true, '落库的旧行也该带 interrupted');
  assert.equal(oldRow.interruptReason, '你发了一条新消息，这一轮先停下来');
  assert.ok(
    rows.some((r) => r.role === 'user' && r.content === '改口'),
    '插入的那句也要落库',
  );

  held.release(); // 收尸：被 abort 的那条流挂着没人读，放行让它自然关闭
});

// ── C. 没在生成时 steer = 普通发送 ─────────────────────────────────────────
await test('C. 空闲时 steer 退化成普通发送（界面上的插入按钮只看得到 loading）', async () => {
  await fresh();
  await state().bootstrap();

  llmQueue.push({ content: '直接问的回答' });
  await state().steer('直接问');

  const users = state().messages.filter((m) => m.role === 'user');
  assert.equal(users.length, 1, '只该有一条提问');
  assert.equal(users[0].content, '直接问');
  assert.ok(lastAi().content.includes('直接问的回答'), '该正常拿到回答');
});

// ── D. 两条 steer 撞车：第二条降级排队，一条都不丢 ─────────────────────────
await test('D. 连点两下插入：第二条降级成排队，消息不丢', async () => {
  await fresh();
  await state().bootstrap();

  const held = holdStep('竞速');
  llmQueue.push({ content: '消息A的回答' });
  llmQueue.push({ content: '消息B的回答' });
  void state().send('问题三');
  await until(() => lastAi()?.content.includes('竞速'));

  // 两条几乎同时：A 先醒来拿到发送权；B 醒来时新一轮已经在跑 → 降级成排队
  const pA = state().steer('消息A');
  const pB = state().steer('消息B');
  await Promise.all([pA, pB]);

  // A 那一轮正常跑完（B 没有反过来打断 A）
  const aMsg = state().messages.find((m) => m.role === 'ai' && m.content.includes('消息A的回答'));
  assert.ok(aMsg, '消息A 该被回答');
  assert.notEqual(aMsg.interrupted, true, 'A 不该被 B 打断（B 走的是排队）');

  // B 一条都不能丢：排队等 A 答完，然后自动发出
  await until(() => state().messages.some((m) => m.role === 'user' && m.content === '消息B'));
  await until(() => lastAi()?.content.includes('消息B的回答'));

  const rows = await chatRows(state().activeId);
  for (const text of ['消息A', '消息B']) {
    assert.ok(rows.some((r) => r.role === 'user' && r.content === text), `「${text}」不该丢`);
  }

  held.release();
});

// ── E. pendingAsk 优先于两种模式 ───────────────────────────────────────────
await test('E. 提问卡悬着时：打字是答卡，不排队也不插入', async () => {
  await fresh();
  await state().bootstrap();

  const held = holdStep('在想');
  void state().send('问题四');
  await until(() => lastAi()?.content.includes('在想'));

  // 真实场景里这张卡由 agent 循环挂上；这里直接挂一张等价的（resolve 是 spy）
  let resolvedWith = null;
  useCourseChat.setState({
    pendingAsk: { messageKey: lastAi().key, resolve: (picked) => (resolvedWith = picked) },
  });

  const callsBefore = requests;
  state().setDraft('我的回答');
  await state().send('我的回答');

  assert.equal(resolvedWith, '我的回答', '这话该去答那张卡');
  assert.equal(state().pendingAsk, null, '答完卡该收起');
  assert.deepEqual(state().queued, [], '答卡不该进队列');
  assert.equal(requests, callsBefore, '答卡不该新起一轮请求');
  assert.ok(
    (await chatRows(state().activeId)).some((r) => r.role === 'user' && r.content === '我的回答'),
    '答卡也要落成一条 user 行',
  );

  held.release();
  await until(() => state().loading === false);
});

// ── F. 队列操作：空文本 = 删除 / 清空 / 生成中切会话 ───────────────────────
await test('F. 队列操作：改空即删、可清空、生成中切会话不挡且队列跟着会话', async () => {
  await fresh();
  await state().bootstrap();

  const held = holdStep('切走前写了一半');
  void state().send('问题五');
  await until(() => lastAi()?.content.includes('切走前写了一半'));
  const first = state().activeId;

  state().enqueue('甲');
  state().enqueue('乙');
  assert.equal(state().queued.length, 2);

  // 改成空白 = 删掉：留一条永远发不出去的空气泡没有意义
  state().updateQueued(state().queued[0].id, '');
  assert.equal(state().queued.length, 1, '改空该等于删除');
  state().updateQueued(state().queued[0].id, '改过的乙');
  assert.equal(state().queued[0].text, '改过的乙', '排队条该能编辑');

  state().clearQueue();
  assert.deepEqual(state().queued, [], '该能一键清空');

  // 生成中切到草稿态：**不再被挡**（2026-10-16 行为反转）。上一条（正在流的）会话
  // 被 park 进它自己的视图，队列也跟着它走，不会跟到新会话。
  state().enqueue('留在第一条会话的话');
  await state().createSession();
  assert.equal(state().activeId, null, '生成中该允许切到草稿态');
  assert.deepEqual(state().queued, [], '别的会话的队列不该跟过来');

  // 切回第一条：**仍在流式的回答还在**（切走时没从库里重读而丢），队列也还在
  await state().loadSession(first);
  assert.equal(state().activeId, first, '该切回第一条会话');
  assert.ok(lastAi()?.content.includes('切走前写了一半'), '切回来该看到仍在流式的那条回答');
  assert.equal(state().loading, true, '切回来那一刻这一轮仍在跑');
  assert.deepEqual(state().queued.map((q) => q.text), ['留在第一条会话的话'], '队列跟着会话走');

  // 放行收尾：这一轮答完 → 队首自动续发并落库
  llmQueue.push({ content: '残留的回答' });
  held.release();
  await until(() => state().queued.length === 0 && state().loading === false);
  const rows = await chatRows(first);
  assert.ok(
    rows.some((r) => r.role === 'assistant' && r.content.includes('切走前写了一半')),
    '切走前那一轮也要落库（证明后台真的继续跑完了）',
  );
  assert.ok(
    rows.some((r) => r.role === 'user' && r.content === '留在第一条会话的话'),
    '续发的那句也要落库',
  );
});

// ── G. sendQueuedNow：出队 + 插入 ──────────────────────────────────────────
await test('G. sendQueuedNow：出队并立刻插入，不会发两遍', async () => {
  await fresh();
  await state().bootstrap();

  const held = holdStep('排队中');
  llmQueue.push({ content: '插队的回答' });
  void state().send('问题六');
  await until(() => lastAi()?.content.includes('排队中'));

  state().enqueue('插队这句');
  await state().sendQueuedNow(state().queued[0].id);

  assert.deepEqual(state().queued, [], '先出队再插（不然队列里留着同一条会发两遍）');
  const users = state().messages.filter((m) => m.role === 'user');
  assert.equal(users.filter((u) => u.content === '插队这句').length, 1, '这句话只该出现一次');
  assert.ok(lastAi().content.includes('插队的回答'), '插入后该拿到回答');
  assert.equal(
    state().messages.find((m) => m.role === 'ai' && m.content.includes('排队中'))?.interrupted,
    true,
    '旧轮该被打断',
  );

  held.release();
});

// ── H. 两条会话真并发：切到 B 提问，A 在后台继续流，内容不互相串 ─────────────
await test('H. 两条会话真并发：各流各的、互不串台、各落各的库', async () => {
  await fresh();
  await state().bootstrap();

  // A：第一条会话起一轮并挂住
  const heldA = holdStep('会话一在写');
  void state().send('问一');
  await until(() => lastAi()?.content.includes('会话一在写'));
  const first = state().activeId;

  // 生成中切到草稿态，再发一句 → 起**第二条会话**（第二个独立循环）
  await state().createSession();
  const heldB = holdStep('会话二在写');
  void state().send('问二');
  await until(() => lastAi()?.content.includes('会话二在写'));
  const second = state().activeId;
  assert.notEqual(second, first, '该是两条不同的会话');
  assert.ok(state().runningIds.includes(first), 'A 仍在跑');
  assert.ok(state().runningIds.includes(second), 'B 也在跑');

  // 切回 A：B 的流不干扰 A 的视图
  await state().loadSession(first);
  assert.ok(lastAi()?.content.includes('会话一在写'), 'A 的视图是 A 自己的流');
  assert.ok(
    !state().messages.some((m) => m.content.includes('会话二在写')),
    'B 的内容不会串到 A',
  );

  // 切到 B：A 在后台继续（还没放行，仍在跑）
  await state().loadSession(second);
  assert.ok(lastAi()?.content.includes('会话二在写'), 'B 的视图是 B 自己的流');
  assert.ok(
    !state().messages.some((m) => m.content.includes('会话一在写')),
    'A 的内容不会串到 B',
  );

  // 各自收尾：两条都要落进**各自的**会话
  heldA.release();
  heldB.release();
  await until(() => state().runningIds.length === 0);

  const firstRows = await chatRows(first);
  const secondRows = await chatRows(second);
  assert.ok(firstRows.some((r) => r.content.includes('会话一在写')), 'A 的回答该落在 A');
  assert.ok(
    !firstRows.some((r) => r.content.includes('会话二在写')),
    'B 的回答不该串进 A',
  );
  assert.ok(secondRows.some((r) => r.content.includes('会话二在写')), 'B 的回答该落在 B');
  assert.ok(
    !secondRows.some((r) => r.content.includes('会话一在写')),
    'A 的回答不该串进 B',
  );
});

await db.delete?.();
process.exit(failures.length > 0 ? 1 : 0);
