/** Build and boot in a fresh tree that physically has no Web sources or UI deps. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoot = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(temporaryRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(temporaryRoot, 'wangke-api-isolation-'));
execFileSync('npm', ['exec', '--', 'turbo', 'prune', '@wangke/api', '--docker', `--out-dir=${output}`], {
  cwd: repository, stdio: 'inherit', env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
});
const directory = path.join(output, 'full');
fs.cpSync(path.join(output, 'json'), directory, { recursive: true });
console.log(`Isolated API verification directory: ${directory}`);
const run = args => execFileSync('npm', args, { cwd: directory, stdio: 'inherit' });
// Use the actual dependency-graph-pruned lockfile, not a hand-written allowlist.
run(['ci', '--no-audit', '--no-fund']);
run(['run', 'build', '-w', '@wangke/contracts']);
run(['run', 'build', '-w', '@wangke/study-core']);
run(['run', 'typecheck', '-w', '@wangke/api']);
run(['run', 'build', '-w', '@wangke/api']);
for (const forbidden of ['src', 'apps/web', 'dist', 'node_modules/react', 'node_modules/react-dom', 'node_modules/vite', 'node_modules/zustand']) {
  assert.equal(fs.existsSync(path.join(directory, forbidden)), false, `API isolation leak: ${forbidden}`);
}
run(['prune', '--omit=dev', '--no-audit', '--no-fund']);
// Boot the compiled server, not tsx, against a disposable empty database.
const verify = `
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = path.resolve('verification-data');
const { buildServer } = await import('./apps/api/dist/apps/api/src/server.js');
const app = buildServer();
try {
  await app.ready();
  for (const url of ['/api/v1/health', '/api/v1/ready', '/api/v1/bootstrap/status']) {
    const result = await app.inject({url});
    assert.equal(result.statusCode, 200, result.body);
  }
  for (const url of ['/', '/index.html', '/config.js', '/api/unknown']) {
    const result = await app.inject({url});
    assert.equal(result.statusCode, 404, result.body);
    assert.equal(result.json().error, 'not_found');
  }
  assert.equal(await app.drainForRelease(1000), true);
  assert.equal((await app.inject({ url: '/api/v1/ready' })).statusCode, 503);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/cloud/worker/claim', payload: {} })).statusCode, 503);
  console.log('Compiled API boot/health/readiness/bootstrap/404/drain passed without Web, UI dependencies or devDependencies.');
} finally { await app.close(); }
process.env.API_RELEASE_ID = crypto.randomUUID();
process.env.API_RELEASE_TOKEN = 'a'.repeat(64);
const staged = buildServer();
try {
  const origin = await staged.listen({host:'127.0.0.1', port:0});
  assert.equal((await fetch(origin + '/api/v1/ready')).status, 503);
  const headers = {'x-deployment-token':process.env.API_RELEASE_TOKEN};
  const status = await (await fetch(origin + '/api/v1/deployment/status', {headers})).json();
  assert.equal(status.held, true);
  assert.match(status.database.schemaHash, /^[a-f0-9]{64}$/);
  assert.equal((await fetch(origin + '/api/v1/deployment/activate', {method:'POST',headers})).status, 200);
  assert.equal((await fetch(origin + '/api/v1/ready')).status, 200);
} finally { await staged.close(); }
console.log('Compiled staged activation and image database metadata passed without source/devDependencies.');
`;
fs.writeFileSync(path.join(directory, 'verify.mjs'), verify);
execFileSync(process.execPath, ['verify.mjs'], { cwd: directory, stdio: 'inherit' });
const maintenance = ['apps/api/scripts/deployment-maintenance.mjs'];
const metadata = JSON.parse(execFileSync(process.execPath, [...maintenance, 'metadata'], { cwd: directory, encoding: 'utf8' }));
const inspected = JSON.parse(execFileSync(process.execPath, [...maintenance, 'snapshot', 'verification-data/db/wangke.sqlite', 'verification-point/db/wangke.sqlite'], { cwd: directory, encoding: 'utf8' }));
assert.equal(inspected.schemaHash, metadata.schemaHash);
execFileSync(process.execPath, [...maintenance, 'verify', 'verification-point/db/wangke.sqlite'], { cwd: directory, stdio: 'inherit' });
console.log(`API isolation passed; pruned lockfile and artifacts retained at ${directory}`);
