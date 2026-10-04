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

const SF = 'siliconflow-cn';

/** 把某份 models.dev 形状的数据当作拉取结果（挂在硅基流动国内站名下） */
const serveMeta = (models, catalog = SF) => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ [catalog]: { models: withLimits(models) } }), {
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
await main.refreshModelMeta([SF]);
const { hasThinkingDepth, thinkingControlOf, thinkingParams } = main;
// 每个查询都要带供应商：同一个模型 id 在不同供应商下能力可以不同，
// 所以下面的调用一律写成 thinkingParams(供应商, 模型, 档位)
const p = (model, effort) => thinkingParams(SF, model, effort);
const depth = (model) => hasThinkingDepth(SF, model);
const control = (model) => thinkingControlOf(SF, model);

await test('effort 型：只发 reasoning_effort，取模型声明的档位名', () => {
  assert.deepEqual(p('zai-org/GLM-5.3', 'high'), { enable_thinking: true, reasoning_effort: 'high' });
  assert.equal(p('zai-org/GLM-5.3', 'max').reasoning_effort, 'max');
  assert.equal('thinking_budget' in p('zai-org/GLM-5.3', 'low'), false);
});

await test('声明里没有我们这一档时，向下取不超出的最强档', () => {
  // GLM-5.2 只声明 high/max：选 low 只能退到 high（它最弱的就是 high）
  assert.equal(p('zai-org/GLM-5.2', 'low').reasoning_effort, 'high');
  assert.equal(p('zai-org/GLM-5.2', 'high').reasoning_effort, 'high');
  assert.equal(p('zai-org/GLM-5.2', 'max').reasoning_effort, 'max');
});

await test('budget 型：按声明区间的上限比例算，不越界', () => {
  const low = p('deepseek-ai/DeepSeek-V4-Flash-0731', 'low');
  assert.deepEqual(low, { enable_thinking: true, thinking_budget: 8192 });
  assert.equal(p('deepseek-ai/DeepSeek-V4-Flash-0731', 'high').thinking_budget, 16384);
  assert.equal(p('deepseek-ai/DeepSeek-V4-Flash-0731', 'max').thinking_budget, 32768);
  assert.equal('reasoning_effort' in low, false);
});

await test('厂商文档点名的模型走 reasoning_effort，盖过 models.dev 的 budget 记录', () => {
  // DeepSeek-V4-Flash 在 models.dev 上被记成 budget，但硅基流动 API 参考
  // 明确 reasoning_effort 适用于它 —— 文档优先，否则旋钮会静默失效
  assert.deepEqual(p('deepseek-ai/DeepSeek-V4-Flash', 'high'), {
    enable_thinking: true,
    reasoning_effort: 'high',
  });
  // 该字段的 enum 只有 high/max：选 low 映射成 high（文档原文：low 会映射为 high）
  assert.equal(p('deepseek-ai/DeepSeek-V4-Flash', 'low').reasoning_effort, 'high');
  assert.equal(p('deepseek-ai/DeepSeek-V4-Flash', 'max').reasoning_effort, 'max');
  // 没被文档点名的近亲（V4-Flash-0731）仍走元数据声明的 budget
  assert.ok('thinking_budget' in p('deepseek-ai/DeepSeek-V4-Flash-0731', 'high'));
});

await test('厂商文档只对点名的那家生效：换个供应商就不认这个字段', async () => {
  // 同一份模型 id 接到别家时，别家未必认 reasoning_effort —— 拿硅基流动的文档去覆盖它是错的。
  // 所以 DOC_EFFORT_MODELS 是按 catalogId 分组的，跨供应商查询拿不到这三条。
  const OTHER = 'some-other-gateway';
  serveMeta(
    { 'deepseek-ai/DeepSeek-V4-Flash': { reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 128, max: 32768 }] } },
    OTHER,
  );
  const other = await load('other');
  await other.refreshModelMeta([OTHER]);
  // 元数据说它是 budget 型，就按 budget 发，不套用硅基流动文档的 effort
  assert.ok('thinking_budget' in other.thinkingParams(OTHER, 'deepseek-ai/DeepSeek-V4-Flash', 'high'));
  assert.equal('reasoning_effort' in other.thinkingParams(OTHER, 'deepseek-ai/DeepSeek-V4-Flash', 'high'), false);
  // 同一份缓存里，本供应商下仍应走文档点名的 effort（文档覆盖只在对应 catalogId 生效）
  assert.equal(
    other.thinkingControlOf(SF, 'deepseek-ai/DeepSeek-V4-Flash')?.effort?.join(','),
    'high,max',
  );
});

await test('只有开关的模型：只发 enable_thinking，UI 也不给深度旋钮', () => {
  assert.deepEqual(p('Qwen/Qwen3.5-27B', 'max'), { enable_thinking: true });
  assert.equal(depth('Qwen/Qwen3.5-27B'), false);
  assert.equal(depth('deepseek-ai/DeepSeek-V3.2'), false);
});

await test('声明为空的思考模型：不替它编深度参数', () => {
  assert.deepEqual(p('deepseek-ai/DeepSeek-V4-Pro', 'high'), { enable_thinking: true });
  assert.equal(depth('deepseek-ai/DeepSeek-V4-Pro'), false);
  assert.deepEqual(control('deepseek-ai/DeepSeek-V4-Pro'), { toggle: true });
});

await test('不会思考的模型：没有思考控制信息', () => {
  assert.equal(control('Qwen/Qwen3.6-35B-A3B'), null);
  assert.equal(depth('Qwen/Qwen3.6-35B-A3B'), false);
});

await test('元数据没收录的模型：一律不发深度参数（宁可没有，不瞎猜）', () => {
  assert.deepEqual(p('some/unknown-model', 'max'), { enable_thinking: true });
  assert.equal(depth('some/unknown-model'), false);
});

await test('没填能力数据源的供应商：查不到就是查不到，不按模型名兜底', () => {
  // catalogId 为空时不能退化成「按模型名全局查」—— 那正是把两站拍平成一张表的老 bug：
  // 同名模型在别家的能力会被当成本家的。
  assert.equal(thinkingControlOf('', 'zai-org/GLM-5.2'), null);
  assert.equal(hasThinkingDepth('', 'zai-org/GLM-5.2'), false);
  assert.deepEqual(thinkingParams('', 'zai-org/GLM-5.2', 'high'), { enable_thinking: true });
});

await test('有深度能力的模型才显示深度控件', () => {
  assert.equal(depth('zai-org/GLM-5.2'), true);
  assert.equal(depth('deepseek-ai/DeepSeek-V4-Flash'), true);
  assert.equal(depth('Qwen/Qwen3-14B'), true);
});

await test('预算不得掉到声明的 min 以下', async () => {
  serveMeta({ 'x/tiny-thinking': { reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 4096, max: 4096 }] } });
  const tiny = await load('tiny');
  await tiny.refreshModelMeta([SF]);
  assert.deepEqual(tiny.thinkingParams(SF, 'x/tiny-thinking', 'low'), { enable_thinking: true, thinking_budget: 4096 });
});

await test('同一个模型 id 在两家能力不同时，按供应商各取各的', () => {
  // 这是 v2 拍平表的老 bug：把 siliconflow 与 siliconflow-cn 合成一张 id → 能力表，
  // 两者有 31 个同名 id、其中 7 个能力冲突（如 Qwen3.6-35B-A3B 国际站只支持文本、
  // 国内站支持图像+视频），取到的是合并顺序里赢的那个。
  const models = {
    'x/shared': {
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['high', 'max'] }],
      modalities: { input: ['text'] },
    },
  };
  const otherModels = {
    'x/shared': {
      reasoning: true,
      reasoning_options: [{ type: 'budget_tokens', min: 128, max: 4096 }],
      modalities: { input: ['text', 'image'] },
    },
  };
  const j = {
    'siliconflow-cn': { models: withLimits(models) },
    'siliconflow': { models: withLimits(otherModels) },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return (async () => {
    const both = await load('both');
    await both.refreshModelMeta(['siliconflow-cn', 'siliconflow']);
    // 国内站：effort 型
    assert.equal(both.thinkingParams('siliconflow-cn', 'x/shared', 'high').reasoning_effort, 'high');
    // 国际站：budget 型 —— 不能被国内站的声明盖掉
    assert.equal(
      both.thinkingParams('siliconflow', 'x/shared', 'high').thinking_budget,
      2048,
    );
    // 视觉能力也各查各的
    assert.equal(both.isVisionModel('siliconflow-cn', 'x/shared'), false);
    assert.equal(both.isVisionModel('siliconflow', 'x/shared'), true);
  })();
});

await test('只保留登记过的供应商，不把全库 226 家都塞进缓存', async () => {
  const many = Object.fromEntries(
    Array.from({ length: 50 }, (_, i) => [`x/m${i}`, { reasoning: false }]),
  );
  const j = {
    'siliconflow-cn': { models: withLimits(many) },
    'some-other': { models: withLimits(Object.fromEntries([['x/other', { reasoning: true }]])) },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const one = await load('one');
  const { count } = await one.refreshModelMeta(['siliconflow-cn']);
  assert.equal(count, 50, '未登记的那家不该进缓存');
  assert.equal(one.getModelMeta('some-other', 'x/other'), null);
  assert.ok(one.getModelMeta('siliconflow-cn', 'x/m7'));
});

await test('一家都没登记时不必发请求', async () => {
  globalThis.fetch = async () => {
    throw new Error('不该发请求');
  };
  const none = await load('none');
  assert.deepEqual(await none.refreshModelMeta([]), { count: 0 });
});

await test('旧版本缓存被整体作废，而不是当成「不支持深度」', async () => {
  // 键的形状变了（裸模型 id → `catalogId\0modelId`），旧缓存必须当没有
  globalThis.localStorage.getItem = (k) =>
    k === 'wangke-model-meta'
      ? JSON.stringify({
          version: 1,
          updatedAt: Date.now(),
          models: { 'zai-org/GLM-5.2': { context: 1, output: 1, vision: false, reasoning: true, toolCall: true, thinking: { toggle: true, effort: ['high'] } } },
        })
      : null;
  const stale = await load('stale');
  assert.equal(stale.hasThinkingDepth(SF, 'zai-org/GLM-5.2'), false);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);