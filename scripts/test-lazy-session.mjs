#!/usr/bin/env node
/**
 * 懒创建会话（草稿态）的**数据层**不变量：真 store + 真 Dexie（fake-indexeddb）+ 假模型流。
 *
 * ## 为什么打在这一层，而不是抽成纯函数测
 *
 * 本轮改的**全是 store 的生命周期** —— 什么时候落库、删完落到哪、失败时视图留什么。
 * 把这几件事抽成纯函数再测，测的就不是真实那条路径了（而「什么时候落库」恰恰是
 * 唯一值得守的东西）。做法与 `test-agent-loop.mjs` / `test-migration.mjs` 同源：
 * esbuild 把 `src/` 打成**一个** bundle（两个 bundle = 两个 Dexie 实例，测试会假绿），
 * 替换 `globalThis.fetch` 成脚本化 SSE，全程零网络、零 key、不起服务。
 *
 * 页面链路（点删除按钮回到草稿态、刷新后不产生空壳）由 `e2e-lazy-session.mjs` 守，两者不重叠。
 *
 * ## 覆盖的不变量
 *
 * | # | 断言 | 失效时的用户可见症状 |
 * |---|---|---|
 * | A | 全新库 bootstrap **不产生任何会话行** | 侧栏一开始就挂一条「新会话」空壳 |
 * | B | 草稿态 `createSession` 幂等（连点 N 次仍是 0 行） | 连点两下出两条空会话 |
 * | C | **首条消息才落库**，标题 = 首条消息截断 | 空壳；或反过来：会话一直不出现 |
 * | D | 草稿态设的技能范围**随行落库** | 界面看着生效、发第一条消息时没了 |
 * | E | 删掉唯一会话 → **草稿态**（不新建空会话） | 删一条冒一条，永远删不干净 |
 * | F | 归档唯一会话 → **草稿态** | 同上 |
 * | G | 落库失败时**视图不留半截**、草稿原样留着 | 界面上「问过了」，刷新后整段消失 |
 * | H | 失败后重试仍能正确生成标题 | 会话在 Recent 里永远叫「新会话」 |
 *
 * 运行：node scripts/test-lazy-session.mjs
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Node 缺的浏览器 API ─────────────────────────────────────────────────────
const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
// settings 的 zustand persist 在导入期就会读存储。给个真能读写的桩。
//
// ⚠️ 会打一行 `Unable to update item 'wangke-settings' ... storage is currently unavailable`
// —— **这是预期的，别去追**：zustand 的默认存储是 `() => window.localStorage`
// （node_modules/zustand/middleware.js 里写死的），而 Node 没有 `window`，
// 于是它判定「没有存储」并静默跳过持久化。
// 这里**故意不伪造 `window`**：被测代码里有 `typeof window !== 'undefined'` 这类浏览器探测，
// 伪造一个假的会让它误判自己在浏览器里跑，测试环境就不再等于生产环境了。
// 设置项一律走 `useSettings.getState().update(...)` 直改 store —— 与 test-agent-loop.mjs 同款。
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
const OUT = mkdtempSync(join(tmpdir(), 'lazy-session-'));
const entry = join(OUT, 'entry.ts');
writeFileSync(
  entry,
  [
    `export { useCourseChat } from '${ROOT}src/store/courseChat.ts';`,
    `export { useSettings } from '${ROOT}src/store/settings.ts';`,
    `export { db } from '${ROOT}src/store/db.ts';`,
    `export { LIBRARY_ASSISTANT_ID } from '${ROOT}src/harness/libraryAssistant.ts';`,
  ].join('\n'),
);
await build({
  entryPoints: [entry],
  outfile: join(OUT, 'bundle.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  // .md?raw 是 vite 的写法（内置技能的 SKILL.md），esbuild 这边用 text loader 顶上
  loader: { '.md': 'text' },
  define: { 'process.env.NODE_ENV': '"test"' },
});
const { useCourseChat, useSettings, db, LIBRARY_ASSISTANT_ID } = await import(
  pathToFileURL(join(OUT, 'bundle.mjs')).href
);

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

/** 假网关：队列里取一轮，用尽后重复最后一轮。不真出网。 */
const llmQueue = [];
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.includes('/chat/completions')) throw new Error(`本测试不该请求 ${url}`);
  const step = llmQueue.length > 1 ? llmQueue.shift() : (llmQueue[0] ?? { content: '（没有脚本可播）' });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      if (step.content) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: step.content } }] })}\n\n`),
        );
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

/** 让下一轮对话返回这段正文 */
const reply = (content) => llmQueue.push({ content });

// 给 chat 槽位配一家带凭据的供应商。端点不真用（假网关接管），但 agent 要先能解析出目标
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
 * 所以每个用例前必须手工把 `ready` 按回去，否则第二个用例读到的是上一个的残留。
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
    draft: '',
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
const sessionRows = () => db.chatSessions.toArray();
const chatRows = (sessionId) => db.chats.where('sessionId').equals(sessionId).toArray();

// ── A. 全新库：草稿态，不落库 ──────────────────────────────────────────────
await test('A. 全新库 bootstrap 不产生会话行，且草稿态可以发消息', async () => {
  await fresh();
  await state().bootstrap();
  assert.deepEqual(state().sessions, [], '全新库不该有会话');
  assert.equal(await db.chatSessions.count(), 0, '全新库不该往 chatSessions 写行');
  assert.equal(state().activeId, null, '应该是草稿态');
  // loaded 必须是 true：草稿态没有东西要从库里读，否则输入框永久禁用
  assert.equal(state().loaded, true, '草稿态必须 loaded，否则用户连第一条都发不出去');
  assert.equal(state().ready, true);
});

// ── B. 草稿态「新建会话」幂等 ──────────────────────────────────────────────
await test('B. 草稿态连点 3 次「新建会话」，库里仍然是 0 行', async () => {
  await fresh();
  await state().bootstrap();
  await state().createSession();
  await state().createSession();
  await state().createSession();
  assert.equal(await db.chatSessions.count(), 0, '草稿态不该产生任何会话行');
  assert.equal(state().activeId, null);
  assert.deepEqual(state().sessions, []);
});

// ── C. 首条消息才落库 + 标题 ───────────────────────────────────────────────
await test('C. 首条消息才落库，标题按首条消息截断', async () => {
  await fresh();
  await state().bootstrap();
  const long = '这是第一条问题，很长很长很长很长很长很长很长很长';
  reply('第一条回答');
  await state().send(long);

  const rows = await sessionRows();
  assert.equal(rows.length, 1, '首条消息之后应当有且只有 1 条会话行');
  assert.equal(rows[0].videoId, LIBRARY_ASSISTANT_ID);
  assert.equal(rows[0].title, `${long.slice(0, 18)}…`, '标题应当是首条消息的前 18 字 + 省略号');
  assert.equal(state().activeId, rows[0].id, 'activeId 应当指向刚落库的那条');
  assert.equal(state().sessions.length, 1);
  assert.deepEqual(
    state().messages.map((m) => m.role),
    ['user', 'ai'],
  );
  assert.equal(state().messages[1].content, '第一条回答');

  const chats = await chatRows(rows[0].id);
  assert.deepEqual(
    chats.map((c) => c.role),
    ['user', 'assistant'],
    '用户提问与助手回答都要落库',
  );
  // 内存里的标题也要跟着变（侧栏 Recent 读的是它，只改库会让侧栏一直显示「新会话」）
  assert.equal(state().sessions[0].title, rows[0].title);
});

// ── D. 草稿态设置的技能范围随行落库 ────────────────────────────────────────
await test('D. 草稿态设的技能范围随首条消息一起落库', async () => {
  await fresh();
  await state().bootstrap();
  state().setSkillIds([7, 9]);
  assert.equal(await db.chatSessions.count(), 0, '草稿态设技能范围不该落库');
  reply('好');
  await state().send('问一句');
  const rows = await sessionRows();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].skillIds, [7, 9], '草稿态选的技能范围必须随行落库，不能被静默丢掉');
});

await test('D2. 草稿态没设技能范围时，落库的行**不带** skillIds 字段', async () => {
  await fresh();
  await state().bootstrap();
  reply('好');
  await state().send('问一句');
  const rows = await sessionRows();
  // undefined（不限定）与 []（一个都不给）语义不同，所以「不设」必须表现为**字段不存在**
  assert.ok(!('skillIds' in rows[0]), `不设技能范围时不该写 skillIds 字段，实际 ${JSON.stringify(rows[0])}`);
});

// ── E. 删掉唯一会话 → 草稿态 ───────────────────────────────────────────────
await test('E. 删掉唯一会话 → 草稿态，库里 0 行（不再现开空会话）', async () => {
  await fresh();
  await state().bootstrap();
  reply('好');
  await state().send('问一句');
  const id = state().activeId;
  assert.ok(id != null);

  const ok = await state().deleteSessionById(id);
  assert.equal(ok, true);
  assert.equal(await db.chatSessions.count(), 0, '删到不剩时不该再补一条空会话');
  assert.deepEqual(state().sessions, []);
  assert.equal(state().activeId, null, '应当回到草稿态');
  assert.equal(state().loaded, true, '草稿态必须仍可发消息');
  assert.deepEqual(state().messages, []);
});

// ── F. 归档唯一会话 → 草稿态 ───────────────────────────────────────────────
await test('F. 归档唯一会话 → 草稿态，库里只剩那条已归档的行', async () => {
  await fresh();
  await state().bootstrap();
  reply('好');
  await state().send('问一句');
  const id = state().activeId;

  const ok = await state().setArchived(id, true);
  assert.equal(ok, true);
  const rows = await sessionRows();
  assert.equal(rows.length, 1, '归档不该新建会话行');
  assert.equal(rows[0].archived, true);
  assert.deepEqual(state().sessions, [], 'Recent 里不该还有它');
  assert.equal(state().activeId, null, '应当回到草稿态');
  assert.equal(state().loaded, true);
});

// ── G/H. 落库失败：视图不留半截，草稿还在，重试能补上标题 ──────────────────
await test('G. 会话落库失败：不留半截消息、草稿原样留着、loading 不卡死', async () => {
  await fresh();
  await state().bootstrap();
  const original = db.chatSessions.add.bind(db.chatSessions);
  db.chatSessions.add = () => Promise.reject(new Error('磁盘写满了'));
  try {
    state().setDraft('这条会失败');
    await state().send('这条会失败');
  } finally {
    db.chatSessions.add = original;
  }
  assert.equal(await db.chatSessions.count(), 0);
  assert.equal(state().loading, false, 'loading 必须回到 false，否则用户再也发不出去');
  assert.equal(state().activeId, null, '仍然是草稿态');
  assert.equal(state().draft, '这条会失败', '落库失败时草稿要原样留着，别把用户打的字吃掉');
  const msgs = state().messages;
  assert.equal(msgs.length, 1, `失败时不该留下用户消息，实际 ${JSON.stringify(msgs.map((m) => m.role))}`);
  assert.equal(msgs[0].role, 'ai');
  assert.equal(msgs[0].error, true);
  assert.match(msgs[0].content, /会话创建失败：磁盘写满了/);
});

await test('H. 失败后重试：仍然按新那条消息生成标题（不会被上一条报错挤掉）', async () => {
  await fresh();
  await state().bootstrap();
  const original = db.chatSessions.add.bind(db.chatSessions);
  db.chatSessions.add = () => Promise.reject(new Error('磁盘写满了'));
  try {
    await state().send('第一次失败的问题');
  } finally {
    db.chatSessions.add = original;
  }
  assert.equal(state().messages.length, 1, '前提：视图里已经有一条报错消息');

  reply('补上了');
  await state().send('第二次成功的问题');
  const rows = await sessionRows();
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].title,
    '第二次成功的问题',
    '标题判据必须看「这条会话还没有标题」，不能只看 messages.length === 0',
  );
});

// ── I. 已有会话时「新建会话」进草稿态，再发消息落新行 ──────────────────────
await test('I. 已有会话 → 新建会话进草稿态（不落库）→ 发消息才落第二条', async () => {
  await fresh();
  await state().bootstrap();
  reply('一');
  await state().send('第一条会话');
  const firstId = state().activeId;

  await state().createSession();
  assert.equal(await db.chatSessions.count(), 1, '「新建会话」本身不该落库');
  assert.equal(state().activeId, null);
  assert.deepEqual(state().messages, [], '草稿态的消息区必须是空的');

  reply('二');
  await state().send('第二条会话');
  const rows = await sessionRows();
  assert.equal(rows.length, 2, '发第二条会话的首条消息时才落第二行');
  assert.notEqual(state().activeId, firstId);
  assert.deepEqual(
    rows.map((r) => r.title).sort(),
    ['第一条会话', '第二条会话'].sort(),
  );
});

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} 通过 / ${failures.length} 失败\n`);
if (failures.length > 0) {
  for (const { name, e } of failures) console.error(`FAIL ${name}\n${e.stack ?? e.message}\n`);
  process.exit(1);
}
