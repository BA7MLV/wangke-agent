#!/usr/bin/env node
/**
 * DeepSeek DSML 泄漏的客户端兜底还原。
 *
 * ## 为什么这值得单测
 *
 * 现象是「界面冒出裸标记 + 工具从没执行」。后者才是真 bug：
 * `tool_calls` 只从 `delta.tool_calls` 拼，DSML 落在 `content` 里，于是
 * `agent.ts` 那条「有正文 = 答完了」的分支成立，循环直接收工。
 * 而这一切在纯逻辑里看不出来 —— 必须真的把一串 DSML 喂进去看它变不变。
 *
 * ## 三组断言
 *
 * 1. **跨 chunk 切断**：`<｜｜DSML｜｜` 这种标记本身会被 SSE 切在两个 delta 里
 *    （实测尤甚）。逐字符喂一遍，标记不重组就等于没修。
 * 2. **` calls` 漏网**：OpenClaw 的白名单只有 tool_calls / tool_call / function_calls，
 *    模型吐 ` calls` 时它还原不了，那个 P1 至今还挂着（openclaw#159665）。
 *    这里按「`<MARKER invoke` 直接触发」实现，与 wrapper 名单无关。
 * 3. **不能比不装更差**：还原把内容吃干净又还原不出东西时必须原样透传 ——
 *    否则会造出「正文空 + 无 tool_calls」，那是 `messageHygiene` 要拦的非法消息，
 *    下一轮直接 400。
 *
 * 另外守住一条边界：**没声明 tools 时不装还原器**，正文里的 HTML 不能被吞。
 *
 * 运行：node scripts/test-dsml.mjs
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
const OUT = mkdtempSync(join(tmpdir(), 'dsml-'));

// 还原器本身可以直接 import（Node 去类型）；chatStream 要连 store 一起打包
const { createDsmlRecoverer, recoverDsmlText } = await import('../src/api/dsml.ts');

const entry = join(OUT, 'entry.ts');
writeFileSync(entry, `export { chatStream } from '${join(ROOT, 'src/api/siliconflow.ts')}';`);
await build({
  entryPoints: [entry],
  outfile: join(OUT, 'bundle.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"test"' },
});
const { chatStream } = await import(pathToFileURL(join(OUT, 'bundle.mjs')).href);

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 拼接还原器的输出：正文与调用分开，用例里分别断言 */
function recover(chunks) {
  const r = createDsmlRecoverer();
  const parts = [...chunks.flatMap((c) => r.push(c)), ...r.flush()];
  return {
    text: parts.filter((p) => p.kind === 'text').map((p) => p.text).join(''),
    calls: parts.filter((p) => p.kind === 'toolCall'),
  };
}

await test('裸 tool_call：逐字符分片仍能读取材料，正文不泄漏标签', () => {
  const xml = '<tool_call>read<param_key>path</param_key><param_value>/courses/7a520ace-2840-4b78-b3ae-77c9331eab89/material</param_value><param_key>range</param_key><param_value>unit=paragraphs,start=20,end=28</param_value></tool_call>';
  for (const chunks of [[xml], [...xml]]) {
    const result = recover(['先读取材料。', ...chunks, '读取完成。']);
    assert.equal(result.text, '先读取材料。读取完成。');
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].name, 'read');
    assert.deepEqual(JSON.parse(result.calls[0].arguments), {
      path: '/courses/7a520ace-2840-4b78-b3ae-77c9331eab89/material',
      // 摊平的 range 还原成 schema 要的对象，否则工具会先报一次参数错、白跑一轮
      range: { unit: 'paragraphs', start: 20, end: 28 },
    });
  }
});

await test('扁平 range 只在是 key=value 列表时转对象', () => {
  const r = recover(['<tool_call>read<param_key>path</param_key><param_value>/a,b</param_value><param_key>range</param_key><param_value>all</param_value></tool_call>']);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(JSON.parse(r.calls[0].arguments), { path: '/a,b', range: 'all' });
});

await test('残缺或无效裸 tool_call 不执行，普通 HTML 原样保留', () => {
  for (const text of [
    '<tool_call>read<param_key>path</param_key><param_value>/courses/a',
    '<tool_call>read<param_key>path</param_key></tool_call>',
    '示例 <div>hello</div> 和 a < b',
  ]) {
    const result = recover([...text]);
    assert.equal(result.text, text);
    assert.equal(result.calls.length, 0);
  }
});

/** 真实观测到的那次泄漏（全角双横线 + 带空格方言 + ` calls`） */
const OBSERVED =
  '查清了喵——先把证据和修正一起做完。\n\n' +
  '<｜｜DSML｜｜ calls>\n' +
  '<｜｜DSML｜｜ invoke name="read_skill_reference">\n' +
  '<｜｜DSML｜｜ parameter name="name" string="true">公文写作</｜｜DSML｜｜ parameter>\n' +
  '<｜｜DSML｜｜ parameter name="path" string="true">references/diagram.md</｜｜DSML｜｜ parameter>\n' +
  '</｜｜DSML｜｜ invoke>\n' +
  '</｜｜DSML｜｜ calls>';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_skill_reference',
      description: '读取技能附带的参考文档',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, path: { type: 'string' } },
        required: ['name', 'path'],
      },
    },
  },
];

/** 假网关：吐出编排好的 SSE 轮次 */
function serve(chunks) {
  globalThis.fetch = async () => {
    const sse =
      chunks
        .map((c) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: c } }] })}\n\n`)
        .join('') +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
      'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
}

/** 跑一次真实的 chatStream，返回「显示过的正文」与「拿到的消息」 */
async function stream(chunks, opts = {}) {
  serve(chunks);
  const shown = [];
  const msg = await chatStream(
    { baseUrl: 'https://fake.test/v1', apiKey: 'k', model: 'deepseek-ai/DeepSeek-V4-Flash' },
    { messages: [{ role: 'user', content: '公文版式怎么规定的？' }], tools: TOOLS, ...opts },
    (t) => shown.push(t),
  );
  return { shown: shown.join(''), msg };
}

// ── 1. 纯逻辑 ───────────────────────────────────────────────────────────────

await test('整块喂进去：标记消失、调用还原、正文保留', () => {
  const { text, calls } = recover([OBSERVED]);
  assert.equal(text, '查清了喵——先把证据和修正一起做完。\n\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_skill_reference');
  assert.deepEqual(JSON.parse(calls[0].arguments), {
    name: '公文写作',
    path: 'references/diagram.md',
  });
});

await test('逐字符喂：标记被 SSE 切碎也能重组（跨 chunk 断口）', () => {
  const { text, calls } = recover([...OBSERVED]);
  assert.equal(text, '查清了喵——先把证据和修正一起做完。\n\n');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), { name: '公文写作', path: 'references/diagram.md' });
});

await test('在标记正中间切断：`<｜｜` 与 `DSML｜｜` 分属两个 chunk', () => {
  const at = OBSERVED.indexOf('｜｜DSML｜｜ calls>') + 3;
  const { text, calls } = recover([OBSERVED.slice(0, at), OBSERVED.slice(at)]);
  assert.equal(calls.length, 1, '标记断成两半就还原不了 = 没修');
  assert.equal(text.includes('DSML'), false, `标记漏进正文：${JSON.stringify(text)}`);
});

await test('` calls` 这种名单外的 wrapper 也能还原（OpenClaw 至今没修的那条）', () => {
  for (const kind of ['calls', 'tool_calls', 'tool_call', 'function_calls', 'toolcalls', 'tool']) {
    const block = `<｜DSML｜${kind}><｜DSML｜invoke name="f"><｜DSML｜parameter name="a" string="true">v</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜${kind}>`;
    const { calls } = recover([block]);
    assert.equal(calls.length, 1, `wrapper kind=${kind} 没还原`);
    assert.equal(calls[0].name, 'f');
  }
});

await test('外层 START token 缺失也照样还原（vLLM #48931）', () => {
  const orphan = '<｜DSML｜invoke name="f"><｜DSML｜parameter name="a" string="false">5</｜DSML｜parameter></｜DSML｜invoke>';
  const { text, calls } = recover([orphan]);
  assert.equal(text, '');
  assert.equal(calls.length, 1);
  // string="false" 是 JSON 编码，数字不能变成字符串 "5"
  assert.deepEqual(JSON.parse(calls[0].arguments), { a: 5 });
});

await test('并行调用：两个 invoke 都还原', () => {
  const two =
    '<｜DSML｜tool_calls>' +
    '<｜DSML｜invoke name="a"><｜DSML｜parameter name="x" string="true">1</｜DSML｜parameter></｜DSML｜invoke>' +
    '<｜DSML｜invoke name="b"><｜DSML｜parameter name="y" string="true">2</｜DSML｜parameter></｜DSML｜invoke>' +
    '</｜DSML｜tool_calls>';
  const { calls } = recover([two]);
  assert.deepEqual(calls.map((c) => c.name), ['a', 'b']);
});

await test('正文里的普通 HTML 尖括号不被吞', () => {
  const html = '看这段：<div class="x"><span>你好</span></div>';
  assert.equal(recover([html]).text, html);
  assert.equal(recover([html]).calls.length, 0);
});

await test('半角 / 双半角 marker 也认（不止全角）', () => {
  for (const bar of ['|', '||', '｜', '｜｜']) {
    const m = `${bar}DSML${bar}`;
    const { text, calls } = recover([`<${m}tool_calls><${m}invoke name="f"></${m}invoke></${m}tool_calls>`]);
    assert.equal(calls.length, 1, `marker=${m} 没还原`);
    assert.equal(text, '');
  }
});

await test('残缺块（流断了）按已有参数收尾，而不是丢掉整次调用', () => {
  // 模型输出撞 max_tokens：invoke 开了、参数写了一半。丢掉的话 agent 会以为
  // 「模型什么都没说」，走 empty 那条兜底；收成一次调用，agent.ts 的
  // truncatedByTokenLimit 闸才能给出「参数被截断、请重发」这种能对症的提示。
  const cut = '<｜DSML｜invoke name="read_skill_reference"><｜DSML｜parameter name="name" string="true">公文';
  const { calls } = recover([cut]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_skill_reference');
  assert.deepEqual(JSON.parse(calls[0].arguments), { name: '公文' });
});

await test('还原不出东西时原样透传（不能造出「正文空 + 无调用」）', () => {
  const junk = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ 调用>\n<｜｜DSML｜｜ calls>';
  assert.equal(recover([junk]).text, junk, '只有一个壳、还原不出调用时必须原样还给界面');
});

await test('标签属性里的实体与引号变体', () => {
  const block =
    '<｜DSML｜invoke name=\'f\'>' +
    '<｜DSML｜parameter name="path" string="true">a&amp;b&lt;c</｜DSML｜parameter>' +
    '</｜DSML｜invoke>';
  const { calls } = recover([block]);
  assert.deepEqual(JSON.parse(calls[0].arguments), { path: 'a&b<c' });
});

// ── 2. 接进 chatStream ──────────────────────────────────────────────────────

await test('chatStream：标记不进界面，tool_calls 有值', async () => {
  const { shown, msg } = await stream([OBSERVED]);
  assert.equal(shown.includes('DSML'), false, `标记漏进界面：${JSON.stringify(shown)}`);
  assert.equal(shown, '查清了喵——先把证据和修正一起做完。\n\n');
  assert.equal(msg.tool_calls?.length, 1);
  assert.equal(msg.tool_calls[0].function.name, 'read_skill_reference');
  // id 必须有：没有它 messageHygiene 会把这次调用判成「没人应答的孤儿」
  assert.ok(msg.tool_calls[0].id, '还原出的调用必须带 id');
  assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), {
    name: '公文写作',
    path: 'references/diagram.md',
  });
});

await test('chatStream：纯 DSML（无正文）时 content 为 null 而不是空串', async () => {
  const { msg } = await stream(['<｜DSML｜tool_calls><｜DSML｜invoke name="f"></｜DSML｜invoke></｜DSML｜tool_calls>']);
  assert.equal(msg.content, null, '空串会被网关当非法消息拒');
  assert.equal(msg.tool_calls?.length, 1);
});

await test('chatStream：网关给的调用与还原出的调用不撞号', async () => {
  // 网关跳过 index 0 只发 index 1 时，还原出的调用若按「已有数量」取号就会覆盖它
  globalThis.fetch = async () => {
    const sse =
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'real_1', type: 'function', function: { name: 'real', arguments: '{}' } }] } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '<｜DSML｜invoke name="leaked"></｜DSML｜invoke>' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
      'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const msg = await chatStream(
    { baseUrl: 'https://fake.test/v1', apiKey: 'k', model: 'deepseek-ai/DeepSeek-V4-Flash' },
    { messages: [{ role: 'user', content: 'x' }], tools: TOOLS },
  );
  assert.deepEqual(msg.tool_calls?.map((c) => c.function.name), ['real', 'leaked']);
  assert.deepEqual(msg.tool_calls?.map((c) => c.id), ['real_1', 'dsml_0']);
});

await test('chatStream：没声明 tools 时不装还原器（正文里的 HTML 不能被吞）', async () => {
  const html = '答案里带标记：<｜DSML｜invoke name="f"></｜DSML｜invoke> 与 <div>x</div>';
  const { shown, msg } = await stream([html], { tools: undefined });
  assert.equal(msg.tool_calls, undefined, '没给工具就不该有调用');
  assert.equal(msg.content, html);
});

// ── 收尾 ────────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
