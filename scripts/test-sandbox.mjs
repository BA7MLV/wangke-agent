// Requires Docker daemon and a built wangke-sandbox:0.1.0 image.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const token = crypto.randomBytes(32).toString('hex');
const threadId = crypto.randomUUID();
const projectId = crypto.randomUUID(), secondProjectId = crypto.randomUUID();
const projectsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-sandbox-projects-')));
const projectUid = process.platform === 'linux' ? process.getuid() || 1000 : 1000;
const projectGid = process.platform === 'linux' ? process.getgid() || 1000 : 1000;
fs.chmodSync(projectsRoot, 0o755);
for (const id of [projectId, secondProjectId]) {
  fs.mkdirSync(path.join(projectsRoot, id), { mode: 0o700 });
  if (process.platform === 'linux' && process.getuid() === 0) fs.chownSync(path.join(projectsRoot, id), projectUid, projectGid);
}
const broker = spawn(process.execPath, ['infra/sandbox/broker.mjs'], {
  env: { ...process.env, HOST: '127.0.0.1', SANDBOX_TOKEN: token, SANDBOX_NETWORK: 'none', SANDBOX_PROJECTS_DIR: projectsRoot, SANDBOX_PROJECTS_HOST_DIR: projectsRoot, SANDBOX_UID: String(projectUid), SANDBOX_GID: String(projectGid) }, stdio: 'inherit',
});
const call = async (command, scope = {}) => {
  const r = await fetch('http://127.0.0.1:3001/execute', { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, executionId: crypto.randomUUID(), command, ...scope }),
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
  const readFile = (filePath, scope = {}) => fetch('http://127.0.0.1:3001/files/read', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ threadId, executionId: crypto.randomUUID(), path: filePath, ...scope }) });
  assert.equal((await readFile('../etc/passwd')).status, 400);
  assert.equal((await readFile('/etc/passwd')).status, 400);
  assert.equal((await readFile('missing.pdf')).status, 404);
  await call('python3 -c "from pathlib import Path; Path(\'result.zip\').write_bytes(bytes(range(256))*4096)"; ln -s /etc/passwd bad-link; mkfifo pipe');
  const binary = await readFile('/workspace/result.zip');
  assert.equal(binary.status, 200);
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), Buffer.from(Array.from({ length: 1024 * 1024 }, (_, i) => i % 256)));
  assert.equal((await readFile('bad-link')).status, 400);
  assert.equal((await readFile('pipe')).status, 400);
  const projectWrite = await call('printf project-persisted > shared.txt; id -u', { projectId });
  assert.equal(projectWrite.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(projectsRoot, projectId, 'shared.txt'), 'utf8'), 'project-persisted');
  const sharedFile = await readFile('shared.txt', { projectId, threadId: crypto.randomUUID() });
  assert.equal(sharedFile.status, 200); assert.equal(await sharedFile.text(), 'project-persisted');
  assert.equal((await readFile('shared.txt', { projectId: secondProjectId })).status, 404);
  const sibling = await call('cat shared.txt; test ! -e /data; test ! -e /var/run/docker.sock', { projectId, threadId: crypto.randomUUID() });
  assert.equal(sibling.exitCode, 0); assert.match(sibling.stdout, /project-persisted/);
  const isolated = await call('test ! -e shared.txt', { projectId: secondProjectId });
  assert.equal(isolated.exitCode, 0);
  const executionId = crypto.randomUUID();
  const running = call('touch started; sleep 60; touch must-not-exist', { projectId, executionId });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(projectsRoot, projectId, 'started')); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(fs.existsSync(path.join(projectsRoot, projectId, 'started')));
  const cancel = await fetch('http://127.0.0.1:3001/cancel', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ executionId }) });
  assert.equal(cancel.status, 200);
  await running;
  assert.equal(fs.existsSync(path.join(projectsRoot, projectId, 'must-not-exist')), false);
  assert.throws(() => execFileSync('docker', ['inspect', `wangke-exec-${executionId}`], { stdio: 'pipe' }));
  assert.equal((await call('cat shared.txt', { projectId })).exitCode, 0);
  console.log('Real sandbox: legacy persistence, shared project mount, project isolation, non-root, cancellation cleanup passed');
} finally {
  broker.kill('SIGTERM');
  await new Promise(resolve => { if (broker.exitCode !== null) resolve(); else broker.once('exit', resolve); });
  execFileSync('docker', ['volume', 'rm', `wangke-workspace-${threadId}`], { stdio: 'inherit' });
  fs.rmSync(projectsRoot, { recursive: true, force: true });
}
