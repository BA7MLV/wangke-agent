import assert from 'node:assert/strict';
import test from 'node:test';
import catalogData from '../apps/web/src/api/catalog/models.generated.json' with { type: 'json' };
import { errorKey, initialStep, previousStep, SETUP_STEPS, STEP_FIGURE, stepForError, stepIndex } from '../apps/web/src/cloud/onboarding/flow.ts';
import { applyChoice, slotRef } from '../apps/web/src/cloud/onboarding/models.ts';
import { fitsSlot, modelsForSlot, providersForSlot } from '../apps/web/src/api/catalog/index.ts';

test('first deploy starts at welcome, later visits go straight to login', () => {
  assert.equal(initialStep({ initialized: false, authenticated: false }), 'welcome');
  assert.equal(initialStep({ initialized: true, authenticated: false }), 'login');
  assert.equal(initialStep({ initialized: true, authenticated: true }), 'models');
});

test('back walks the setup steps and stops at the ends', () => {
  assert.equal(previousStep('account'), 'key');
  assert.equal(previousStep('key'), 'welcome');
  assert.equal(previousStep('welcome'), null);
  assert.equal(previousStep('login'), null);
  assert.equal(previousStep('name'), null, 'admin already exists; no way back to creation');
  assert.equal(previousStep('models'), 'name');
});

test('errors send the user to the step that can fix them', () => {
  assert.equal(stepForError('account', 'invalid_or_expired_bootstrap_secret'), 'key');
  assert.equal(stepForError('account', 'bootstrap_closed'), 'login');
  assert.equal(stepForError('account', 'admin_password_must_be_12_to_256_characters'), 'account');
  assert.equal(stepForError('login', 'invalid_credentials'), 'login');
});

test('known errors are translated, unknown ones pass through', () => {
  assert.equal(errorKey('invalid_credentials'), 'invalid_credentials');
  assert.equal(errorKey('http_502'), null);
});

test('progress dots cover only the setup flow', () => {
  assert.deepEqual(SETUP_STEPS.map(stepIndex), [1, 2, 3, 4, 5]);
  assert.equal(stepIndex('login'), 0);
  for (const step of [...SETUP_STEPS, 'login']) assert.ok(STEP_FIGURE[step], `${step} has a figure`);
});

const baseConfig = () => ({
  providers: [], llmModel: { providerId: '', model: '' }, visionModel: { providerId: '', model: '' }, asrModel: { providerId: '', model: '' },
  policy: { read: 'allow', write: 'ask', remove: 'ask', shell: 'ask', network: 'deny', maxSteps: 100 },
});

test('generated catalog comes from models.dev and has usable providers for every slot', () => {
  assert.equal(catalogData.source, 'https://models.dev');
  for (const p of catalogData.providers) {
    assert.match(p.baseUrl, /^https:\/\//, `${p.id} base URL`);
    assert.ok(['openai-chat', 'openai-responses', 'anthropic-messages'].includes(p.protocol), `${p.id} protocol`);
  }
  for (const slot of ['chat', 'vision', 'asr', 'decision']) assert.ok(providersForSlot(catalogData, slot).length > 0, `${slot} has providers`);
  const typesafe = catalogData.providers.find((p) => p.id === 'typesafe');
  assert.ok(typesafe && modelsForSlot(typesafe, 'decision').length > 0, 'decision models come from TypeSafe');
});

test('slot filters follow declared capabilities, not names', () => {
  assert.equal(fitsSlot({ id: 'a', name: 'a' }, 'chat'), true);
  assert.equal(fitsSlot({ id: 'a', name: 'a' }, 'vision'), false);
  assert.equal(fitsSlot({ id: 'v', name: 'v', input: ['text', 'image'] }, 'vision'), true);
  assert.equal(fitsSlot({ id: 'w', name: 'w', type: 'transcription', input: ['audio'] }, 'asr'), true);
  assert.equal(fitsSlot({ id: 'w', name: 'w', type: 'transcription', input: ['audio'] }, 'chat'), false);
  assert.equal(fitsSlot({ id: 'o', name: 'o', input: ['text', 'audio'], toolCall: true }, 'asr'), false, 'omni chat models are not transcription endpoints');
  assert.equal(fitsSlot({ id: 'j', name: 'j', type: 'decision' }, 'chat'), false);
  assert.equal(fitsSlot({ id: 'j', name: 'j', type: 'decision' }, 'decision'), true);
});

test('choosing models registers each provider once and keeps saved keys', () => {
  const deepseek = catalogData.providers.find((p) => p.id === 'deepseek');
  let config = applyChoice(baseConfig(), 'chat', { kind: 'catalog', provider: deepseek, apiKey: 'sk-1', model: deepseek.models[0].id });
  assert.equal(config.providers.length, 1);
  assert.deepEqual(slotRef(config, 'chat'), { providerId: 'deepseek', model: deepseek.models[0].id });
  config = applyChoice(config, 'vision', { kind: 'catalog', provider: deepseek, model: 'x' });
  assert.equal(config.providers.length, 1, 'same provider reused');
  assert.equal(config.providers[0].apiKey, 'sk-1', 'empty key keeps the saved one');
  assert.deepEqual(config.providers[0].serves, ['chat', 'vision']);
  config = applyChoice(config, 'asr', { kind: 'custom', baseUrl: 'https://asr.example/v1', apiKey: 'k', model: 'whisper' });
  assert.equal(config.providers[1].id, 'custom');
  assert.equal(config.providers[1].name, 'asr.example');
  config = applyChoice(config, 'decision', { kind: 'custom', baseUrl: 'https://d.example/v1', apiKey: 'k', model: 'jev' });
  assert.equal(config.providers[2].id, 'custom-2');
  config = applyChoice(config, 'vision', null);
  assert.deepEqual(slotRef(config, 'vision'), { providerId: '', model: '' });
  assert.deepEqual(slotRef(baseConfig(), 'decision'), { providerId: '', model: '' }, 'old configs without decisionModel');
});
