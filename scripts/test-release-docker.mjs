import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DockerReleaseAdapter } from './lib/release-docker.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/release-docker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data')); fs.writeFileSync(path.join(root, '.env'), 'SECRET=not-in-arguments');
  fs.writeFileSync(path.join(root, 'deployment-images.json'), '{}');
  const adapter = new DockerReleaseAdapter(root, ['/source/compose.yaml', '/source/compose.agent.yaml']);
  const calls = [], containers = [];
  const api = { Id: 'api-id', State: { Running: false }, Mounts: [], Config: { Labels: {} } };
  adapter.run = args => {
    calls.push(args);
    if (args[0] === 'compose') {
      if (args.includes('config')) return JSON.stringify({ services: { api: {}, web: {}, proxy: {}, 'sandbox-broker': {} } });
      if (args.includes('ps')) return 'api-id';
      if (args.includes('exec')) return JSON.stringify({ releaseId: 'id', activated: true });
      return '';
    }
    if (args[0] === 'inspect') return JSON.stringify(args.slice(1).map(id => id === api.Id ? api : containers.find(c => c.Id === id)));
    if (args[0] === 'ps') return containers.map(c => c.Id).join('\n');
    if (args[0] === 'stop') { containers.splice(containers.findIndex(c => c.Id === args.at(-1)), 1); return ''; }
    if (args[0] === 'run') return JSON.stringify({ schemaHash: 'a'.repeat(64) });
    throw new Error(`unexpected_command:${args}`);
  };
  const mounted = (id, source, sandbox) => ({ Id: id, Mounts: [{ Type: 'bind', Source: source, RW: true }], Config: { Labels: sandbox ? { 'wangke.sandbox': 'true' } : {} } });
  return { root, adapter, api, calls, containers, mounted };
}

test('barrier stops only own writable sandbox executions, never stable edge/web', async t => {
  const f = fixture(t);
  f.containers.push(f.mounted('own-exec', path.join(f.adapter.data, 'files/projects/project-id'), true));
  f.containers.push(f.mounted('other-installation', '/elsewhere/files/projects/id', true));
  await f.adapter.stopWriters();
  assert.deepEqual(f.calls.filter(args => args[0] === 'stop'), [['stop', '-t', '10', 'own-exec']]);
  const stopped = f.calls.filter(args => args[0] === 'compose' && args.includes('stop')).map(args => args.at(-1));
  assert.deepEqual(stopped, ['api', 'sandbox-broker']);
  assert.ok(f.calls.every(args => !args.includes('down') && !args.includes('proxy') && !args.includes('web')));
});

test('unknown writable bind or still-running API refuses barrier without killing foreign work', async t => {
  const f = fixture(t);
  f.containers.push(f.mounted('foreign-writer', f.adapter.data, false));
  await assert.rejects(() => f.adapter.stopWriters(), /uncoordinated_data_writer:foreign-writer/);
  assert.ok(!f.calls.some(args => args[0] === 'stop'));
  f.api.State.Running = true;
  await assert.rejects(() => f.adapter.stopWriters(), /api_still_running/);
});

test('failed recreate with no API container still allows the rollback writer barrier', async t => {
  const f = fixture(t), run = f.adapter.run;
  f.adapter.run = args => args[0] === 'compose' && args.includes('ps') ? '' : run(args);
  await f.adapter.stopWriters();
  assert.throws(() => f.adapter.container('api'), /single_container_required/);
});

test('snapshot uses previous immutable image, no network, actual bind paths and explicit UID', async t => {
  const f = fixture(t);
  const image = `registry.invalid/api@sha256:${'b'.repeat(64)}`;
  f.adapter.previous = { images: { api: { image } } };
  await f.adapter.snapshot(path.join(f.root, 'snapshot/data'));
  const args = f.calls.at(-1);
  assert.ok(args.includes(image)); assert.ok(args.includes('none')); assert.ok(args.includes('--user'));
  assert.ok(args.includes(`type=bind,source=${f.adapter.data},target=/live`));
  assert.deepEqual(args.slice(-3), ['snapshot', '/live/db/wangke.sqlite', '/snapshot/db/wangke.sqlite']);
});

test('recreate uses no dependencies/build; local authenticated control keeps secrets out of args', async t => {
  const f = fixture(t);
  await f.adapter.startStaged(); await f.adapter.web(); await f.adapter.activate({ id: 'id' });
  for (const args of f.calls.filter(args => args.includes('up'))) {
    assert.ok(args.includes('--force-recreate') && args.includes('--no-deps') && args.includes('--no-build'));
    assert.ok(!args.includes('proxy'));
    assert.ok(args.includes(f.adapter.override), 'immutable override participates in every invocation');
  }
  const control = f.calls.at(-1);
  assert.ok(control.includes('exec') && control.includes('-T'));
  assert.match(control.at(-1), /process.env.API_RELEASE_TOKEN/);
  assert.ok(!JSON.stringify(f.calls).includes('not-in-arguments'));
});

test('readiness checks actual image IDs and health, not configured tag text', async t => {
  const f = fixture(t);
  f.adapter.retry = operation => operation();
  f.adapter.matchImage = service => {
    if (service === 'web') return { State: { Health: { Status: 'starting' } } };
    return {};
  };
  const manifest = { images: { api: { image: 'api' }, web: { image: 'web' } } };
  await assert.rejects(() => f.adapter.ready(manifest), /web_not_healthy/);
  f.adapter.matchImage = () => { throw new Error('deployed_image_mismatch:api'); };
  await assert.rejects(() => f.adapter.ready(manifest), /deployed_image_mismatch/);
});

test('preflight refuses uncovered DB/file paths, nested mounts and UID mismatches before pull/stop', async t => {
  const f = fixture(t);
  const config = { services: { api: {
    user: `${process.getuid()}:${process.getgid()}`,
    environment: { DATA_DIR: '/data', DB_PATH: '/data/db/wangke.sqlite', FILES_DIR: '/data/files', BOOTSTRAP_SECRET_FILE: '/data/config/bootstrap-secret' },
    volumes: [{ type: 'bind', source: f.adapter.data, target: '/data' }],
  }, web: {}, proxy: {} } };
  f.adapter.config = () => structuredClone(config);
  const previous = { images: {} };
  config.services.api.environment.DB_PATH = '/elsewhere/live.sqlite';
  await assert.rejects(() => f.adapter.preflight(previous, previous, []), /unsupported_release_storage_paths/);
  config.services.api.environment.DB_PATH = '/data/db/wangke.sqlite';
  config.services.api.volumes.push({ type: 'volume', source: 'outside', target: '/data/files' });
  await assert.rejects(() => f.adapter.preflight(previous, previous, []), /uncovered_api_storage_mount/);
  config.services.api.volumes.pop(); config.services.api.user = '99999:99999';
  await assert.rejects(() => f.adapter.preflight(previous, previous, []), /uid/);
  assert.deepEqual(f.calls, []);
});

test('running-container storage drift cannot be hidden by a correct Compose file', async t => {
  const f = fixture(t);
  const environment = { DATA_DIR: '/data', DB_PATH: '/data/db/wangke.sqlite', FILES_DIR: '/data/files', BOOTSTRAP_SECRET_FILE: '/data/config/bootstrap-secret' };
  const user = `${process.getuid()}:${process.getgid()}`;
  f.adapter.config = () => ({ services: { api: { user, environment, volumes: [{ type: 'bind', source: f.adapter.data, target: '/data' }] }, web: {}, proxy: {} } });
  const actual = { Mounts: [{ Type: 'bind', Source: f.root, Destination: '/data' }], Config: { User: user, Env: Object.entries(environment).map(([k,v]) => `${k}=${v}`) } };
  f.adapter.matchImage = () => actual;
  f.adapter.run = args => { if (args[0] !== 'image') throw new Error('must_not_run_maintenance'); return '[]'; };
  const previous = { images: { api: { image: 'api' }, web: { image: 'web' } } };
  await assert.rejects(() => f.adapter.preflight(previous, previous, []), /running_api_data_mount_mismatch/);
  actual.Mounts[0].Source = f.adapter.data;
  actual.Config.Env = actual.Config.Env.map(value => value.startsWith('FILES_DIR=') ? 'FILES_DIR=/elsewhere' : value);
  await assert.rejects(() => f.adapter.preflight(previous, previous, []), /running_api_storage_environment_mismatch/);
});

test('explicit preloaded transport resolves exact digest locally and never silently pulls or substitutes a tag', t => {
  const f = fixture(t), calls = [];
  const image = `local-test/api@sha256:${'f'.repeat(64)}`;
  f.adapter.run = args => { calls.push(args); return '[]'; };
  f.adapter.obtain(image);
  f.adapter.preloaded = true; f.adapter.obtain(image);
  assert.deepEqual(calls, [['pull', image], ['image', 'inspect', image]]);
  f.adapter.run = () => { throw new Error('missing_local_digest'); };
  assert.throws(() => f.adapter.obtain(image), /missing_local_digest/);
});
