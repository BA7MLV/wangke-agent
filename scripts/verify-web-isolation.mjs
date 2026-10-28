import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoot = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(temporaryRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(temporaryRoot, 'wangke-web-isolation-'));
execFileSync('npm', ['exec', '--', 'turbo', 'prune', '@wangke/web', '--docker', `--out-dir=${output}`], {
  cwd: repository, stdio: 'inherit', env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
});
const directory = path.join(output, 'full');
fs.cpSync(path.join(output, 'json'), directory, { recursive: true });
console.log(`Isolated Web verification directory: ${directory}`);
const run = args => execFileSync('npm', args, { cwd: directory, stdio: 'inherit' });
run(['ci', '--no-audit', '--no-fund']);
for (const forbidden of ['apps/api', 'node_modules/fastify', 'node_modules/better-sqlite3', 'node_modules/argon2', 'node_modules/@simplewebauthn/server']) {
  assert.equal(fs.existsSync(path.join(directory, forbidden)), false, `Web isolation leak: ${forbidden}`);
}
run(['run', 'build', '-w', '@wangke/contracts']);
run(['run', 'build', '-w', '@wangke/study-core']);
run(['run', 'typecheck', '-w', '@wangke/web']);
run(['run', 'build', '-w', '@wangke/web']);
assert.ok(fs.existsSync(path.join(directory, 'apps/web/dist/index.html')));
assert.equal(fs.existsSync(path.join(directory, 'src')), false);
console.log(`Web source/dependency isolation/typecheck/build passed without API sources or server dependencies. Artifacts: ${directory}/apps/web/dist`);
