import assert from 'node:assert/strict';
import { getModelMeta, refreshModelMeta } from '../src/api/modelMeta.ts';
import { editModelPatch, modelsForSlot, suggestedModelSlots } from '../src/store/modelLibrary.ts';
import { createPresetProvider, PROVIDER_PRESETS, providerCatalogId } from '../src/store/providerPresets.ts';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { catalogOf, getSettings, providersForSlot, targetOfSlot, targetOrNull, visionTargetOrNull } = await import('../src/store/settings.ts');
const entry = (input, output = ['text']) => ({ modalities: { input, output } });
globalThis.fetch = async () => new Response(JSON.stringify({
  'siliconflow-cn': { models: { shared: entry(['text', 'image']), speech: entry(['audio']), text: entry(['text']) } },
  other: { models: { shared: entry(['text']) } },
}));
await refreshModelMeta();
assert.deepEqual(suggestedModelSlots('siliconflow-cn', 'shared'), ['chat', 'vision']);
assert.deepEqual(suggestedModelSlots('other', 'shared'), ['chat'], 'same ID is scoped to the correct endpoint');
assert.deepEqual(suggestedModelSlots('', 'speech'), ['asr'], 'audio input/text output suggests transcription');
assert.deepEqual(suggestedModelSlots('', 'gpt-vision-asr-unknown'), ['chat'], 'unknown names do not fabricate vision or audio');
assert.deepEqual(suggestedModelSlots('', 'shared'), ['chat'], 'ambiguous catalog entries need model-level confirmation');
assert.deepEqual(suggestedModelSlots('', 'shared', { metadataCatalogId: 'siliconflow-cn' }), ['chat', 'vision']);
assert.deepEqual(suggestedModelSlots('siliconflow-cn', 'text', { inputCapabilities: ['text', 'image'] }), ['chat', 'vision'], 'API declarations override catalog');
assert.deepEqual(suggestedModelSlots('', 'unknown', { inputCapabilities: ['text', 'image', 'audio'] }), ['chat', 'vision', 'asr']);
assert.deepEqual(suggestedModelSlots('', 'unknown', { inputCapabilities: [] }), [], 'explicit empty input is respected');
assert.deepEqual(suggestedModelSlots('', 'unknown', { outputCapabilities: ['image'] }), [], 'image output is not a text/ASR model');

const sf = { ...createPresetProvider(PROVIDER_PRESETS.find((p) => p.id === 'siliconflow-cn'), 'sf'), apiKey: 'test', serves: [], catalogId: 'sh' };
const custom = { ...sf, id: 'custom', baseUrl: 'https://custom.test/v1', catalogId: '' };
const before = structuredClone(sf);
const ref = { providerId: 'sf', model: 'shared' };
let settings = { ...getSettings(), providers: [sf, custom], savedModels: [], llmModel: ref, visionModel: { providerId: '', model: '' } };
assert.equal(providerCatalogId(sf), 'siliconflow-cn', 'known endpoints auto-resolve their capability catalog');
assert.equal(providerCatalogId(custom), '', 'custom endpoints use exact model ID lookup without guessing a provider');
assert.equal(catalogOf(settings, 'sf'), 'siliconflow-cn');
assert.equal(targetOfSlot(settings, 'chat').catalogId, 'siliconflow-cn');
assert.equal(targetOrNull(settings, ref).catalogId, 'siliconflow-cn');
assert.equal(getModelMeta(targetOfSlot(settings, 'chat').catalogId, 'shared').vision, true);
assert.equal(visionTargetOrNull(settings).providerId, 'sf', 'runtime vision uses the same automatic catalog as the editor');
assert.deepEqual(sf, before, 'catalog resolution does not overwrite persisted user credentials or configuration');
assert.deepEqual(providersForSlot(settings, 'vision'), [], 'no models means no candidates');

settings = { ...settings, ...editModelPatch(settings, null, { ...ref, name: 'Vision model', slots: ['chat', 'vision'] }) };
assert.equal(modelsForSlot(settings, 'vision').length, 1, 'legacy empty provider serves cannot hide a model');
assert.deepEqual(providersForSlot(settings, 'vision').map((p) => p.id), ['sf']);
const speech = { providerId: 'custom', model: 'speech', name: '', slots: ['asr'] };
settings = { ...settings, ...editModelPatch(settings, null, speech) };
assert.deepEqual(modelsForSlot(settings, 'asr'), [speech], 'custom providers can add ASR models without supplier-level flags');
assert.deepEqual(providersForSlot(settings, 'asr').map((p) => p.id), ['custom']);
assert.equal(modelsForSlot({ ...settings, providers: [sf] }, 'asr').length, 0, 'deleted providers stay excluded');
assert.throws(() => editModelPatch(settings, null, { ...speech, model: 'bad', slots: [] }), /模型用途/);
assert.throws(() => editModelPatch(settings, null, { ...speech, model: 'bad', slots: ['invalid'] }), /模型用途/);
const migrated = { ...settings, savedModels: undefined, favorites: { chat: [ref], vision: [ref], asr: [speech] }, asrModel: speech };
assert.equal(modelsForSlot(migrated, 'vision').length, 1, 'legacy per-model uses survive without supplier restrictions');
console.log('PASS: model-derived uses, API precedence, unknown/ambiguous metadata, automatic endpoint catalogs, explicit per-model choices, legacy compatibility, custom endpoints and runtime vision');
