#!/usr/bin/env node
/**
 * 思考参数必须**跟着模型声明走**（纯逻辑，不需要 API key）。
 *
 * 这条护栏守的是一个具体的失败模式：以前 `thinkingParams()` 靠
 * `/(deepseek-v4|glm-5\.2)/` 猜模型名 + 写死 2048/8192/32768，于是会给只认
 * `thinking_budget` 的模型发 `reasoning_effort`（旋钮静默失效），也会给只有开关的
 * 模型发一个它根本不存在的深度参数。现在请求参数的形状只由 models.dev 的
 * `reasoning_options` 决定，所以这里从**原始条目**灌进去，逐个模型钉住结果。
 *
 * 用法：node scripts/test-thinking-depth.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// modelCaps 内部是 `import ... from './modelMeta'`（无扩展名，Vite 的写法），
// Node 的类型擦除不认这种 specifier，所以先 esbuild 打成一个包再 import。
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '.cache');
const entry = join(dir, 'thinking-depth-entry.ts');
const outfile = join(dir, 'thinking-depth-bundle.mjs');
mkdirSync(dir, { recursive: true });
{
  const { build } = await import('esbuild');
  const { writeFileSync } = await import('node:fs');
  // 入口要同时暴露两侧：modelCaps（判断与参数）+ modelMeta（拉取与解析）
  writeFileSync(entry, `export * from '../../src/api/modelCaps.ts';\nexport * from '../../src/api/modelMeta.ts';\n`);
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
}
process.on('exit', () => rmSync(outfile, { force: true }));

/** 换 query 才能拿到一份全新的模块实例（modelMeta 的缓存是模块级变量） */
const load = (tag) => import(`${pathToFileURL(outfile).href}?v=${tag}`);

/**
 * 真实条目：2026-10 从 models.dev 拉下来的硅基流动在架声明，**照抄不改**。
 * 上游改了声明这里就会失败 —— 那正是该跟进的时候。
 */
const FIXTURE = {
  // effort 档位型：声明里给了合法档位
  'zai-org/GLM-5.2': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['high', 'max'] }] },
  'zai-org/GLM-5.3': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
  // 预算型：给了区间（V4-Flash 另有文档钦定的 effort 覆盖，见 modelCaps 的 DOC_EFFORT_MODELS）
  'deepseek-ai/DeepSeek-V4-Flash-0731': { reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 128, max: 32768 }] },
  'Qwen/Qwen3-14B': {
    reasoning: true,
    reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', min: 128, max: 32768 }],
  },
  // 只有开关：深度旋钮是假的
  'Qwen/Qwen3.5-27B': { reasoning: true, reasoning_options: [{ type: 'toggle' }] },
  'deepseek-ai/DeepSeek-V3.2': { reasoning: true, reasoning_options: [{ type: 'toggle' }] },
  // 会思考但一个旋钮都没声明（`[]` 是上游真实存在的形状）
  'deepseek-ai/DeepSeek-V4-Pro': { reasoning: true, reasoning_options: [] },
  // 不会思考
  'Qwen/Qwen3.6-35B-A3B': { reasoning: false },
};

/** models.dev 的条目必须有 context 才会进能力表，补一个免得在解析阶段被丢掉 */
const withLimits = (models) =>
  Object.fromEntries(Object.entries(models).map(([id, m]) => [id, { limit: { context: 128000, output: 8192 }, ...m }]));

/** 把某份 models.dev 形状的数据当作拉取结果 */
const serveMeta = (models) => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ siliconflow: { models: withLimits(models) } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
};

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };
serveMeta(FIXTURE);

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL - ${name}\n    ${error.message}`);
  }
}

// 走真实链路：拉元数据 → 解析 reasoning_options → 生成请求参数
const main = await load('main');
await main.refreshModelMeta();
const { hasThinkingDepth, thinkingControlOf, thinkingParams } = main;

await test('effort 型：只发 reasoning_effort，取模型声明的档位名', () => {
  assert.deepEqual(thinkingParams('zai-org/GLM-5.3', 'high'), { enable_thinking: true, reasoning_effort: 'high' });
  assert.equal(thinkingParams('zai-org/GLM-5.3', 'max').reasoning_effort, 'max');
  assert.equal('thinking_budget' in thinkingParams('zai-org/GLM-5.3', 'low'), false);
});

await test('声明里没有我们这一档时，向下取不超出的最强档', () => {
  // GLM-5.2 只声明 high/max：选 low 只能退到 high（它最弱的就是 high）
  assert.equal(thinkingParams('zai-org/GLM-5.2', 'low').reasoning_effort, 'high');
  assert.equal(thinkingParams('zai-org/GLM-5.2', 'high').reasoning_effort, 'high');
  assert.equal(thinkingParams('zai-org/GLM-5.2', 'max').reasoning_effort, 'max');
});

await test('budget 型：按声明区间的上限比例算，不越界', () => {
  const low = thinkingParams('deepseek-ai/DeepSeek-V4-Flash-0731', 'low');
  assert.deepEqual(low, { enable_thinking: true, thinking_budget: 8192 });
  assert.equal(thinkingParams('deepseek-ai/DeepSeek-V4-Flash-0731', 'high').thinking_budget, 16384);
  assert.equal(thinkingParams('deepseek-ai/DeepSeek-V4-Flash-0731', 'max').thinking_budget, 32768);
  assert.equal('reasoning_effort' in low, false);
});

await test('厂商文档点名的模型走 reasoning_effort，盖过 models.dev 的 budget 记录', () => {
  // DeepSeek-V4-Flash 在 models.dev 上被记成 budget，但硅基流动 API 参考
  // 明确 reasoning_effort 适用于它 —— 文档优先，否则旋钮会静默失效
  assert.deepEqual(thinkingParams('deepseek-ai/DeepSeek-V4-Flash', 'high'), {
    enable_thinking: true,
    reasoning_effort: 'high',
  });
  // 该字段的 enum 只有 high/max：选 low 映射成 high（文档原文：low 会映射为 high）
  assert.equal(thinkingParams('deepseek-ai/DeepSeek-V4-Flash', 'low').reasoning_effort, 'high');
  assert.equal(thinkingParams('deepseek-ai/DeepSeek-V4-Flash', 'max').reasoning_effort, 'max');
  // 没被文档点名的近亲（V4-Flash-0731）仍走元数据声明的 budget
  assert.ok('thinking_budget' in thinkingParams('deepseek-ai/DeepSeek-V4-Flash-0731', 'high'));
});

await test('只有开关的模型：只发 enable_thinking，UI 也不给深度旋钮', () => {
  assert.deepEqual(thinkingParams('Qwen/Qwen3.5-27B', 'max'), { enable_thinking: true });
  assert.equal(hasThinkingDepth('Qwen/Qwen3.5-27B'), false);
  assert.equal(hasThinkingDepth('deepseek-ai/DeepSeek-V3.2'), false);
});

await test('声明为空的思考模型：不替它编深度参数', () => {
  assert.deepEqual(thinkingParams('deepseek-ai/DeepSeek-V4-Pro', 'high'), { enable_thinking: true });
  assert.equal(hasThinkingDepth('deepseek-ai/DeepSeek-V4-Pro'), false);
  assert.deepEqual(thinkingControlOf('deepseek-ai/DeepSeek-V4-Pro'), { toggle: true });
});

await test('不会思考的模型：没有思考控制信息', () => {
  assert.equal(thinkingControlOf('Qwen/Qwen3.6-35B-A3B'), null);
  assert.equal(hasThinkingDepth('Qwen/Qwen3.6-35B-A3B'), false);
});

await test('元数据没收录的模型：一律不发深度参数（宁可没有，不瞎猜）', () => {
  assert.deepEqual(thinkingParams('some/unknown-model', 'max'), { enable_thinking: true });
  assert.equal(hasThinkingDepth('some/unknown-model'), false);
});

await test('有深度能力的模型才显示深度控件', () => {
  assert.equal(hasThinkingDepth('zai-org/GLM-5.2'), true);
  assert.equal(hasThinkingDepth('deepseek-ai/DeepSeek-V4-Flash'), true);
  assert.equal(hasThinkingDepth('Qwen/Qwen3-14B'), true);
});

await test('预算不得掉到声明的 min 以下', async () => {
  serveMeta({ 'x/tiny-thinking': { reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 4096, max: 4096 }] } });
  const tiny = await load('tiny');
  await tiny.refreshModelMeta();
  assert.deepEqual(tiny.thinkingParams('x/tiny-thinking', 'low'), { enable_thinking: true, thinking_budget: 4096 });
});

await test('旧版本缓存被整体作废，而不是当成「不支持深度」', async () => {
  globalThis.localStorage.getItem = (k) =>
    k === 'wangke-model-meta' ? JSON.stringify({ updatedAt: Date.now(), models: {} }) : null;
  const stale = await load('stale');
  assert.equal(stale.hasThinkingDepth('zai-org/GLM-5.2'), false);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);