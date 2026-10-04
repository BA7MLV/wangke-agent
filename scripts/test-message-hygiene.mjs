#!/usr/bin/env node
/**
 * 消息卫生（发请求前的唯一收口点）的断言。
 *
 * 守的是那个真实 400：`Invalid assistant message: content or tool_calls must be set`
 * （以及它的兄弟 `tool_calls must be followed by tool messages`）。这两条**只在
 * 「下一次请求」才暴露**，所以纯看主循环的代码永远看不出来 —— 必须直接对着
 * 「agent 循环会攒出什么样的 `out`」去测。
 *
 * 所以这里的核心断言不是逐例的期望值，而是**不变量**：
 *   `sanitizeMessages` 的输出，对任意输入都满足「assistant 要么有正文要么有 tool_calls」
 *   且「每个 tool_call 都有人应答」。最后三组用例把 agent.ts 的三条真实路径
 *   （empty / loop / 收尾轮）原样还原成 `out`，作为回归形状钉死。
 *
 * 另一条同等重要的元断言：**测试自己不能是空转的** —— 脏历史必须能被
 * `messageDefects` 检出来，否则上面的不变量可能只是「因为检查器坏了才通过」。
 *
 * 运行：node scripts/test-message-hygiene.mjs
 */
import assert from 'node:assert/strict';

const { assertRequestSafe, describeMessage, isUnreplayable, messageDefects, sanitizeMessages, syntheticToolResult } =
  await import('../src/api/messageHygiene.ts');
// diagnose400 住在 siliconflow.ts（那里才有 textOf / ApiError）；esbuild 打一遍 bundle 拿它
const { diagnose400 } = await (async () => {
  const { build } = await import('esbuild');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const out = mkdtempSync(join(tmpdir(), 'hygiene-diag-'));
  await build({
    entryPoints: [join(new URL('..', import.meta.url).pathname, 'src/api/siliconflow.ts')],
    outdir: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  return import(pathToFileURL(join(out, 'siliconflow.js')).href);
})();

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.error(`  FAIL - ${name}\n        ${e.message}`);
  }
}

/** assistant 消息（只写关心的字段，省得每个用例都拖一串） */
const a = (content, toolCalls, finishReason) => ({
  role: 'assistant',
  content,
  ...(toolCalls ? { tool_calls: toolCalls } : {}),
  ...(finishReason ? { finish_reason: finishReason } : {}),
});
/** assistant 工具调用（只写关心的字段，省得每个用例都拖一串） */
const call = (id, name, args = '{}') => ({ id, type: 'function', function: { name, arguments: args } });
const t = (id, content, name = 'x') => ({ role: 'tool', tool_call_id: id, name, content });
const u = (content) => ({ role: 'user', content });
const sys = (content) => ({ role: 'system', content });

// ─────────────────────────────────────────────────────────────────────────
// 1. 元断言：检查器本身能看见缺陷（否则后面全在自欺欺人）
// ─────────────────────────────────────────────────────────────────────────

test('元断言：脏历史能被 messageDefects 检出来', () => {
  const blank = messageDefects([a(null)]);
  assert.equal(blank.length, 1, '空 assistant 要被检出');
  assert.match(blank[0], /既没有正文也没有 tool_calls/);

  const orphan = messageDefects([a(null, [call('c1', 'search_material')])]);
  assert.equal(orphan.length, 1, '没人应答的 tool_call 要被检出');
  assert.match(orphan[0], /没有配对的 tool 消息/);

  const stray = messageDefects([u('hi'), t('nope', '结果')]);
  assert.equal(stray.length, 1, '查无此事的 tool 结果要被检出');
  assert.match(stray[0], /没有对应的调用/);

  assert.deepEqual(messageDefects([sys('s'), u('hi'), a('答')]), [], '干净历史不该有缺陷');
});

test('元断言：assertRequestSafe 对脏历史抛错、对干净历史不抛', () => {
  assert.throws(() => assertRequestSafe([u('hi'), a(null)]), /消息历史不合法/);
  assert.doesNotThrow(() => assertRequestSafe([sys('s'), u('hi'), a('答')]));
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 空 assistant：本 bug 的直接来源
// ─────────────────────────────────────────────────────────────────────────

test('空 assistant（content: null，无 tool_calls）被丢弃', () => {
  const out = sanitizeMessages([sys('系统'), u('问题'), a(null), u('追问')]);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'user']);
  assert.doesNotThrow(() => assertRequestSafe(out));
});

test('空 assistant 的各种「空」形态一视同仁（网关只看有没有正文）', () => {
  for (const blank of [null, '', '   ', '\n\t', [{ type: 'text', text: '' }], [{ type: 'text', text: '  ' }]]) {
    const out = sanitizeMessages([u('q'), a(blank)]);
    assert.deepEqual(out.map((m) => m.role), ['user'], `空形态 ${JSON.stringify(blank)} 应被丢弃`);
    assertRequestSafe(out);
  }
});

test('assistant 带 tool_calls 时保留，content 收敛成 null（纯调工具的常态）', () => {
  const out = sanitizeMessages([u('q'), a('', [call('c1', 'list_courses')]), t('c1', '[]', 'list_courses')]);
  assert.equal(out.length, 3);
  assert.equal(out[1].role, 'assistant');
  assert.equal(out[1].content, null, '空数组 / 空串都归一成 null，绝不把 content: [] 发出去');
  assert.equal(out[1].tool_calls.length, 1);
  assertRequestSafe(out);
});

test('assistant 有正文时原样保留（一个字都不动）', () => {
  const out = sanitizeMessages([u('q'), a('  结论在这里  ')]);
  assert.equal(out[1].content, '  结论在这里  ', '不能顺手 trim：正文是模型原话');
});

test('只由图片段组成的 assistant（无正文无 tool_calls）也走丢弃分支', () => {
  const out = sanitizeMessages([u('q'), a([{ type: 'image_url', image_url: { url: 'data:,' } }])]);
  assert.deepEqual(out.map((m) => m.role), ['user'], 'assistant 的图片段不构成正文，发出去仍是非法消息');
  assertRequestSafe(out);
});

test('残缺轮次（finish_reason: error / aborted）不重放', () => {
  assert.equal(isUnreplayable('error'), true);
  assert.equal(isUnreplayable('aborted'), true);
  assert.equal(isUnreplayable('length'), false);
  assert.equal(isUnreplayable(undefined), false, '网关没给 finish_reason 时不能当成残缺');
  const out = sanitizeMessages([
    u('q'),
    a(null, undefined, 'error'),
    a('半截正文', undefined, 'aborted'),
    a('完整正文'),
  ]);
  assert.deepEqual(out.map((m) => m.content), ['q', '完整正文'], '两条残缺轮次都不该进历史');
  assertRequestSafe(out);
});

test('残缺轮次带 tool_calls 时，它的结果也一起走人（否则留下孤儿 tool 结果）', () => {
  const out = sanitizeMessages([u('q'), a(null, [call('c1', 'read')], 'aborted'), t('c1', '文件内容')]);
  assert.deepEqual(out.map((m) => m.role), ['user']);
  assertRequestSafe(out);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 孤儿 tool_call：补结果，而不是丢掉那条 assistant
// ─────────────────────────────────────────────────────────────────────────

test('序列末尾悬空的 tool_call 被补上合成结果', () => {
  const out = sanitizeMessages([u('q'), a(null, [call('c1', 'search_material')])]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(out[2].tool_call_id, 'c1');
  assert.equal(out[2].name, 'search_material');
  assert.match(out[2].content, /没有执行/);
  assert.equal(out[2].content, syntheticToolResult('search_material'));
  assertRequestSafe(out);
});

test('合成结果明确劝模型别再调（否则它会换个说法重试，又进循环检测）', () => {
  assert.match(syntheticToolResult('search_material'), /请不要再调用它/);
});

test('下一个 assistant 打断上一批调用时，先给悬空的那批补齐', () => {
  const out = sanitizeMessages([
    u('q'),
    a(null, [call('c1', 'list_courses')]),
    a('直接回答'),
  ]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(out[2].tool_call_id, 'c1');
  assertRequestSafe(out);
});

test('user 消息打断工具流时同样补齐（这条最容易漏：护栏停下 → 塞一句 nudge → 就非法了）', () => {
  const out = sanitizeMessages([u('q'), a(null, [call('c1', 'list_courses')]), u('（系统提示：不能再调用任何工具，请用中文总结）')]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'user'], '悬空调用要在 nudge 之前补齐');
  assert.equal(out[3].content.includes('系统提示'), true);
  assertRequestSafe(out);
});

test('一半有结果一半悬空：只补缺的那个（不能重复补）', () => {
  const out = sanitizeMessages([
    u('q'),
    a(null, [call('c1', 'a'), call('c2', 'b'), call('c3', 'c')]),
    t('c1', '结果一', 'a'),
    t('c3', '结果三', 'c'),
  ]);
  const tools = out.filter((m) => m.role === 'tool');
  assert.deepEqual(tools.map((m) => m.tool_call_id), ['c1', 'c3', 'c2'], '已应答的原位保留，c2 追加在末尾');
  assert.equal(tools[2].content, syntheticToolResult('b'));
  assertRequestSafe(out);
});

test('没有 id 的 tool_call 与它的结果一起丢（永远无法被应答）', () => {
  const out = sanitizeMessages([u('q'), a('正文', [call('', 'bogus')]), t('', '结果', 'bogus')]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant']);
  assert.equal(out[1].tool_calls, undefined, '空数组也不能留（部分网关对 tool_calls: [] 会挑刺）');
  assertRequestSafe(out);
});

// ─────────────────────────────────────────────────────────────────────────
// 4. system 消息对 tool-call 记账是透明的（pi 的 heldSystemMessages）
// ─────────────────────────────────────────────────────────────────────────

test('夹在调用与结果之间的 system 消息被扣下，排在合成结果之后', () => {
  const out = sanitizeMessages([sys('首个系统提示'), u('q'), a(null, [call('c1', 'x')]), sys('追加系统提示'), u('继续')]);
  assert.deepEqual(
    out.map((m) => `${m.role}:${m.role === 'system' ? m.content : ''}`),
    ['system:首个系统提示', 'user:', 'assistant:', 'tool:', 'system:追加系统提示', 'user:'],
    '追加的 system 提示不能插在「有调用没结果」的缝里',
  );
  assertRequestSafe(out);
});

test('没有悬空调用时 system 消息原位通过（无谓地挪动会改变它的语义位置）', () => {
  const out = sanitizeMessages([sys('s1'), u('q'), a('答'), sys('s2'), u('再问')]);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'system', 'user']);
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 其余角色的归一化
// ─────────────────────────────────────────────────────────────────────────

test('空 user / system 被丢弃（没有语义，且部分网关会拒）', () => {
  const out = sanitizeMessages([sys(''), u('q'), u('   '), a('答'), sys(null)]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant']);
  assertRequestSafe(out);
});

test('孤儿 tool 结果（查无此事的记录）被丢弃', () => {
  const out = sanitizeMessages([u('q'), a('答'), t('ghost', '上次跑剩下的')]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant']);
  assertRequestSafe(out);
});

test('空 tool 结果补成一句可见的话（模型要能分辨「工具什么都没给」和「工具没跑」）', () => {
  const out = sanitizeMessages([u('q'), a(null, [call('c1', 'x')]), t('c1', '   ')]);
  assert.equal(out[2].content, '（工具没有返回内容）');
  assertRequestSafe(out);
});

// ─────────────────────────────────────────────────────────────────────────
// 6. 元性质：幂等 + 不改入参
// ─────────────────────────────────────────────────────────────────────────

test('幂等：sanitize(sanitize(x)) 与 sanitize(x) 逐字相同', () => {
  const dirty = [
    sys('s'),
    u('q'),
    a('检索中…', [call('c1', 'a'), call('c2', 'b')]),
    t('c1', '结果'),
    a(null),
    sys('追加'),
    t('ghost', '孤儿'),
    a(null, [call('c3', 'c')], 'aborted'),
    u(''),
    a(null, [call('c4', 'd')]),
  ];
  const once = sanitizeMessages(dirty);
  assert.deepEqual(sanitizeMessages(once), once, '第二遍必须什么都不做 —— 收口点每轮都调，不幂等就会滚雪球');
  assertRequestSafe(once);
});

test('不改入参：调用方持有的历史不能被收口点改掉', () => {
  const dirty = [u('q'), a(null, [call('c1', 'x')])];
  const snapshot = JSON.stringify(dirty);
  sanitizeMessages(dirty);
  assert.equal(JSON.stringify(dirty), snapshot, 'agent 循环把 out 反复传进来，就地改会连带改掉它的 token 预算');
});

// ─────────────────────────────────────────────────────────────────────────
// 7. 回归形状：agent.ts 三条真实路径攒出来的 out
// ─────────────────────────────────────────────────────────────────────────

test('回归 · empty 闸：只吐思考、正文空、也没调工具 → 收尾请求不再 400', () => {
  // agent.ts：out.push(msg) 之后判 empty 并 break，收尾轮把 out 原样再发一次
  const out = [sys('系统提示'), u('问题'), a(null)];
  // 修复前：网关在这份历史上就会拒（这正是 messageDefects 要抓的东西）
  assert.equal(messageDefects(out).length, 1, '先钉住「这份历史原本是非法的」');
  const wire = sanitizeMessages(out);
  assert.deepEqual(wire.map((m) => m.role), ['system', 'user']);
  assert.equal(wire.every((m) => m.content !== '' && m.content !== undefined), true, '不能靠空串过网关');
  assertRequestSafe(wire);
});

test('回归 · loop 闸：在执行之前 break，那批 tool_calls 无人应答', () => {
  // agent.ts：ledger.record 命中 → break，此时第一个调用已执行、第二个没执行
  const out = [
    sys('系统提示'),
    u('问题'),
    a('我查一下', [call('c1', 'search_material'), call('c2', 'search_material')]),
    t('c1', '贝叶斯……', 'search_material'),
  ];
  assert.equal(messageDefects(out).length, 1);
  const wire = sanitizeMessages(out);
  assertRequestSafe(wire);
  const tools = wire.filter((m) => m.role === 'tool');
  assert.deepEqual(tools.map((m) => m.tool_call_id), ['c1', 'c2'], 'c2 必须被补上，不能让 assistant(tool_calls) 裸奔');
  assert.equal(tools[1].content, syntheticToolResult('search_material'));
});

test('回归 · 收尾轮：宽限轮的 tool_calls 不入历史，但已发出的那次请求要能过网关', () => {
  // agent.ts：宽限轮不 push finalMsg，但 attempt 0 的请求已经带着 out 的旧内容发出去了
  const out = [sys('系统提示'), u('问题'), a(null, [call('c1', 'propose_folder_plan')])];
  const wire = sanitizeMessages(out);
  assertRequestSafe(wire);
  assert.deepEqual(wire.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.match(wire[3].content, /没有执行/);
});

test('回归 · 题卡 / 提问卡：正文为空但挂着卡片的助手消息（落库允许，发请求会被清掉）', () => {
  // ChatPanel：`if (finalAnswer || quizState)` 成立但正文空时落一条 content: '' 的助手消息。
  // 刻意不在落库处补占位文案（正文空 UI 才只渲染卡片），靠收口点在请求边界清掉。
  const history = [u('出题'), { role: 'assistant', content: '' }, u('我选 A')];
  assert.equal(messageDefects(history).length, 1);
  const wire = sanitizeMessages(history);
  assert.deepEqual(wire.map((m) => m.role), ['user', 'user']);
  assertRequestSafe(wire);
});

test('回归 · 整段会话：干净历史过一遍逐字不变（有内容的回答不受影响）', () => {
  const history = [sys('系统提示'), u('第一问'), a('第一答'), u('第二问'), a('第二答')];
  assert.deepEqual(sanitizeMessages(history), history, '不能给每条消息都镀一层多余字段');
});

// ─────────────────────────────────────────────────────────────────────────
// 8. 400 诊断：让「报错和现象无关」这件事不再成立
// ─────────────────────────────────────────────────────────────────────────

test('describeMessage 把每条消息的形状说清楚（排障全靠它）', () => {
  assert.equal(describeMessage(a(null, [call('c1', 'search_material'), call('c2', 'read')]), 3), '#3 assistant · 正文 0 字 · 工具调用 2 个（search_material、read）');
  assert.equal(describeMessage(a('结论在这里'), 0), '#0 assistant · 正文 5 字 · 工具调用 0 个');
  assert.equal(describeMessage(u('问题'), 1), '#1 user · 2 字');
  assert.equal(describeMessage(t('c1', '结果', 'search_material'), 2), '#2 tool · 应答 search_material');
});

test('describeMessage 数的是 trim 后的字数（空白正文要显示成 0 字）', () => {
  assert.match(describeMessage(a('   \n '), 0), /正文 0 字/);
  assert.match(describeMessage(a([{ type: 'text', text: '  ' }]), 0), /正文 0 字/);
});

test('网关抱怨消息结构时，诊断要把历史形状与本地复查一起给出', () => {
  // 这正是本次那个 400 的原文
  const msg = diagnose400('Invalid assistant message: content or tool_calls must be set (request_id: abc)', [
    sys('系统提示'),
    a(null),
    u('追问'),
  ]);
  assert.ok(msg, '命中消息校验类报错时必须给诊断');
  assert.match(msg, /消息结构不合法/);
  assert.match(msg, /request_id: abc/, '原始报错要保留（含 request_id，方便找服务商）');
  assert.match(msg, /#1 assistant · 正文 0 字/, '要指出是哪一条、什么形状');
  assert.match(msg, /本地复查也发现 1 处可疑/, '本地复查结论也要给出来');
  assert.match(msg, /既没有正文也没有 tool_calls/);
});

test('网关抱怨的是另一种消息结构问题时也能诊断', () => {
  const msg = diagnose400("An assistant message with 'tool_calls' must be followed by tool messages", [
    a(null, [call('c1', 'search_material')]),
  ]);
  assert.ok(msg);
  assert.match(msg, /#0 assistant · 正文 0 字 · 工具调用 1 个/);
});

test('与消息结构无关的报错不给诊断（不能硬凑，那会把人带偏）', () => {
  for (const other of [
    'HTTP 429 rate limit exceeded',
    'Invalid API key provided',
    '模型已达到最大上下文长度',
    'The model produced invalid reasoning tokens',
  ]) {
    assert.equal(diagnose400(other, [sys('s'), u('q'), a(null)]), null, `不该诊断：${other}`);
  }
});

test('诊断里说「本地没发现问题」时要给下一步猜测方向', () => {
  // 收口点已经洗干净、网关仍拒绝 —— 那是我们对某种形态的理解比网关宽松
  const msg = diagnose400('Invalid assistant message: content or tool_calls must be set', [sys('s'), u('q'), a('有正文')]);
  assert.match(msg, /本地复查没有发现不合法的消息/);
  assert.match(msg, /网关对某种形态比我们更严格/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
