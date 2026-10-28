import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { registerCloudRoutes } from '../apps/api/src/cloud/routes.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-configuration-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const owner = crypto.randomUUID();
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, new Date().toISOString());
const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const app = Fastify();
const previousWorker = process.env.CLOUD_WORKER_DISABLED;
process.env.CLOUD_WORKER_DISABLED = '1';
registerCloudRoutes(app, { store, configuration, records: new CloudRecords(store), filesDir: directory, maxFileBytes: 1024,
  requireAuth: (request, reply) => request.headers['x-test-auth'] === 'no' ? (reply.code(401).send({ error: 'unauthorized' }), null) : { id: owner },
  checkOrigin: (request) => request.headers['x-test-origin'] !== 'no',
});
const put = async (url, payload, headers = {}) => {
  const response = await app.inject({ method: 'PUT', url: `/api/v1/cloud${url}`, payload, headers });
  return { status: response.statusCode, body: response.json() };
};
const provider = { id: 'p1', name: 'First', baseUrl: 'https://models.example/v1', protocol: 'openai-chat', apiKey: 'first-secret', catalogId: '', serves: ['chat'] };
try {
  let config = configuration.get(owner);
  const baseRevision = config.modelRevision;
  let result = await put('/providers/p1', { provider, modelRevision: baseRevision });
  assert.equal(result.status, 200, 'first connection saves without selecting a default model');
  assert.ok(!JSON.stringify(result.body).includes('first-secret'));
  config = result.body;
  assert.notEqual(config.modelRevision, baseRevision);
  assert.equal(config.providers[0].configured, true);
  assert.equal(configuration.get(owner, true).providers[0].apiKey, 'first-secret');

  result = await put('/providers/p2', { provider: { ...provider, id: 'p2' }, modelRevision: baseRevision });
  assert.equal(result.status, 409, 'stale editors cannot silently overwrite config');
  assert.equal(configuration.get(owner).providers.length, 1);
  result = await put('/providers/p1', { provider: { ...provider, apiKey: undefined }, modelRevision: config.modelRevision });
  assert.equal(result.status, 200);
  assert.equal(configuration.get(owner, true).providers[0].apiKey, 'first-secret', 'blank editor keeps server credentials');

  config = result.body;
  const beforeRotation = config.modelRevision;
  result = await put('/providers/p1', { provider: { ...provider, apiKey: 'rotated-secret' }, modelRevision: config.modelRevision });
  config = result.body;
  assert.notEqual(config.modelRevision, beforeRotation, 'credential rotation invalidates discovery identity');
  assert.ok(!store.db.prepare('SELECT value FROM cloud_config WHERE owner_id=?').get(owner).value.includes('rotated-secret'));

  result = await put('/model-settings', { ...config, llmModel: { providerId: 'missing', model: 'chat' },
    asrModel: { providerId: 'missing', model: 'speech' }, decisionModel: { providerId: 'missing', model: 'decision' } });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body.issues.map((issue) => issue.path), ['llmModel', 'asrModel', 'decisionModel'], 'all invalid fields are reported together');
  assert.equal(result.body.issues[0].reason, 'provider_not_found');

  // Updating account policy does not invalidate a model editor, and model saves cannot change it.
  configuration.save(owner, { ...configuration.get(owner), policy: { ...config.policy, shell: 'deny' } });
  assert.equal(configuration.get(owner).modelRevision, config.modelRevision);
  result = await put('/model-settings', { ...config, policy: { ...config.policy, shell: 'allow' },
    llmModel: { providerId: 'p1', model: 'chat' }, decisionModel: { providerId: 'p1', model: 'decision' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.policy.shell, 'deny');
  config = result.body;
  result = await put('/model-settings', { ...config, providers: [] });
  assert.equal(result.status, 400, 'deletion without reference cleanup is rejected atomically');
  assert.equal(configuration.get(owner).providers.length, 1);
  result = await put('/model-settings', { ...config, providers: [], llmModel: { providerId: '', model: '' }, decisionModel: { providerId: '', model: '' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.providers.length, 0);
  assert.deepEqual(result.body.decisionModel, { providerId: '', model: '' });

  // Legacy dangling references must not prevent saving the connection needed to fix them.
  const legacy = { ...result.body, llmModel: { providerId: 'deleted', model: 'old-model' } };
  store.db.prepare('UPDATE cloud_config SET value=? WHERE owner_id=?').run(configuration.seal(JSON.stringify(legacy)), owner);
  config = configuration.get(owner);
  result = await put('/providers/p1', { provider, modelRevision: config.modelRevision });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.llmModel, legacy.llmModel, 'independent save preserves the reference for explicit repair');
  config = result.body;
  result = await put('/model-settings', { ...config, llmModel: { providerId: 'p1', model: 'repaired' } });
  assert.equal(result.status, 200);

  config = result.body;
  result = await put('/providers/p1', { provider: { ...provider, baseUrl: 'https://user:password@models.example/v1' }, modelRevision: config.modelRevision });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body.issues, [{ path: 'providers.p1.baseUrl', reason: 'invalid_url' }]);
  assert.equal((await put('/providers/p1', { provider })).status, 400, 'version required on scoped endpoints');
  assert.equal((await put('/providers/p1', { provider, modelRevision: config.modelRevision }, { 'x-test-auth': 'no' })).status, 401);
  assert.equal((await put('/model-settings', { ...config, llmModel: { providerId: 'p1', model: 'x'.repeat(201) } })).body.issues[0].reason, 'model_too_long');
  console.log('PASS: scoped config APIs, incomplete setup, version conflicts, policy isolation, credentials, legacy recovery, atomic deletion and field errors');
} finally {
  await app.close();
  store.close();
  if (previousWorker === undefined) delete process.env.CLOUD_WORKER_DISABLED;
  else process.env.CLOUD_WORKER_DISABLED = previousWorker;
  fs.rmSync(directory, { recursive: true, force: true });
}
