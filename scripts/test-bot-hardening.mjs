import assert from 'node:assert/strict';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { ToolRegistry } from '../apps/api/src/agent/tools/registry.ts';
import { CloudTaskRunner } from '../apps/api/src/cloud/tasks.ts';
import { publishBotEvent } from '../apps/api/src/agent/events.ts';

const failures = [];
const rejected = error => failures.push(error);
process.on('unhandledRejection', rejected);
try {
  const runner = new BotRunner({ transaction() { throw new Error('simulated_db_failure SECRET'); } });
  runner.start();
  runner.enqueue();
  const childRunner = new CloudTaskRunner({ transaction() { throw new Error('child_db_failure'); } });
  childRunner.start('http://127.0.0.1:1');
  await new Promise(resolve => setTimeout(resolve, 30));
  await runner.close();
  await childRunner.close();
  runner.enqueue();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(failures.length, 0, 'scheduler/start/error persistence must not leak rejections');
  const registry = new ToolRegistry();
  const definition = { type: 'function', function: { name: 'strict', description: 'test', parameters: { type: 'object', additionalProperties: false, properties: { x: { type: 'integer', minimum: 1 } }, required: ['x'] } } };
  registry.register(definition, 'uncertain');
  assert.throws(() => registry.register(definition, 'read'), /duplicate/);
  for (const args of [{}, { x: '1' }, { x: 0 }, { x: 1, owner: 'forged' }, []]) assert.equal(registry.validate('strict', args).ok, false);
  assert.equal(registry.validate('strict', { x: 1 }).ok, true);
  assert.equal(registry.validate('unknown', {}).ok, false);
  for (const parameters of [{ $ref: 'https://example.com/schema' }, { type: 'string', pattern: '(a+)+$' }, { unsupported: true }]) {
    assert.throws(() => new ToolRegistry().register({ ...definition, function: { ...definition.function, parameters } }, 'read'));
  }
  let performed = false;
  await assert.rejects(registry.execute('strict', { x: 1 }, { owner: 'o', thread: 't', run: 'r', step: 's', signal: new AbortController().signal, checkActive() { throw new Error('revoked'); } }, async () => { performed = true; }));
  assert.equal(performed, false);
  publishBotEvent({ transaction() { throw new Error('observer_storage_failed'); } }, { owner: 'owner', type: 'run.started' }, async () => { throw new Error('observer_failed'); });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(failures.length, 0, 'observer failures never leak rejected promises');
  console.log('Hardening: background rejection isolation, close guard, schema strictness and authorization boundary passed');
} finally { process.off('unhandledRejection', rejected); }
