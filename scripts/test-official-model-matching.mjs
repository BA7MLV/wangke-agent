import assert from 'node:assert/strict';
import { configureModelMetaStorage, getModelMeta, matchModelMeta, refreshModelMeta } from '../packages/study-core/src/api/modelMeta.ts';

configureModelMetaStorage({ getItem: () => null, setItem: () => {} });
const official = {
  modalities: { input: ['text', 'image'], output: ['text'] },
  limit: { context: 200000, output: 16000 }, tool_call: true, reasoning: true,
  reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
};
const reseller = { modalities: { input: ['text'], output: ['text'] }, limit: { context: 32000 }, tool_call: false };
const cases = [
  ['openai', 'gpt-4o', ['GPT-4o', 'openai/gpt-4o']],
  ['openai', 'o3', ['openai/o3']],
  ['anthropic', 'claude-sonnet-4-6', ['anthropic/claude-sonnet-4-6', 'claude-sonnet-4.6', 'anthropic/claude-sonnet-4.6']],
  ['google', 'gemini-2.5-pro', ['google/gemini-2.5-pro', 'models/gemini-2.5-pro']],
  ['deepseek', 'deepseek-v4-pro', ['deepseek-ai/DeepSeek-V4-Pro']],
  ['alibaba', 'qwen3-235b-a22b', ['Qwen/Qwen3-235B-A22B']],
  ['moonshotai', 'kimi-k2.6', ['moonshotai/Kimi-K2.6']],
  ['zhipuai', 'glm-4.7', ['z-ai/glm-4.7', 'THUDM/GLM-4.7']],
  ['minimax', 'MiniMax-M2.5', ['minimax/minimax-m2.5', 'MiniMaxAI/MiniMax-M2.5']],
  ['xai', 'grok-4', ['x-ai/grok-4']],
  ['mistral', 'mistral-large-latest', ['mistralai/mistral-large-latest']],
  ['cohere', 'command-r-plus', ['cohere/command-r-plus']],
  ['stepfun', 'step-3.5-flash', ['stepfun-ai/step-3.5-flash']],
];
const catalog = { reseller: { models: { shared: reseller, unique: reseller } }, another: { models: { shared: official } } };
for (const [provider, id] of cases) {
  catalog[provider] ??= { models: {} };
  catalog[provider].models[id] = official;
  catalog.reseller.models[id] = reseller;
  catalog.another.models[id] = reseller;
}
// Regional official catalogs must not leave the common model ambiguous.
catalog['alibaba-cn'] = { models: { 'qwen3-235b-a22b': reseller, 'qwen-cn-only': official } };
catalog['moonshotai-cn'] = { models: { 'kimi-k2.6': reseller } };
catalog.zai = { models: { 'glm-4.7': reseller } };
catalog['minimax-cn'] = { models: { 'MiniMax-M2.5': reseller } };

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => Response.json(catalog);
  await refreshModelMeta();
  for (const [provider, id, aliases] of cases) {
    for (const model of [id, ...aliases]) {
      const match = matchModelMeta('custom-gateway', model);
      assert.equal(match.status, 'exact', `${model} automatically resolves`);
      assert.equal(match.candidates[0].catalogId, provider, `${model} uses the official provider, not a reseller`);
      assert.equal(match.candidates[0].modelId, id);
      const meta = getModelMeta('', model);
      assert.equal(meta.vision, true);
      assert.equal(meta.declaredContext, 200000);
      assert.deepEqual(meta.thinking.effort, ['low', 'high']);
    }
  }
  assert.equal(matchModelMeta('reseller', 'gpt-4o').candidates[0].catalogId, 'reseller', 'an exact endpoint-specific entry still wins');
  assert.equal(matchModelMeta('', 'Qwen/qwen-cn-only').candidates[0].catalogId, 'alibaba-cn', 'regional official catalog is a fallback');
  assert.equal(matchModelMeta('', 'gpt-4o-custom').status, 'none', 'never guess capabilities for arbitrary suffixes');
  assert.equal(matchModelMeta('', 'unknown/gpt-4o').status, 'none', 'unknown namespaces are not stripped');
  assert.equal(matchModelMeta('', 'anthropic/gpt-4o').status, 'none', 'namespace must match the model family');
  assert.equal(matchModelMeta('', 'shared').status, 'ambiguous', 'unknown homonyms do not borrow arbitrary capabilities');
  assert.equal(matchModelMeta('', 'unique').status, 'exact', 'unique exact matches still work');
  assert.equal(getModelMeta('', 'unknown').toolCall, true);
  const overrides = { contextWindow: 64000, inputCapabilities: ['text'], toolCalling: false, reasoningEffort: '' };
  const before = structuredClone(overrides);
  const meta = getModelMeta('', 'openai/gpt-4o', overrides);
  assert.equal(meta.declaredContext, 64000);
  assert.equal(meta.vision, false);
  assert.equal(meta.toolCall, false);
  assert.equal(meta.reasoning, false);
  assert.deepEqual(overrides, before, 'matching never mutates saved/API configuration or request model IDs');
  assert.equal(getModelMeta('', 'gpt-4o', { metadataCatalogId: 'reseller' }).vision, false, 'legacy explicit source overrides remain respected');
  catalog.openai.models['gpt-4o'] = { ...official, limit: { context: 256000 } };
  await refreshModelMeta();
  assert.equal(getModelMeta('', 'openai/gpt-4o').declaredContext, 256000, 'refresh rebuilds official matching indexes');
  console.log('PASS: common official model families, prefixes, case/version aliases, regional fallbacks, endpoint/API/manual precedence and refreshed indexes');
} finally {
  globalThis.fetch = originalFetch;
}
