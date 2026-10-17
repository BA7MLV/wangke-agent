import assert from 'node:assert/strict';
import { parseModelMeta, refreshModelMeta, getModelMeta, isModelMetaStale } from '../src/api/modelMeta.ts';
import { modelKind, capabilityLabel } from '../src/api/modelPresentation.ts';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const entry = (input, output = ['text']) => ({ modalities: { input, output } });
assert.equal(modelKind(parseModelMeta(entry(['text']))), 'llm');
assert.equal(modelKind(parseModelMeta(entry(['text', 'image']))), 'vlm');
assert.equal(modelKind(parseModelMeta(entry(['video']))), 'vlm');
assert.equal(modelKind(parseModelMeta(entry(['text', 'image'], ['image']))), 'image');
assert.equal(modelKind(parseModelMeta(entry(['text'], ['video']))), 'video');
assert.equal(modelKind(parseModelMeta(entry(['audio']))), 'audio');
assert.equal(modelKind(parseModelMeta({ name: 'gpt-vision-vl-llm' })), 'unknown');
assert.equal(modelKind(null), 'unknown');
assert.equal(capabilityLabel(parseModelMeta({}).declaredToolCall), '未提供');
assert.equal(capabilityLabel(parseModelMeta({ tool_call: false }).declaredToolCall), '不支持');
const zero = parseModelMeta({ limit: { context: 0, output: 0 }, cost: { input: 0, output: 0 } });
assert.equal(zero.declaredContext, 0);
assert.equal(zero.cost.input, 0);
assert.equal(parseModelMeta({}).declaredContext, undefined);
assert.equal(parseModelMeta({ limit: { context: -1, output: NaN } }).declaredContext, undefined);

globalThis.fetch = async () => new Response(JSON.stringify({
  first: { models: { same: entry(['text']), noContext: entry(['audio']), free: { ...entry(['text']), cost: { input: 0 } } } },
  second: { models: { same: entry(['text', 'image']) } },
}));
await refreshModelMeta(['first']);
assert.equal(modelKind(getModelMeta('first', 'noContext')), 'audio', 'models without context remain discoverable');
assert.equal(isModelMetaStale(['first']), false);
assert.equal(isModelMetaStale(['second']), true, 'new catalog must refresh even when other catalog is fresh');
await refreshModelMeta(['second']);
assert.equal(modelKind(getModelMeta('first', 'same')), 'llm', 'refresh another catalog retains the first');
assert.equal(modelKind(getModelMeta('second', 'same')), 'vlm', 'same ID is scoped to provider');
assert.equal(getModelMeta('', 'same'), null);
assert.equal(getModelMeta('other', 'same'), null);
globalThis.fetch = async () => new Response('', { status: 503 });
await assert.rejects(refreshModelMeta(['first']), /503/);
assert.equal(modelKind(getModelMeta('first', 'same')), 'llm', 'failure preserves cache');
console.log('PASS: metadata classification, unknown/false/zero, missing context, provider isolation, cache refresh and failure retention');
