import assert from 'node:assert/strict';
import { getModelMeta, refreshModelMeta } from '../src/api/modelMeta.ts';
import { effectiveContextWindow, isVisionModel, outputLimitOf, supportsThinking, thinkingControlOf, thinkingParams } from '../src/api/modelCaps.ts';
import { editModelPatch } from '../src/store/modelLibrary.ts';
import { chatOnce } from '../src/api/siliconflow.ts';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { getSettings, modelOverridesOf, targetOfSlot, targetOrNull, useSettings, visionTargetOrNull } = await import('../src/store/settings.ts');
const { attachmentsForModel, messageForModel } = await import('../src/chat/attachmentModel.ts');
const entry = { modalities: { input: ['text'], output: ['text'] }, limit: { context: 128000, output: 8192 }, reasoning: false, tool_call: false };
globalThis.fetch = async () => new Response(JSON.stringify({ test: { models: { shared: entry } } }));
await refreshModelMeta(['test']);
const override = { inputCapabilities: ['text', 'image'], contextWindow: 16000, maxOutputTokens: 2048, reasoningEffort: 'low, high', toolCalling: true };
const merged = getModelMeta('test', 'shared', override);
assert.equal(merged.vision, true);
assert.deepEqual(merged.outputModalities, ['text'], 'unconfigured fields inherit the catalog');
assert.equal(merged.context, 16000);
assert.equal(merged.output, 2048);
assert.equal(merged.toolCall, true);
assert.equal(isVisionModel('test', 'shared', override), true);
assert.equal(supportsThinking('test', 'shared', override), true);
assert.equal(outputLimitOf('test', 'shared', override), 2048);
assert.equal(effectiveContextWindow('test', 'shared', 128000, override), 16000, 'smaller explicit windows must win too');
assert.equal(getModelMeta('test', 'shared').vision, false, 'overrides never mutate the catalog cache');
assert.equal(getModelMeta('test', 'shared', { toolCalling: false }).declaredToolCall, false);
assert.deepEqual(getModelMeta('test', 'shared', { inputCapabilities: [] }).inputModalities, []);
assert.equal(isVisionModel('', 'gpt-vision'), false, 'unknown capabilities are not guessed from names');
assert.equal(isVisionModel('', 'Agents-A1', override), true, 'unlisted custom aliases can declare vision');
assert.deepEqual(thinkingParams('siliconflow-cn', 'deepseek-ai/DeepSeek-V4-Flash', 'high', override), { enable_thinking: true, reasoning_effort: 'high' });
assert.equal(thinkingControlOf('siliconflow-cn', 'deepseek-ai/DeepSeek-V4-Flash', { reasoningEffort: '' }), null, 'explicit disable wins over document corrections');
assert.equal(supportsThinking('test', 'shared', { reasoningEffort: '' }), false);

const provider = { id: 'first', name: 'First', baseUrl: 'https://models.test/v1', apiKey: 'test', protocol: 'openai-chat', serves: ['chat', 'vision'], catalogId: 'test' };
const ref = { providerId: 'first', model: 'shared' };
useSettings.getState().update({
  providers: [provider, { ...provider, id: 'second' }], llmModel: ref, visionModel: { providerId: '', model: '' },
  savedModels: [{ ...ref, ...override, name: '', slots: ['chat', 'vision'] }, { providerId: 'second', model: 'shared', name: '', slots: ['chat'] }],
});
let settings = getSettings();
assert.equal(modelOverridesOf(settings, ref).inputCapabilities.includes('image'), true, 'runtime snapshots preserve saved capabilities');
const first = targetOfSlot(settings, 'chat');
const second = targetOrNull(settings, { providerId: 'second', model: 'shared' });
assert.equal(isVisionModel(first.catalogId, first.model, first.capabilities), true);
assert.equal(isVisionModel(second.catalogId, second.model, second.capabilities), false, 'overrides are isolated even across connections sharing one catalog');
assert.equal(visionTargetOrNull(settings).providerId, 'first', 'auto mode reuses a capable main model');
settings.savedModels[0].inputCapabilities.push('audio');
assert.deepEqual(useSettings.getState().savedModels[0].inputCapabilities, ['text', 'image'], 'snapshots do not mutate stored arrays');
const file = { id: 'image', name: 'slide.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' };
globalThis.fetch = () => { throw new Error('direct image reading must not invoke a separate model'); };
assert.deepEqual(await attachmentsForModel([file], 'Read this', new AbortController().signal), [file]);
assert.ok(messageForModel({ role: 'user', content: 'Read', attachments: [file] }).content.some((part) => part.type === 'image_url'));
useSettings.getState().update({ llmModel: { providerId: 'second', model: 'shared' } });
assert.equal(visionTargetOrNull(getSettings()), null, 'auto mode never silently ignores missing image capabilities');
useSettings.getState().update({ visionModel: ref });
assert.equal(visionTargetOrNull(getSettings()).providerId, 'first', 'explicit vision models are preserved');
const original = getSettings().savedModels[0];
for (const bad of [-1, 0, NaN, 1.5]) assert.throws(() => editModelPatch(getSettings(), original, { ...original, contextWindow: bad }), /正整数/);
assert.throws(() => editModelPatch(getSettings(), original, { ...original, reasoningEffort: 'made-up' }), /推理等级/);

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify(protocol === 'openai-chat' ? { choices: [{ message: { role: 'assistant', content: 'ok' } }] } : protocol === 'openai-responses' ? { output: [] } : { content: [] }));
  };
  await chatOnce({ ...first, protocol }, { messages: [{ role: 'user', content: 'test' }], max_tokens: 8000 });
  assert.equal(body.max_tokens ?? body.max_output_tokens, 2048, `user output limit reaches ${protocol} requests`);
  await assert.rejects(chatOnce({ ...first, protocol, capabilities: { toolCalling: false } }, { messages: [], tools: [{ type: 'function', function: { name: 'test', description: '', parameters: {} } }] }), /不支持工具调用/);
}
globalThis.fetch = async () => new Response(JSON.stringify({ test: { models: { shared: { ...entry, limit: { context: 1000000, output: 99999 } } } } }));
await refreshModelMeta(['test']);
assert.equal(getModelMeta('test', 'shared', override).context, 16000, 'refresh never overwrites user fields');
assert.equal(getModelMeta('test', 'shared').context, 1000000, 'removing overrides restores the refreshed defaults');
console.log('PASS: per-field overrides, explicit false/empty, connection isolation, runtime snapshots, vision routing, reasoning controls, request limits, validation and refresh');
