// Requires Docker daemon and a built wangke-sandbox:0.1.0 image.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
const token = crypto.randomBytes(32).toString('hex');
const threadId = crypto.randomUUID();
const broker = spawn(process.execPath, ['infra/sandbox/broker.mjs'], {
  env: { ...process.env, HOST: '127.0.0.1', SANDBOX_TOKEN: token, SANDBOX_NETWORK: 'none' }, stdio: 'inherit',
});
const call = async (command) => {
  const r = await fetch('http://127.0.0.1:3001/execute', { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, executionId: crypto.randomUUID(), command }),
  });
  assert.equal(r.status, 200); return r.json();
};
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (broker.exitCode !== null) throw new Error('Broker exited');
    try { ready = (await fetch('http://127.0.0.1:3001/health')).ok; } catch {}
    if (ready) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready);
  assert.equal((await fetch('http://127.0.0.1:3001/execute', { method: 'POST' })).status, 401);
  const first = await call('printf persisted > /workspace/marker; id -u');
  assert.equal(first.exitCode, 0); assert.match(first.stdout, /1000/);
  const second = await call('set -e; cat marker; test ! -e /var/run/docker.sock; test ! -e /data/db/wangke.sqlite; test -z "$MODEL_API_KEY"; ! touch /outside-workspace');
  assert.equal(second.exitCode, 0); assert.match(second.stdout, /persisted/);
  console.log('Real sandbox: command execution, persistence, non-root and mount isolation passed');
} finally {
  broker.kill('SIGTERM');
  await new Promise(resolve => { if (broker.exitCode !== null) resolve(); else broker.once('exit', resolve); });
  execFileSync('docker', ['volume', 'rm', `wangke-workspace-${threadId}`], { stdio: 'inherit' });
}
