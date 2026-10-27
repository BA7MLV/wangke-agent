import assert from 'node:assert/strict';
import { createCloudModelDraft, cloudModelConfig, cloudModelPreferences, cloudDiscoveryProviders } from '../src/cloud/modelSettings.ts';
import { useSettings } from '../src/store/settings.ts';
import { DEFAULT_AGENT_POLICY } from '../packages/contracts/src/cloud.ts';

const config = {
  providers: [{ id: 'p1', name: 'Test', baseUrl: 'https://models.example/v1', protocol: 'openai-chat', configured: true, catalogId: 'test', serves: ['chat'] }],
  llmModel: { providerId: 'p1', model: 'model' }, visionModel: { providerId: '', model: '' }, asrModel: { providerId: '', model: '' },
  policy: { ...DEFAULT_AGENT_POLICY },
};
const original = useSettings.getState();
const store = createCloudModelDraft(config, original);
const before = store.getState();
assert.equal(before.providers[0].apiKey, '', 'server credentials are never hydrated into the editor');
assert.equal(cloudModelConfig(before, config).providers[0].apiKey, undefined, 'blank keys preserve existing server credentials');
assert.equal(cloudDiscoveryProviders(before, config)[0].baseUrl, '/api/v1/cloud/models/p1');
store.getState().update({ providers: [{ ...before.providers[0], apiKey: 'new-secret' }] });
assert.strictEqual(useSettings.getState(), original, 'draft updates cannot affect persistent runtime settings');
assert.deepEqual(cloudDiscoveryProviders(store.getState(), config), [], 'unsaved credentials cannot discover through a stale connection or leak to the browser transport');
const latest = { ...config, policy: { ...config.policy, shell: 'deny' }, trustedAgentIds: ['trusted'] };
const payload = cloudModelConfig(store.getState(), latest);
assert.equal(payload.providers[0].apiKey, 'new-secret');
assert.equal(payload.providers[0].baseUrl, 'https://models.example/v1', 'proxy URL is never saved as an upstream endpoint');
assert.equal(payload.policy.shell, 'deny', 'model saves preserve the latest policy');
assert.deepEqual(payload.trustedAgentIds, ['trusted']);
assert.ok(!JSON.stringify(cloudModelPreferences(store.getState())).includes('new-secret'), 'account preferences never include credentials');
store.getState().update({ providers: [{ ...before.providers[0], baseUrl: 'https://changed.example/v1' }] });
assert.deepEqual(cloudDiscoveryProviders(store.getState(), config), [], 'unsaved endpoint changes do not reuse old discovery');
store.getState().update({ providers: [{ ...before.providers[0], protocol: 'anthropic-messages' }] });
assert.deepEqual(cloudDiscoveryProviders(store.getState(), config), [], 'unsaved protocol changes do not reuse old discovery');
console.log('PASS: cloud draft isolation, credential retention, server-only discovery, endpoint/protocol changes and policy preservation');
