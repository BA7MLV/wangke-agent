import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { getSettings, visionTargetOrNull, useSettings } = await import('../src/store/settings.ts');
const { attachmentsForModel, messageForModel } = await import('../src/chat/attachmentModel.ts');
const provider = (id, apiKey = 'test') => ({ id, name: id, apiKey, baseUrl: `https://${id}.test/v1`, protocol: 'openai-chat', serves: ['chat', 'vision'], catalogId: '' });
const text = { providerId: 'main', model: 'custom-text', name: '', slots: ['chat'], inputCapabilities: ['text'] };
const vision = { providerId: 'reader', model: 'custom-reader', name: '', slots: ['vision'], inputCapabilities: ['text', 'image'] };
const settings = {
  ...getSettings(), providers: [provider('main'), provider('reader')],
  llmModel: text, visionModel: { providerId: '', model: '' },
  savedModels: [text, vision], favorites: { chat: [], vision: [], asr: [] },
};
assert.equal(visionTargetOrNull(settings).providerId, 'reader', 'text main falls back across providers');
assert.equal(visionTargetOrNull({ ...settings, llmModel: vision }).providerId, 'reader', 'capable main is reused');
assert.equal(visionTargetOrNull({ ...settings, visionModel: text }), null, 'explicit text-only selection is not overridden');
assert.equal(visionTargetOrNull({ ...settings, savedModels: [text] }), null, 'never invent an unconfigured model');
assert.equal(visionTargetOrNull({ ...settings, savedModels: [text, { ...vision, slots: ['chat'] }] }), null, 'fallback honors model purpose');
assert.equal(visionTargetOrNull({ ...settings, providers: [provider('main')] }), null, 'deleted providers are skipped');
assert.equal(visionTargetOrNull({ ...settings, providers: [provider('main'), provider('reader', ' ')] }), null, 'automatic fallback needs credentials');
assert.equal(visionTargetOrNull({ ...settings, providers: [provider('main'), { ...provider('reader'), serves: ['chat'] }] }), null, 'fallback honors provider purpose');
assert.equal(visionTargetOrNull({ ...settings, savedModels: [text, { ...vision, inputCapabilities: ['text'] }] }), null, 'explicit text-only capabilities win');
assert.equal(visionTargetOrNull({ ...settings, savedModels: [text, { ...vision, inputCapabilities: undefined }] }).providerId, 'reader', 'vision purpose confirms unlisted aliases');
const preferred = { ...vision, providerId: 'preferred' };
assert.equal(visionTargetOrNull({ ...settings, providers: [...settings.providers, provider('preferred')], savedModels: [text, vision, preferred], favorites: { ...settings.favorites, vision: [preferred] } }).providerId, 'preferred', 'vision favorites take precedence');
assert.equal(visionTargetOrNull({ ...settings, savedModels: undefined, favorites: { ...settings.favorites, vision: [vision] } }).providerId, 'reader', 'legacy vision favorites remain usable');

useSettings.getState().update(settings);
const file = { id: 'slide', name: 'slide.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' };
const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '画面文字：学习目标' } }] }));
};
const described = await attachmentsForModel([file], '整理讲义', new AbortController().signal);
assert.equal(requests.length, 1);
assert.equal(requests[0].url, 'https://reader.test/v1/chat/completions');
assert.equal(requests[0].body.model, vision.model);
assert.ok(requests[0].body.messages[0].content.some((p) => p.type === 'image_url'));
assert.equal(described[0].description, '画面文字：学习目标');
const message = messageForModel({ role: 'user', content: '整理讲义', attachments: described });
assert.ok(JSON.stringify(message).includes('学习目标'));
assert.ok(!JSON.stringify(message).includes('image_url'), 'text main receives description, never unsupported image parts');
useSettings.getState().update({ llmModel: vision });
assert.deepEqual(await attachmentsForModel([file], '整理讲义', new AbortController().signal), [file]);
assert.equal(requests.length, 1, 'vision main reads directly without redundant calls');
useSettings.getState().update({ ...settings, savedModels: [text] });
await assert.rejects(attachmentsForModel([file], '整理讲义', new AbortController().signal), /不支持图片/);
console.log('PASS: vision fallback priority, capabilities, purposes, credentials, legacy settings, cross-provider image descriptions and direct reading');
