import assert from 'node:assert/strict';
import { modelProviderMeta, parseModelMeta, refreshModelMeta, getModelMeta, isModelMetaStale, matchModelMeta } from '../src/api/modelMeta.ts';
import { parseDiscoveredModel } from '../src/api/modelDiscoveryData.ts';
import { readModelList, writeModelList, __resetModelListCacheForTest } from '../src/api/modelListCache.ts';
import { modelKind, capabilityLabel } from '../src/api/modelPresentation.ts';
import { getProviderPresets } from '../src/store/providerPresets.ts';

const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
const entry = (input, output = ['text']) => ({ modalities: { input, output } });
assert.equal(modelKind(parseModelMeta(entry(['text']))), 'llm');
assert.equal(modelKind(parseModelMeta(entry(['text', 'image']))), 'vlm');
assert.equal(modelKind(parseModelMeta(entry(['video']))), 'vlm');
assert.equal(modelKind(parseModelMeta(entry(['text', 'image'], ['image']))), 'image');
assert.equal(modelKind(parseModelMeta(entry(['text'], ['video']))), 'video');
assert.equal(modelKind(parseModelMeta(entry(['audio']))), 'audio');
assert.equal(modelKind(parseModelMeta({ name: 'gpt-vision-vl-llm' })), 'llm', 'unknown defaults to text without guessing vision from names');
assert.equal(modelKind(null), 'unknown');
assert.equal(capabilityLabel(parseModelMeta({}).declaredToolCall), '未提供');
assert.equal(capabilityLabel(parseModelMeta({ tool_call: false }).declaredToolCall), '不支持');
const zero = parseModelMeta({ limit: { context: 0, output: 0 } });
assert.equal(zero.declaredContext, 0);
assert.equal('cost' in zero, false, 'catalog is capabilities only');
assert.equal(parseModelMeta({}).toolCall, true, 'unknown model enables tools by default');
assert.equal(parseModelMeta({ tool_call: false }).toolCall, false, 'explicit false wins');
assert.equal(parseModelMeta({}).declaredContext, undefined);
assert.equal(parseModelMeta({ limit: { context: -1, output: NaN } }).declaredContext, undefined);

globalThis.fetch = async () => new Response(JSON.stringify({
  first: { name: 'First provider', api: 'https://first.example/v1', npm: '@ai-sdk/openai-compatible', models: { same: entry(['text']), noContext: entry(['audio']), free: { ...entry(['text']), cost: { input: 0 } } } },
  second: { models: { same: entry(['text', 'image']) } },
}));
await refreshModelMeta();
assert.deepEqual(modelProviderMeta('first'), {
  id: 'first', name: 'First provider', baseUrl: 'https://first.example/v1', npm: '@ai-sdk/openai-compatible', env: undefined, doc: undefined,
}, 'provider metadata comes from models.dev');
assert.equal(getProviderPresets().find((preset) => preset.id === 'first')?.baseUrl, 'https://first.example/v1', 'provider presets use the live models.dev provider catalog');
assert.equal(modelKind(getModelMeta('first', 'noContext')), 'audio', 'models without context remain discoverable');
assert.equal(isModelMetaStale(['first']), false);
assert.equal(isModelMetaStale(['second']), false, 'the full capability catalog is fetched without provider registration');
await refreshModelMeta(['second']);
assert.equal(modelKind(getModelMeta('first', 'same')), 'llm', 'refresh another catalog retains the first');
assert.equal(modelKind(getModelMeta('second', 'same')), 'vlm', 'same ID is scoped to provider');
assert.equal(matchModelMeta('', 'same').status, 'ambiguous');
assert.equal(getModelMeta('', 'same').vision, false, 'ambiguous matches do not auto-apply');
assert.equal(getModelMeta('other', 'same').declaredToolCall, undefined);
assert.equal(getModelMeta('', 'noContext').inputModalities[0], 'audio', 'globally unique exact IDs need no catalog key');
assert.equal(getModelMeta('custom-gateway', 'noContext').inputModalities[0], 'audio');
assert.equal(getModelMeta('', 'same', { metadataCatalogId: 'second' }).vision, true, 'user can confirm a per-model metadata source');
assert.equal(getModelMeta('', 'same-production').declaredContext, undefined, 'no fuzzy automatic matches');
assert.deepEqual(getModelMeta('', 'unknown').inputModalities, ['text']);
assert.equal(getModelMeta('', 'unknown').toolCall, true);
assert.equal(getModelMeta('', 'unknown', { toolCalling: false }).toolCall, false);
assert.deepEqual(getModelMeta('', 'unknown', { inputCapabilities: [] }).inputModalities, []);
assert.equal(JSON.parse(storage.get('wangke-model-meta')).models['first\0free'].cost, undefined, 'pricing is not cached');

const discovered = parseDiscoveredModel({ id: 'same', context_window: 64000, max_output_tokens: 4096,
  capabilities: { input: ['text', 'image'], output: ['text'], tools: false } });
assert.equal(discovered.contextWindow, 64000);
assert.equal(discovered.toolCalling, false);
const enriched = getModelMeta('first', discovered.id, discovered);
assert.equal(enriched.vision, true, 'provider declarations win over catalog');
assert.equal(enriched.context, 64000);
assert.equal(enriched.toolCall, false);
assert.equal(parseDiscoveredModel(' local-model ').id, 'local-model');
assert.equal(parseDiscoveredModel({ id: 'local', limit: { context: -1 }, capabilities: { tools: 'yes' } }).toolCalling, undefined);
assert.equal(parseDiscoveredModel({ id: 'local', context_window: NaN }).contextWindow, undefined);
assert.equal(parseDiscoveredModel({ id: '' }), null);
writeModelList('test-fingerprint', [discovered.id], [discovered]);
__resetModelListCacheForTest();
assert.deepEqual(readModelList('test-fingerprint').models[0], discovered, 'provider capability snapshot survives cache reload');
globalThis.fetch = async () => new Response('', { status: 503 });
await assert.rejects(refreshModelMeta(['first']), /503/);
assert.equal(modelKind(getModelMeta('first', 'same')), 'llm', 'failure preserves cache');
console.log('PASS: optional metadata, unique/ambiguous matching, source confirmation, default tools, provider declarations, capability cache, explicit false/empty, pricing exclusion and failure retention');
