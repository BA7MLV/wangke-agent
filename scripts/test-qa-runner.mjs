#!/usr/bin/env node
/**
 * `harness/qaRunner.ts` 的端到端不变量测试：假网关 + 真 agent 循环 + 真 Dexie。
 *
 * ## 为什么必须是「端到到端」而不是拆成两个纯函数单测
 *
 * qaRunner 的产出是**数据**（`db.chats` 里的一问一答两行）与**一条消息序列**
 * （发出去的每次请求）。它最容易出的错都是「某一步单看都合理、拼起来才荒唐」那一类：
 *
 * - 用户行落了库、历史又把当前问题当成了历史重复发一遍；
 * - 工具往返消息被顺手落进库，下一轮历史里就多出模型从没说过的话；
 * - 技能白名单只管提示词不管工具（面板原来就有的那个漏洞）；
 * - 中途 abort 之后已流出的内容没落库，刷新就没了。
 *
 * 所以这里跑的是**真的那一段**：esbuild 打成一个 bundle（Node 不认无扩展名 import，
 * 也不用为了测试去改源码的 import 风格），Dexie 跑在 fake-indexeddb 上，
 * `globalThis.fetch` 换成假网关逐轮吐编排好的 SSE，捕获**每一次** `/chat/completions`
 * 的请求体。零网络、零 key。
 *
 * 断言的不变量（对应设计 §3.3 的「照搬，不顺手改行为」）：
 *   1. 一问一答落两行；
 *   2. 工具往返不落库，但工具结果要进**下一轮请求**；
 *   3. `onRoundStart` 清正文（旁白不进最终答案）；
 *   4. abort 保留已流出内容 + `_（已停止生成）_`，且**仍然落库**；
 *   5. 题卡走旁路回调，且随助手行落库；
 *   6. 技能范围同时管住提示词清单与 `use_skill`；
 *   7. 历史带上上一轮的一问一答，且不含工具消息；
 *   8. 空回答兜底**只返回不落库**；
 *   9. 材料课程的工具集与视频课程不同（不给不存在的检索工具）。
 *
 * 运行：node scripts/test-qa-runner.mjs
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

// zustand/persist 在导入期就要看到 localStorage（Node 里没有），给个最小桩。
// ⚠️ 开头那行 `[zustand persist middleware] Unable to update item …` 是**预期噪音**：
// zustand 的默认 storage 工厂是 `() => window.localStorage`，Node 没有 window → 持久化
// 直接判为不可用。那些用例改的是内存里的 store，落盘与否与它们无关。
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

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

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = mkdtempSync(join(tmpdir(), 'qa-runner-'));

// ⚠️ 必须打成一个入口（而不是多个 entryPoints）：多个入口各打一份 settings.js，
// 于是「改 store」改的是另一份实例，qaRunner 那边读到的仍是没配凭据的默认 state。
// 单入口 + re-export 才能保证 store、db 是同一个（与 test-agent-loop.mjs 同理）。
const entry = join(OUT, 'entry.ts');
writeFileSync(
  entry,
  `export { runQa, qaToolHint } from '${join(ROOT, 'apps/web/src/harness/qaRunner.ts')}';
   export { useSettings } from '${join(ROOT, 'apps/web/src/store/settings.ts')}';
   export { db } from '${join(ROOT, 'apps/web/src/store/db.ts')}';
   export { messageDefects } from '${join(ROOT, 'apps/web/src/api/messageHygiene.ts')}';
   export { fitModelHistory } from '${join(ROOT, 'apps/web/src/store/modelHistory.ts')}';
   export { readModelUsageReport } from '${join(ROOT, 'apps/web/src/store/modelUsage.ts')}';
  `,
);
await build({
  entryPoints: [entry],
  outfile: join(OUT, 'bundle.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  // 内置技能是 `SKILL.md?raw` 导入，Node/esbuild 默认不认这个后缀
  loader: { '.md': 'text' },
  plugins: [{ name: 'widget-local-runtime', setup(build) {
    build.onResolve({ filter: /^@widget\/chart-runtime\?raw$/ }, () => ({
      path: join(ROOT, 'node_modules/chart.js/dist/chart.umd.js'), namespace: 'widget-source',
    }));
    build.onLoad({ filter: /.*/, namespace: 'widget-source' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
  } }],
  // 全部打进 bundle：产物落在临时目录里，外部依赖（zustand / dexie / mermaid）在那儿解析不到
  define: { 'process.env.NODE_ENV': '"test"' },
});
const { runQa, qaToolHint, useSettings, db, messageDefects, fitModelHistory, readModelUsageReport } = await import(
  pathToFileURL(join(OUT, 'bundle.mjs')).href
);

// 给 chat 槽位配一家带凭据的供应商（端点不真用，假网关会接管）。
// 缺 key 会抛中文错「请先在设置里填 API Key」，所以这条测试需要能解析出目标的环境。
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
  visionModel: { providerId: 'sf', model: 'test-model' },
  agentRounds: 6,
});

await db.delete();
await db.open();

// ── 假网关 ────────────────────────────────────────────────────────────────

/** 一个 assistant SSE 轮次：正文 / 思考 / 工具调用 / finish_reason */
function sse({ content = '', reasoning = '', toolCalls = [], finish = 'stop', usage }) {
  const chunks = [];
  const base = { id: 'c', object: 'chat.completion.chunk', model: 'test', choices: [{ index: 0, delta: {} }] };
  if (reasoning) chunks.push({ ...base, choices: [{ index: 0, delta: { reasoning_content: reasoning } }] });
  if (content) chunks.push({ ...base, choices: [{ index: 0, delta: { content } }] });
  toolCalls.forEach((tc, index) => {
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } },
            ],
          },
        },
      ],
    });
  });
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  if (usage) chunks.push({ choices: [], usage });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

/**
 * 装上假网关，返回「每次请求的消息数组」。
 * `script` 按调用次序取用；用尽后重复最后一个（收尾轮的宽限重试就是这种情况）。
 */
function serve(script) {
  const seen = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/chat\/completions$/, '本测试只关心对话请求');
    const body = JSON.parse(init.body);
    seen.push({ messages: body.messages, tools: (body.tools ?? []).map((t) => t.function.name) });
    const chunk = script[Math.min(i, script.length - 1)];
    i++;
    return new Response(sse(chunk), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return seen;
}

/** 与网关同一套校验：任何一次请求都不能含非法消息（那是 400 的唯一来源） */
function assertRequestsLegal(seen, label) {
  assert.ok(seen.length > 0, `${label}：一次请求都没发出`);
  seen.forEach((req, i) => {
    const defects = messageDefects(req.messages);
    assert.deepEqual(defects, [], `${label}：第 ${i + 1} 次请求含非法消息\n${defects.join('\n')}`);
  });
}

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** 一个 sink：把七个回调各自记下来，用例按需断言 */
function recorder() {
  const r = { deltas: [], reasoning: [], rounds: [], tools: [], stops: [], cards: [] };
  return {
    r,
    sink: {
      onDelta: (t) => r.deltas.push(t),
      onReasoning: (t) => r.reasoning.push(t),
      onRoundStart: (n) => r.rounds.push(n),
      onToolStart: (name) => r.tools.push(['start', name]),
      onToolEnd: (name, result) => r.tools.push(['end', name, result]),
      onStop: (info) => r.stops.push(info),
      onCard: (card) => r.cards.push(card),
    },
    /** 流到 sink 的正文增量拼起来（= 气泡上的正文） */
    answer: () => r.deltas.join(''),
  };
}

/** 建一个会话；每个用例一个，避免历史串味 */
async function newSession(videoId = 'v1') {
  return await db.chatSessions.add({ videoId, title: '新会话', createdAt: Date.now() });
}

/** 读某会话里的全部聊天行（按时间序） */
async function rowsOf(sessionId) {
  return await db.chats.where('sessionId').equals(sessionId).sortBy('createdAt');
}

// ── 种子数据 ──────────────────────────────────────────────────────────────

await db.videos.add({
  id: 'v1',
  name: '贝叶斯入门',
  size: 1,
  mimeType: 'video/mp4',
  duration: 100,
  createdAt: 1,
  status: 'transcribed',
});
for (const [idx, start, text] of [
  [0, 0, '今天讲贝叶斯定理，它说的是先验概率怎么被证据更新。'],
  [1, 60, '过拟合的惩罚项在损失函数里对权重做正则化。'],
]) {
  await db.segments.add({ videoId: 'v1', idx, start, end: start + 30, text, status: 1 });
}
await db.materialBlocks.add({ materialId: 'm1', idx: 0, unit: 1, unitLabel: '第 1 页', text: '条件概率的乘法形式', kind: 'body' });

// 两个自建技能：会话限定到「甲」时，模型调「乙」必须被工具层拒绝
const SKILL_A = '测试技能甲';
const SKILL_B = '测试技能乙';
const skillAId = await db.skills.add({ name: SKILL_A, description: '范围内的技能', body: '甲的正文', enabled: 1, builtin: 0, updatedAt: 1 });
const skillBId = await db.skills.add({ name: SKILL_B, description: '范围外的技能', body: '乙的正文', enabled: 1, builtin: 0, updatedAt: 1 });

const ASK = (extra = {}) => ({ videoId: 'v1', sessionId: null, text: '贝叶斯定理是什么？', ...extra });

// ── 1. 正常一轮：一问一答落两行 ──────────────────────────────────────────────

await test('正常一轮：user + assistant 两行落库，onDelta 收到正文增量', async () => {
  const sessionId = await newSession();
  const seen = serve([{ reasoning: '先想想', content: '贝叶斯定理说的是用证据更新先验概率。' }]);
  const { r, sink, answer } = recorder();
  const res = await runQa(ASK({ sessionId }), sink);
  assertRequestsLegal(seen, '正常一轮');

  assert.equal(answer(), '贝叶斯定理说的是用证据更新先验概率。', '正文增量按序拼回');
  assert.equal(res.content, '贝叶斯定理说的是用证据更新先验概率。');
  assert.ok(res.rowId != null, '落库后要回 rowId（作答回写靠它）');
  assert.deepEqual(r.reasoning, ['先想想'], '思考增量也要透出（气泡上折叠展示）');
  assert.equal(typeof res.reasoningMs, 'number', '思考耗时要有（链路来宾据此显示「思考 xx 秒」）');

  const rows = await rowsOf(sessionId);
  assert.deepEqual(rows.map((x) => x.role), ['user', 'assistant'], '落库必须恰好两行');
  assert.equal(rows[0].content, '贝叶斯定理是什么？');
  assert.equal(rows[1].content, res.content);
  assert.equal(rows[1].id, res.rowId);
  assert.equal(rows[1].reasoning, '先想想', '思考过程随助手行落库（历史回放要折叠展示它）');

  // 视频课的系统提示词：走字幕检索那一支
  const sys = seen[0].messages[0].content;
  assert.ok(!sys.includes('贝叶斯入门'), '课程名不破坏共享系统前缀');
  assert.match(seen[0].messages.at(-1).content, /贝叶斯入门/, '课程名进入本轮上下文');
  assert.match(sys, /grep/, '视频课提示词指向资源检索');
});

await test('模型 error：正文前缀落库，中断原因不混入正文，也不自动收尾', async () => {
  const sessionId = await newSession();
  const seen = serve([{ content: '已写出的半截回答', finish: 'error' }]);
  let saved;
  await assert.rejects(runQa(ASK({ sessionId }), { onPersist: id => { saved = id; } }), /没有正常结束/);
  const rows = await rowsOf(sessionId);
  assert.equal(seen.length, 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].content, '已写出的半截回答');
  assert.equal(rows[1].id, saved);
  assert.equal(rows[1].interrupted, true);
  assert.match(rows[1].interruptReason, /没有正常结束/);
});

await test('模型 length：纯正文不是网络中断，不提供误导性的续写标记', async () => {
  const sessionId = await newSession();
  serve([{ content: '输出达到额度的正文', finish: 'length' }]);
  const result = await runQa(ASK({ sessionId }));
  assert.equal(result.content, '输出达到额度的正文');
  assert.equal((await rowsOf(sessionId))[1].interrupted, undefined);
});

await test('无终止信息断流：保留正文，空回答不伪造可续写断点', async () => {
  for (const prefix of ['断流前已经输出的内容', '']) {
    const sessionId = await newSession();
    globalThis.fetch = async () => new Response(prefix ? `data: ${JSON.stringify({ choices: [{ delta: { content: prefix } }] })}\n\n` : '', { headers: { 'content-type': 'text/event-stream' } });
    await assert.rejects(runQa(ASK({ sessionId })), /未收到完成标记/);
    const rows = await rowsOf(sessionId);
    assert.equal(rows.length, prefix ? 2 : 1);
    if (prefix) { assert.equal(rows[1].content, prefix); assert.equal(rows[1].interrupted, true); }
  }
});

// ── 2. 工具往返：工具消息不落库，但必须进下一轮请求 ──────────────────────────

await test('工具往返：落库仍只有两行，工具结果进了下一轮请求，onToolStart/End 被调', async () => {
  const sessionId = await newSession();
  const seen = serve([
    { toolCalls: [call('c1', 'grep', { query: '贝叶斯', path: '/courses/current' })], finish: 'tool_calls' },
    { content: '课程里说贝叶斯定理用证据更新先验概率。[00:00]' },
  ]);
  const { r, sink } = recorder();
  const res = await runQa(ASK({ sessionId }), sink);
  assertRequestsLegal(seen, '工具往返');

  assert.deepEqual(r.tools.map(([k, n]) => `${k}:${n}`), ['start:grep', 'end:grep']);
  const rows = await rowsOf(sessionId);
  assert.deepEqual(rows.map((x) => x.role), ['user', 'assistant'], '工具往返消息**不落库**（既有设计）');
  assert.equal(rows[1].content, res.content);

  const second = seen[1].messages;
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '工具结果必须进了第二轮请求，否则模型看不到自己查到了什么');
  assert.equal(toolMsg.tool_call_id, 'c1');
  assert.match(toolMsg.content, /来源：\[0:00\]/);
  assert.match(toolMsg.content, /原文：今天讲贝叶斯定理/, `检索结果真的来自库里的字幕：${toolMsg.content}`);
  assert.ok(seen[0].tools.includes('grep'));
});

// ── 3. onRoundStart 清正文：第一轮的旁白不能混进最终答案 ────────────────────

await test('onRoundStart：第二轮开始时清正文，旁白不进最终答案（round 从 0 起）', async () => {
  const sessionId = await newSession();
  const seen = serve([
    // 一边说「我去查一下」一边发工具调用 —— 正是被清掉的那类旁白
    { content: '我先查一下字幕…', toolCalls: [call('c1', 'grep', { query: '正则化', path: '/courses/current' })], finish: 'tool_calls' },
    { content: '惩罚项是对权重做正则化。[01:00]' },
  ]);
  const { r, sink } = recorder();
  const res = await runQa(ASK({ sessionId }), sink);
  assertRequestsLegal(seen, 'onRoundStart');

  assert.deepEqual(r.rounds, [0, 1], '两次 onRoundStart；round 是 0 基轮次下标（agent.ts 的约定）');
  assert.equal(res.content, '惩罚项是对权重做正则化。[01:00]', '第一轮旁白必须被清掉');
  assert.ok(!res.content.includes('我先查一下'), '旁白混进答案 = 用户看到模型自言自语两遍');
});

// ── 4. 中断：保留已流出内容 + （已停止生成），且仍然落库 ─────────────────────

await test('abort：保留已流出内容并追加「（已停止生成）」，那一行照样落库', async () => {
  const sessionId = await newSession();
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body).messages);
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(sse({ content: '先说一句：' })));
        const fail = () => controller.error(new DOMException('The user aborted a request.', 'AbortError'));
        if (init.signal?.aborted) fail();
        else init.signal.addEventListener('abort', fail);
        // 故意不 close：真实网关会一直挂着，直到用户按停
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const ac = new AbortController();
  const { r, sink } = recorder();
  const res = await runQa(ASK({ sessionId }), {
    ...sink,
    onDelta: (t) => {
      r.deltas.push(t);
      ac.abort(); // 用户在这一刻按了「停止生成」
    },
    signal: ac.signal,
  });
  assert.equal(res.content, '先说一句：\n\n_（已停止生成）_', '已流出的内容要留，并明确标出是用户停的');
  assert.ok(res.rowId != null, '中断也要落库：否则刷新就没了，「停止」等于白生成一轮');
  const rows = await rowsOf(sessionId);
  assert.deepEqual(rows.map((x) => x.role), ['user', 'assistant']);
  assert.equal(rows[1].content, res.content);
  assert.equal(rows[1].id, res.rowId);
});

// ── 5. 题卡：走旁路回调 + 随助手行落库 ─────────────────────────────────────

await test('present_quiz：sink.onCard({kind:"quiz"}) 被调，quiz 落进助手行', async () => {
  const sessionId = await newSession();
  const questions = {
    questions: [
      { stem: '贝叶斯定理更新的是什么？', options: ['先验', '证据', '阈值', '损失'], answer: 0, explanation: '用证据更新先验概率。', time: '00:00' },
    ],
  };
  const seen = serve([
    { toolCalls: [call('c1', 'present_quiz', questions)], finish: 'tool_calls' },
    { content: '上面这题考的就是先验与证据的关系。' },
  ]);
  const { r, sink } = recorder();
  const res = await runQa(ASK({ sessionId }), sink);
  assertRequestsLegal(seen, '题卡');

  assert.equal(r.cards.length, 1, '题卡不在流里，只走旁路回调');
  assert.equal(r.cards[0].kind, 'quiz');
  assert.equal(r.cards[0].quiz.data.questions[0].stem, '贝叶斯定理更新的是什么？');
  assert.deepEqual(r.cards[0].quiz.picks, [-1], '初始全部未作答（作答回写就改这个数组）');

  const rows = await rowsOf(sessionId);
  assert.equal(rows[1].quiz.data.questions.length, 1, '题卡随助手行落库（刷新后还能作答）');
  assert.deepEqual(rows[1].quiz.picks, [-1]);
  assert.equal(rows[1].content, res.content);
});

// ── 6. 技能范围：提示词与工具两侧同时收窄（本次修的那条）──────────────────────

await test('题库 path：宿主读取原文件，批次与来源随题卡落库，下一轮历史含续题位置', async () => {
  const videoId = 'bank-pdf', fileId = '__course_questions__bank-pdf';
  await db.videos.add({ id: videoId, name: '试卷.pdf', kind: 'material', materialFormat: 'pdf', duration: 0, createdAt: 1 });
  await db.videos.add({ id: fileId, name: '试卷 · 题库.md', kind: 'material', materialFormat: 'md', duration: 0, createdAt: 1 });
  const questions = Array.from({ length: 7 }, (_, i) => ({ stem: `${i + 1}. 原题`, options: ['甲', '乙', '丙', '丁'], answer: 1,
    answerSource: 'original', explanation: '原文答案 B，原文未附解析。', source: { courseId: videoId, page: 1 }, images: [`#source-image/${videoId}/page-1`] }));
  await db.files.add({ id: fileId, blob: new Blob(['```quiz\n' + JSON.stringify({ questions }) + '\n```']) });
  const sessionId = await newSession(videoId);
  const seen = serve([
    { toolCalls: [call('bank-path', 'present_quiz', { path: '/courses/current/questions.md', limit: 5 })], finish: 'tool_calls' },
    { content: '请作答。' },
  ]);
  const { r, sink } = recorder();
  const res = await runQa({ videoId, sessionId, text: '开始做原题', materialKind: 'page', materialFormat: 'pdf' }, sink);
  assertRequestsLegal(seen, '题库');
  assert.equal(r.cards.length, 1);
  assert.equal(res.quiz.data.questions.length, 5);
  assert.deepEqual(res.quiz.data.questions[0].source, questions[0].source);
  assert.deepEqual(res.quiz.data.questions[0].images, questions[0].images);
  assert.deepEqual(res.quiz.data.bank, { path: '/courses/current/questions.md', offset: 0, total: 7 });
  assert.deepEqual((await db.chats.get(res.rowId)).quiz, res.quiz);
  const nextSeen = serve([{ content: '接着做下一批。' }]);
  await runQa({ videoId, sessionId, text: '继续', materialKind: 'page', materialFormat: 'pdf' });
  assert.match(nextSeen[0].messages.at(-1).content, /题库练习快照[\s\S]*offset=5/);
  assert.ok(nextSeen[0].messages.some(message => message.role === 'tool'), '原始题库工具证据跨轮次保留');
});

await test('show_widget：多图各有正文引用，回调、结果与落库保留全部载荷', async () => {
  const sessionId = await newSession();
  const seen = serve([
    { toolCalls: ['第一幅', '第二幅'].map((text, index) => call(`widget-${index}`, 'show_widget', { format: 'html', code: `<p>${text}</p>` })), finish: 'tool_calls' },
    { content: '对照两幅图。' },
  ]);
  const { r, sink } = recorder();
  const res = await runQa(ASK({ sessionId, text: '比较两种情况' }), sink);
  assertRequestsLegal(seen, '多图');
  assert.equal(r.cards.length, 2);
  assert.ok(r.cards.every((card) => card.kind === 'widget'));
  assert.deepEqual(res.widgets, r.cards.map((card) => card.widget));
  assert.equal(res.widget.id, res.widgets[1].id);
  const results = seen[1].messages.filter((message) => message.role === 'tool');
  res.widgets.forEach((widget, index) => {
    assert.equal(widget.ref, widget.id);
    assert.ok(results[index].content.includes('```wbw-widget\n' + widget.ref + '\n```'));
  });
  const row = await db.chats.get(res.rowId);
  assert.deepEqual(row.widgets, res.widgets);
  assert.equal(row.widget.id, row.widgets[1].id);
});

await test('show_widget 后停止：保留已完成图形，刷新与远端收尾不丢图', async () => {
  const sessionId = await newSession();
  const controller = new AbortController();
  serve([
    { toolCalls: [call('widget-stop', 'show_widget', { format: 'html', code: '<p>已完成图形</p>' })], finish: 'tool_calls' },
    { content: '继续说明' },
  ]);
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    init.signal?.throwIfAborted();
    return fetch(url, init);
  };
  const res = await runQa(ASK({ sessionId, text: '画一幅图' }), {
    signal: controller.signal,
    onCard: () => controller.abort(),
  });
  assert.match(res.content, /已停止生成/);
  assert.equal(res.widgets.length, 1);
  assert.deepEqual((await db.chats.get(res.rowId)).widgets, res.widgets);
});

await test('技能范围：提示词只列范围内技能，use_skill 也真的拒绝范围外的', async () => {
  const sessionId = await newSession();
  const seen = serve([
    { toolCalls: [call('c1', 'read', { path: `/skills/${SKILL_B}` })], finish: 'tool_calls' },
    { content: '课程里没有讲到这个，我按字幕作答。' },
  ]);
  const { r, sink } = recorder();
  const res = await runQa(ASK({ sessionId, skillIds: [skillAId] }), sink);
  assertRequestsLegal(seen, '技能范围');

  const sys = seen[0].messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  assert.match(sys, new RegExp(SKILL_A), '范围内的技能要列进提示词');
  assert.ok(!sys.includes(SKILL_B), '范围外的技能不能出现在清单里');

  // ⚠️ 这一条是**行为修正**：面板原来构造 executor 时没传 allowedSkillIds，
  // 于是范围只管住了提示词，use_skill 照样放行 —— 用户收到白名单形同虚设。
  const toolMsg = seen[1].messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '工具结果没进下一轮请求');
  assert.match(toolMsg.content, /不在本次会话的可选技能范围内/, '工具层必须真的拒绝范围外的技能');
  assert.ok(!toolMsg.content.includes('乙的正文'), '拒绝时不能把正文泄露出去');
  assert.equal(res.content, '课程里没有讲到这个，我按字幕作答。');
});

// ── 7. 历史：第二轮带上上一轮的一问一答，且不含工具消息 ─────────────────────

await test('历史：用户原始运行上下文与答案逐字重放，工具仍封装在 UI 行内', async () => {
  const sessionId = await newSession();
  serve([{ content: '第一轮的答案。' }]);
  await runQa(ASK({ sessionId, text: '第一轮问的是什么？' }), recorder().sink);
  const seen = serve([
    { toolCalls: [call('c1', 'grep', { query: '贝叶斯', path: '/courses/current' })], finish: 'tool_calls' },
    { content: '第二轮的答案。' },
  ]);
  await runQa(ASK({ sessionId, text: '第二轮问的是什么？' }), recorder().sink);
  assertRequestsLegal(seen, '历史');

  const second = seen[1].messages.filter(m => m.role !== 'system');
  // 历史是「system + 上一轮落库的一问一答」，工具往返消息由本轮循环现攒、不进历史
  assert.equal(second[0].role, 'user');
  assert.match(second[0].content, /第一轮问的是什么？$/);
  assert.match(second[0].content, /贝叶斯入门/);
  assert.equal(second[1].role, 'assistant');
  assert.equal(second[1].content, '第一轮的答案。');
  assert.equal(second[2].role, 'user');
  assert.match(second[2].content, /第二轮问的是什么？$/);
  assert.equal(second[3].tool_calls[0].function.name, 'grep');
  assert.equal(second[4].role, 'tool');
  assert.equal(
    (await rowsOf(sessionId)).length,
    4,
    '两轮共四行：工具往返与 assistant 的工具调用轮都不额外落库',
  );
});

await test('跨轮次：图片、工具往返、usage 与完整请求前缀在数据库重开后保持稳定', async () => {
  const sessionId = await newSession();
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,cGljdHVyZQ==' } };
  const first = serve([
    { toolCalls: [call('durable-call', 'grep', { query: '贝叶斯', path: '/courses/current' })], finish: 'tool_calls', usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } } },
    { content: '已核对原文', usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 900 } } },
  ]);
  await runQa(ASK({ sessionId, images: [image], shotCount: 1 }), recorder().sink);
  const key = (await db.chatSessions.get(sessionId)).promptCacheKey;
  const rows = await rowsOf(sessionId);
  assert.deepEqual(rows[1].modelTrace.messages.map(m => m.role), ['assistant', 'tool', 'assistant']);
  assert.equal(rows[0].modelRequests.length, 2);
  db.close(); await db.open();
  const next = serve([{ content: '第二轮完成' }]);
  await runQa(ASK({ sessionId, text: '继续', videoName: '改名后的课程', shotCount: 0 }), recorder().sink);
  assert.deepEqual(next[0].messages.slice(0, first[1].messages.length), first[1].messages);
  assert.deepEqual(next[0].tools, first[1].tools);
  assert.equal((await db.chatSessions.get(sessionId)).promptCacheKey, key);
  assert.ok(next[0].messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')));
  assertRequestsLegal(next, '跨轮次重放');
  const baseline = await readModelUsageReport();
  assert.ok(baseline.total.cacheRead >= 900);
  assert.equal(baseline.total.lastRequest, undefined, '缺 usage 的最后一次请求不冒充前一轮的测量');
});

await test('压缩检查点：整轮裁剪，预算恢复和数据库重开均不复活旧前缀', async () => {
  const sessionId = await newSession();
  const rows = [];
  for (let i = 0; i < 8; i++) for (const role of ['user', 'assistant']) {
    const row = { videoId: 'v1', sessionId, role, content: `${i}:` + '文'.repeat(200), createdAt: rows.length };
    rows.push({ ...row, id: await db.chats.add(row) });
  }
  const kept = await fitModelHistory(sessionId, rows, 1000);
  assert.ok(kept.length < rows.length); assert.equal(kept[0].role, 'user');
  db.close(); await db.open();
  assert.deepEqual(await fitModelHistory(sessionId, rows, 10000), kept);
  const changed = rows.map(row => row.id === kept[0].id ? { ...row, content: '编辑后的边界' } : row);
  assert.deepEqual(await fitModelHistory(sessionId, changed, 10000), changed);
});

// ── 8. 空回答兜底：只返回不落库 ────────────────────────────────────────────

await test('空回答兜底：返回说清停因的文案，但不落库（rowId 为空）', async () => {
  const sessionId = await newSession();
  // 第 1 轮：说了句旁白然后去检索；第 2 轮：只有思考、正文空、也不调工具 → empty 闸。
  // 之后的宽限轮重复最后一条脚本，于是「两次都不吭声」，最终 granted=false。
  const seen = serve([
    { content: '我先查一下…', toolCalls: [call('c1', 'grep', { query: '贝叶斯', path: '/courses/current' })], finish: 'tool_calls' },
    { reasoning: '在想…', finish: 'stop' },
  ]);
  const { r, sink } = recorder();
  const res = await runQa(ASK({ sessionId }), sink);
  assertRequestsLegal(seen, '空回答兜底');

  assert.equal(res.rowId, undefined, '兜底文案不是正式回答，不落库');
  assert.match(res.content, /空回复/, '要说清是哪一种「没答上来」（不能猜成「已到轮次上限」）');
  assert.match(res.content, /它最后说到：我先查一下/, '要带上它干了什么（最后一轮旁白）');
  assert.match(res.content, /它停在这里：正在检索：贝叶斯/, '要带上它最后在干什么（最后一次工具提示）');
  assert.equal(r.stops.length, 1, '停因要如实报出（empty）');
  assert.equal(r.stops[0].reason, 'empty');
  assert.deepEqual((await rowsOf(sessionId)).map((x) => x.role), ['user'], '只留用户那一行');
});

// ── 9. 材料课程：工具集与提示词走材料那一支 ────────────────────────────────

await test('材料课程：提示词与工具集换成材料那一支（不给不存在的字幕检索）', async () => {
  const sessionId = await newSession('m1');
  const seen = serve([{ content: '第 1 页讲的是条件概率的乘法形式。[第1页]' }]);
  const res = await runQa(
    {
      videoId: 'm1',
      sessionId,
      text: '第一页讲了什么？',
      materialKind: 'page',
      materialFormat: 'pdf',
    },
    recorder().sink,
  );
  assertRequestsLegal(seen, '材料课程');
  const sys = seen[0].messages[0].content;
  assert.match(sys, /阅读材料/, '走 qaSystemMaterial');
  assert.match(sys, /grep/, '材料课程指向资源检索');
  assert.ok(!sys.includes('search_transcript'));
  assert.ok(seen[0].tools.includes('grep'));
  assert.ok(seen[0].tools.includes('read'));
  assert.ok(!seen[0].tools.includes('search_transcript'));
  assert.ok(!seen[0].tools.includes('edit_markdown'), '只有 md 且编辑面开着才注册 edit_markdown');
  assert.equal(res.content, '第 1 页讲的是条件概率的乘法形式。[第1页]');
});

// ── 10. 工具提示文案单点维护（面板与链路 host 共用同一套措辞）──────────────

await test('qaToolHint：同一个工具名在两处给同一句话，认不出时退回通用文案', () => {
  assert.equal(qaToolHint('search_transcript', JSON.stringify({ query: '贝叶斯' }), false), '正在检索：贝叶斯');
  assert.equal(qaToolHint('search_material', JSON.stringify({ query: '条件概率' }), true), '正在检索材料：条件概率');
  assert.equal(qaToolHint('use_skill', JSON.stringify({ name: '甲' }), false), '正在加载技能：甲');
  assert.equal(qaToolHint('show_widget', '{}', false), '正在预检图形…');
  assert.equal(qaToolHint('未知工具', '{}', false), '正在检索字幕…');
  assert.equal(qaToolHint('search_transcript', '{不是合法JSON', false), '正在检索字幕…', '参数坏了要退回通用文案');
});

// ── 收尾 ──────────────────────────────────────────────────────────────────

await db.close();
rmSync(OUT, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
