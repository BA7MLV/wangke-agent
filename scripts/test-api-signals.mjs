import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const signal of ['SIGTERM', 'SIGINT']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/api-signal-'));
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'apps/api/src/server.ts')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', DATA_DIR: directory, DB_PATH: path.join(directory, 'db.sqlite'), FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), HOST: '127.0.0.1', PORT: '0', API_DRAIN_MS: '100', CLOUD_WORKER_DISABLED: '1' },
  });
  let output = '', errors = '', timer;
  child.stderr.on('data', data => { errors += data; });
  const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  try {
    const origin = await Promise.race([
      new Promise(resolve => child.stdout.on('data', data => {
        output += data;
        const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]);
      })),
      exited.then(result => { throw new Error(`early_exit:${JSON.stringify(result)}:${errors}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`signal_start_timeout:${errors}`)), 15000); }),
    ]);
    clearTimeout(timer);
    assert.equal((await fetch(`${origin}/api/v1/ready`)).status, 200);
    child.kill(signal);
    const result = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`signal_stop_timeout:${errors}`)), 10000); })]);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.match(output, /api_drained/);
    assert.match(output, /"finished":true/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
console.log('API process: SIGTERM/SIGINT run drain then close and exit cleanly');
