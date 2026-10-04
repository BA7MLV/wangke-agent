#!/usr/bin/env node
/**
 * agent 循环的**端到端**不变量测试：假网关 + 真 `runAgentLoop`。
 *
 * ## 为什么 `test-agent-guard.mjs` / `test-message-hygiene.mjs` 还不够
 *
 * 那两个脚本守的是纯逻辑。而这个 400 的诡异之处正在于**它不在纯逻辑里**：
 * 主循环每一步单看都合理（push 一条空回复、护栏停下不执行工具），
 * 只有把整条链跑完、把**每一次请求体**摊开看，才会发现有一条是非法的。
 *
 * 所以这里做的是端到端：esbuild 把 `src/` 打成 bundle（Node 不做无扩展名解析），
 * 假 fetch 逐轮吐出编排好的 SSE，捕获**每一个** `/chat/completions` 的请求体，
 * 对每一条消息跑一遍与网关同一套校验。全程零网络、零 key、不起服务。
 *
 * ## 核心断言
 *
 * 1. **任何一次请求都不含非法消息**（这是网关 400 的唯一来源）；
 * 2. 三条真实触发路径（empty / loop / 截断）都能走到最后、拿到一句人话，
 *    而不是抛 400；
 * 3. 护栏触发时 `onStop` 报出的停因与轮数是真的（不是靠猜的兜底文案）。
 *
 * 运行：node scripts/test-agent-loop.mjs
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const OUT = mkdtempSync(join(tmpdir(), 'agent-loop-'));

// zustand/persist 在导入期就要看到 localStorage（Node 里没有），给个最小桩
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// ⚠️ 必须打成一个入口（而不是多个 entryPoints）：多个入口各打一份 settings.js，
// 于是「改 store」改的是另一份实例，agent 那边读到的仍是没配凭据的默认 state。
// 单入口 + re-export 才能保证 store 是同一个（与 test-thinking-depth.mjs 同理）。
const entry = join(OUT, 'entry.ts');
writeFileSync(
  entry,
  `export { runAgentLoop } from '${join(ROOT, 'src/harness/agent.ts')}';
   export { messageDefects, sanitizeMessages } from '${join(ROOT, 'src/api/messageHygiene.ts')}';
   export { useSettings } from '${join(ROOT, 'src/store/settings.ts')}';
  `,
);
await build({
  entryPoints: [entry],
  outfile: join(OUT, 'bundle.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  // 全部打进 bundle：产物落在临时目录里，外部依赖（zustand）在那儿解析不到
  define: { 'process.env.NODE_ENV': '"test"' },
});
const { runAgentLoop, messageDefects, sanitizeMessages, useSettings } = await import(
  pathToFileURL(join(OUT, 'bundle.mjs')).href
);

// 给 chat 槽位配一家带凭据的供应商（端点不真用，假网关会接管）。
// 多供应商后 agent 要先解析出「端点 + 凭据」，缺 key 会抛中文错；这条测试不关心凭据，
// 但需要一个能解析出目标的环境 —— 改 store 比造一份 localStorage 干净。
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
});

// ── 假网关 ────────────────────────────────────────────────────────────────

/** 一个 assistant SSE 轮次：正文 / 思考 / 工具调用 / finish_reason */
function sse({ content = '', reasoning = '', toolCalls = [], finish = 'stop' }) {
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
    seen.push(body.messages);
    const chunk = script[Math.min(i, script.length - 1)];
    i++;
    return new Response(sse(chunk), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return seen;
}

/** 与网关同一套校验：每条消息都要过不变量 */
function assertAllRequestsLegal(seen, label) {
  assert.ok(seen.length > 0, `${label}：一次请求都没发出`);
  for (const [i, messages] of seen.entries()) {
    const dump = messages
      .map((m, j) => `      [${j}] ${m.role} content=${JSON.stringify(m.content)?.slice(0, 40)} tool_calls=${m.tool_calls?.length ?? '-'} id=${m.tool_call_id ?? '-'}`)
      .join('\n');
    const defects = messageDefects(messages);
    assert.deepEqual(defects, [], `${label}：第 ${i + 1} 次请求含非法消息\n${defects.join('\n')}\n${dump}`);
    // 网关另外会拒的两种形态：content 为空串的 assistant、content: [] 的数组
    for (const m of messages) {
      if (m.role !== 'assistant') continue;
      assert.ok(
        Array.isArray(m.content) ? m.content.length > 0 : true,
        `${label}：第 ${i + 1} 次请求出现 content: [] 的 assistant\n${dump}`,
      );
      if (m.tool_calls === undefined) {
        assert.equal(typeof m.content, 'string', `${label}：第 ${i + 1} 次请求的 assistant 正文不是字符串\n${dump}`);
      }
    }
    // 只属于「这一轮」的字段不能回传：reasoning_content 重复计费，finish_reason 是元数据
    for (const m of messages) {
      assert.equal('reasoning_content' in m, false, `${label}：reasoning_content 被回传了\n${dump}`);
      assert.equal('finish_reason' in m, false, `${label}：finish_reason 被回传了\n${dump}`);
    }
  }
}

const TOOLS = [
  {
    type: 'function',
    function: { name: 'search_material', description: '检索材料', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
  },
];
const seenTools = [];
const exec = async (name, args) => {
  seenTools.push(`${name}:${JSON.stringify(args)}`);
  return `命中 ${args.query ?? ''}`;
};
/** 每个用例开始前清账：seenTools 是模块级的，串味会让断言看着像真 bug */
const resetTools = () => {
  seenTools.length = 0;
};
const sys = (content) => ({ role: 'system', content });
const u = (content) => ({ role: 'user', content });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// ── 用例 ──────────────────────────────────────────────────────────────────

await test('正常路径：查到材料就作答，三条请求全部合法', async () => {
  resetTools();
  const seen = serve([
    { reasoning: '想先查一下', toolCalls: [call('c1', 'search_material', { query: '贝叶斯' })], finish: 'tool_calls' },
    { content: '根据材料，贝叶斯定理讲的是…' },
  ]);
  const deltas = [];
  const out = await runAgentLoop([sys('系统提示'), u('贝叶斯是什么')], TOOLS, exec, { onDelta: (t) => deltas.push(t) });
  assertAllRequestsLegal(seen, '正常路径');
  assert.equal(deltas.join(''), '根据材料，贝叶斯定理讲的是…');
  assert.deepEqual(seenTools, ['search_material:{"query":"贝叶斯"}']);
  assert.equal(out[out.length - 1].content, '根据材料，贝叶斯定理讲的是…');
});

await test('回归 · empty 闸：只吐思考、正文空、也没调工具 → 收尾轮不再 400', async () => {
  // 修复前：runAgentLoop 会抛 `Invalid assistant message: content or tool_calls must be set`
  resetTools();
  const seen = serve([
    { reasoning: '我在想…', finish: 'stop' },
    { content: '抱歉，刚才那轮我没说出话。我已经确认这道题考的是条件概率。' },
  ]);
  const deltas = [];
  const stops = [];
  const out = await runAgentLoop([sys('系统提示'), u('条件概率怎么讲')], TOOLS, exec, {
    onDelta: (t) => deltas.push(t),
    onStop: (info) => stops.push(info),
  });
  assertAllRequestsLegal(seen, 'empty 闸');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].reason, 'empty', '停因要如实报 empty，不能猜成「已到轮次上限」');
  assert.equal(stops[0].rounds, 1);
  assert.equal(stops[0].granted, true, '宽限轮说到了话，收尾算成功');
  assert.match(deltas.join(''), /条件概率/);
  // 分工要钉死：`out` **保留**那条空回复（它记录的是「这一轮真的什么都没说」，上层要靠它
  // 判断该不该出兜底文案），清洗只发生在发出去的那份副本上。
  // 所以「`out` 合法」是错的断言，「发出去的合法」才是对的。
  assert.equal(out[2].role, 'assistant');
  assert.equal(out[2].content, null);
  assert.equal(messageDefects(out).length, 1, '返回的历史如实记录空回复');
  assert.deepEqual(messageDefects(sanitizeMessages(out)), [], '发出去的那份必须干净');
});

await test('回归 · empty 闸且宽限轮也不吭声：出兜底文案，全程零非法请求', async () => {
  const seen = serve([{ reasoning: '在想…', finish: 'stop' }]);
  const stops = [];
  await runAgentLoop([sys('系统提示'), u('问')], TOOLS, exec, { onStop: (info) => stops.push(info) });
  assertAllRequestsLegal(seen, 'empty 闸 · 两次都不吭声');
  assert.equal(stops[0].granted, false);
  assert.equal(stops[0].reason, 'empty');
});

await test('回归 · loop 闸：在执行前 break，那批 tool_calls 仍能安全发出去', async () => {
  resetTools();
  const seen = serve([
    { toolCalls: [call('c1', 'search_material', { query: '贝叶斯' })], finish: 'tool_calls' },
    // 第二轮原地打转：同样的工具、一样的参数 → ledger 命中，在执行前 break
    { toolCalls: [call('c2', 'search_material', { query: '贝叶斯' })], finish: 'tool_calls' },
    { content: '我查到的材料说的是…' },
  ]);
  const stops = [];
  await runAgentLoop([sys('系统提示'), u('贝叶斯')], TOOLS, exec, { onStop: (info) => stops.push(info) });
  assertAllRequestsLegal(seen, 'loop 闸');
  assert.equal(stops[0].reason, 'loop');
  assert.equal(stops[0].detail, 'search_material');
  assert.equal(stops[0].rounds, 2);
  assert.deepEqual(seenTools, ['search_material:{"query":"贝叶斯"}'], '重复的那个调用不能真被执行');
  // 收尾轮那次请求里，悬空的 c2 必须被补上结果
  const last = seen[seen.length - 1];
  assert.ok(last.some((m) => m.role === 'tool' && m.tool_call_id === 'c2'), '悬空调用没有被补齐');
});

await test('回归 · 截断（finish_reason: length）：参数可能残缺，一个都不执行', async () => {
  resetTools();
  const seen = serve([
    // html 形态的图形卡几乎必然撑爆 max_tokens：参数是半截的，但仍是合法 JSON
    { toolCalls: [call('c1', 'search_material', { query: '贝叶斯' })], finish: 'length' },
    { toolCalls: [call('c2', 'search_material', { query: '贝叶斯' })], finish: 'tool_calls' },
    { content: '根据材料，结论是…' },
  ]);
  await runAgentLoop([sys('系统提示'), u('贝叶斯')], TOOLS, exec, {});
  assertAllRequestsLegal(seen, '截断闸');
  assert.deepEqual(
    seenTools,
    ['search_material:{"query":"贝叶斯"}'],
    '被截断那一轮的调用不能执行（参数残缺），只有重发的那次才算',
  );
  // 下一轮请求里必须看得见「为什么没执行」，否则模型只会换个说法再试一次
  const afterTruncate = seen[1];
  const note = afterTruncate.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
  assert.ok(note, '截断说明没有进历史');
  assert.match(note.content, /max_tokens/, '失败结果要说清是被输出上限截断');
  assert.equal(seenTools.length, 1, '补了失败结果后模型重发的那次才真的执行');
});

await test('回归 · 残缺轮次（finish_reason: error）：不进历史、不重放、也不收尾', async () => {
  const seen = serve([{ reasoning: '想了一半…', finish: 'error' }]);
  const stops = [];
  const out = await runAgentLoop([sys('系统提示'), u('问')], TOOLS, exec, { onStop: (info) => stops.push(info) });
  assertAllRequestsLegal(seen, '残缺轮次');
  assert.equal(seen.length, 1, '不该为残缺轮次再发一次收尾请求');
  assert.equal(stops[0].reason, 'error');
  assert.equal(stops[0].granted, false);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user'], '残缺轮次不能留在历史里');
});

await test('轮次闸：轮数用完也能安全收尾（out 末尾是 tool 消息）', async () => {
  const seen = serve([
    { toolCalls: [call('c1', 'search_material', { query: 'a1' })], finish: 'tool_calls' },
    { toolCalls: [call('c2', 'search_material', { query: 'a2' })], finish: 'tool_calls' },
    { content: '两轮查到的材料汇总如下…' },
  ]);
  const stops = [];
  await runAgentLoop([sys('系统提示'), u('问')], TOOLS, exec, { onStop: (i) => stops.push(i) }, 2);
  assertAllRequestsLegal(seen, '轮次闸');
  assert.equal(stops[0].reason, 'rounds');
  assert.equal(stops[0].rounds, 2, '轮数必须是真跑过的，不能拿上限顶');
});

await test('token 闸：材料堆到预算就停，收尾请求依然合法', async () => {
  resetTools();
  // 必须真的堆过预算：闸 = 窗口 − 输入 − answerReserve(窗口)，默认窗口下约 8.8 万 token，
  // 所以 40 万字符（≈28 万 token）才够得着。给小了会静默地走到轮次闸，测的就不是它了。
  const big = 'x'.repeat(400_000);
  const seen = serve([
    { toolCalls: [call('c1', 'search_material', { query: 'a1' })], finish: 'tool_calls' },
    { toolCalls: [call('c2', 'search_material', { query: 'a2' })], finish: 'tool_calls' },
    { content: '我读了这些材料，结论是…' },
  ]);
  const stops = [];
  // 走一遍真实的记账路径（exec 里会 push seenTools），只把返回值换成超大材料
  const bigExec = async (name, args) => {
    seenTools.push(`${name}:${JSON.stringify(args)}`);
    return big;
  };
  await runAgentLoop([sys('系统提示'), u('问')], TOOLS, bigExec, { onStop: (i) => stops.push(i) }, 9);
  assertAllRequestsLegal(seen, 'token 闸');
  assert.equal(stops.length, 1, '闸触发了就必须通报，否则界面只剩空气泡');
  assert.equal(stops[0].reason, 'tokens', `停因报的是 ${stops[0]?.reason}`);
  assert.equal(seenTools.length, 1, `堆爆预算后不该再执行第二个调用（实际 ${seenTools.length} 个）`);
  assert.match(String(stops[0].detail), /^\d+$/, 'tokens 闸要报出累积 token 数，兜底文案靠它解释');
});

await test('中途 abort：AbortError 照旧抛给调用方（不被误判成「未获得回答」）', async () => {
  serve([{ content: '开始说话…' }]);
  const ac = new AbortController();
  globalThis.fetch = async (_url, init) => {
    // 让请求挂在 abort 上，等价于「用户在流式中途按了停止」
    await new Promise((resolve, reject) => {
      const fail = () => reject(new DOMException('aborted', 'AbortError'));
      if (init.signal.aborted) fail();
      else init.signal.addEventListener('abort', fail);
    });
  };
  ac.abort();
  await assert.rejects(
    () => runAgentLoop([sys('系统提示'), u('问')], TOOLS, exec, { signal: ac.signal }),
    (e) => e.name === 'AbortError',
  );
});

rmSync(OUT, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
