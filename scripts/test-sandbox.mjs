// Requires Docker daemon and a built wangke-sandbox:0.1.0 image.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
const image = process.env.SANDBOX_IMAGE || 'wangke-sandbox:0.1.0';
try {
  execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'pipe' });
  execFileSync('docker', ['image', 'inspect', image], { stdio: 'pipe' });
} catch (error) {
  console.error(`Sandbox integration needs a running Docker daemon and built ${image} image.\n${error.stderr?.toString().trim() || error.message}`);
  process.exit(1);
}
// Never stop a user's broker or assume the production port is free.
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port, baseUrl = `http://127.0.0.1:${port}`;
await new Promise(resolve => reservation.close(resolve));
const token = crypto.randomBytes(32).toString('hex');
const owner = crypto.randomUUID(), other = crypto.randomUUID();
const threadId = crypto.randomUUID();
const projectId = crypto.randomUUID(), secondProjectId = crypto.randomUUID();
const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-sandbox-')));
const projectsRoot = path.join(dataRoot, 'files', 'projects');
fs.mkdirSync(projectsRoot, { recursive: true });
const projectUid = process.platform === 'linux' ? process.getuid() || 1000 : 1000;
const projectGid = process.platform === 'linux' ? process.getgid() || 1000 : 1000;
fs.chmodSync(projectsRoot, 0o755);
const systemRootFor = who => path.join(path.dirname(projectsRoot), 'system-files', crypto.createHash('sha256').update(who).digest('hex'), 'system');
const systemRoot = systemRootFor(owner), systemSkillsRoot = path.join(systemRoot, 'skills');
for (const who of [owner, other]) {
  const system = systemRootFor(who);
  fs.mkdirSync(path.join(system, 'skills'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(system, 'memory'), { mode: 0o700 });
  fs.writeFileSync(path.join(system, 'AGENTS.md'), who === owner ? 'Owner instructions' : 'Other private instructions');
  fs.writeFileSync(path.join(system, 'memory', 'preferences.md'), 'Original note');
  fs.writeFileSync(path.join(system, 'mcp.json'), '{"version":1,"servers":[]}');
  const assign = filename => {
    if (process.platform === 'linux' && process.getuid() === 0) fs.chownSync(filename, projectUid, projectGid);
    if (fs.lstatSync(filename).isDirectory()) for (const name of fs.readdirSync(filename)) assign(path.join(filename, name));
  };
  assign(system);
}
for (const id of [projectId, secondProjectId]) {
  fs.mkdirSync(path.join(projectsRoot, id), { mode: 0o700 });
  if (process.platform === 'linux' && process.getuid() === 0) fs.chownSync(path.join(projectsRoot, id), projectUid, projectGid);
}
const broker = spawn(process.execPath, ['infra/sandbox/broker.mjs'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), SANDBOX_TOKEN: token, SANDBOX_IMAGE: image, SANDBOX_NETWORK: 'none', SANDBOX_PROJECTS_DIR: projectsRoot, SANDBOX_PROJECTS_HOST_DIR: projectsRoot, SANDBOX_UID: String(projectUid), SANDBOX_GID: String(projectGid) }, stdio: 'inherit',
});
const call = async (command, scope = {}) => {
  const r = await fetch(`${baseUrl}/execute`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ owner, threadId, executionId: crypto.randomUUID(), command, ...scope }),
  });
  assert.equal(r.status, 200); return r.json();
};
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (broker.exitCode !== null) throw new Error('Broker exited');
    try { ready = (await fetch(`${baseUrl}/health`)).ok; } catch {}
    if (ready) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready);
  assert.equal((await fetch(`${baseUrl}/execute`, { method: 'POST' })).status, 401);
  const systemRead = await call('cat /system/AGENTS.md /system/memory/preferences.md /system/mcp.json');
  assert.equal(systemRead.exitCode, 0, systemRead.stderr); assert.match(systemRead.stdout, /Owner instructions/);
  for (const filename of ['/system/AGENTS.md', '/system/memory/preferences.md', '/system/mcp.json', '/system/skills/readonly.txt']) {
    const denied = await call(`python3 -c ${JSON.stringify(`from pathlib import Path; Path('${filename}').write_text('Read-only')`)}`);
    assert.notEqual(denied.exitCode, 0, 'all system writes, including skills, require a writable step mount');
  }
  const systemWrite = await call("set -e; printf 'Writable instructions' > /system/AGENTS.md; printf 'Writable note' > /system/memory/preferences.md; printf '{\"version\":1,\"servers\":[]}' > /system/mcp.json; mkdir -p /system/custom/nested; printf 'Any system file' > /system/custom/nested/config.txt; test ! -e /var/run/docker.sock; ! touch /outside-workspace", { systemWrite: true });
  assert.equal(systemWrite.exitCode, 0, systemWrite.stderr);
  assert.equal(fs.readFileSync(path.join(systemRoot, 'AGENTS.md'), 'utf8'), 'Writable instructions');
  assert.equal(fs.readFileSync(path.join(systemRoot, 'memory', 'preferences.md'), 'utf8'), 'Writable note');
  assert.equal(fs.readFileSync(path.join(systemRoot, 'custom', 'nested', 'config.txt'), 'utf8'), 'Any system file');
  assert.notEqual((await call("printf 'Must not inherit' > /system/AGENTS.md")).exitCode, 0);
  assert.equal(fs.readFileSync(path.join(systemRoot, 'AGENTS.md'), 'utf8'), 'Writable instructions');
  const otherRead = await call('cat /system/AGENTS.md; test ! -e /system/custom', { owner: other });
  assert.equal(otherRead.exitCode, 0); assert.match(otherRead.stdout, /Other private instructions/); assert.doesNotMatch(otherRead.stdout, /Writable instructions/);
  assert.equal((await call("printf 'Other writable instructions' > /system/AGENTS.md", { owner: other, systemWrite: true })).exitCode, 0);
  assert.equal(fs.readFileSync(path.join(systemRoot, 'AGENTS.md'), 'utf8'), 'Writable instructions');
  // Direct broker requests represent the trusted API. Deletion approval is
  // tested at Bot dispatch, not enforced by the writable Docker mount itself.
  const systemDelete = await call('rm /system/custom/nested/config.txt && rmdir /system/custom/nested /system/custom', { systemWrite: true });
  assert.equal(systemDelete.exitCode, 0); assert.equal(fs.existsSync(path.join(systemRoot, 'custom')), false);
  const skillInstall = await call("mkdir -p /system/skills/demo && printf '%s\\n' '---' 'name: Demo' 'description: sandbox' '---' '' 'Installed' > /system/skills/demo/SKILL.md", { systemWrite: true });
  assert.equal(skillInstall.exitCode, 0, skillInstall.stderr);
  assert.match(fs.readFileSync(path.join(systemSkillsRoot, 'demo', 'SKILL.md'), 'utf8'), /Installed/);
  const zipInstall = await call("set -e; mkdir -p /tmp/zip-skill/references /system/skills/zip-demo; printf '%s\\n' '---' 'name: Zip Demo' 'description: sandbox zip' '---' '' 'Unpacked' > /tmp/zip-skill/SKILL.md; printf 'Reference' > /tmp/zip-skill/references/guide.md; (cd /tmp/zip-skill && zip -qr /tmp/zip-demo.zip .); unzip -q /tmp/zip-demo.zip -d /system/skills/zip-demo; test -f /system/skills/zip-demo/SKILL.md && test -f /system/skills/zip-demo/references/guide.md", { systemWrite: true });
  assert.equal(zipInstall.exitCode, 0, zipInstall.stderr);
  assert.match(fs.readFileSync(path.join(systemSkillsRoot, 'zip-demo', 'SKILL.md'), 'utf8'), /Unpacked/);
  assert.equal(fs.readFileSync(path.join(systemSkillsRoot, 'zip-demo', 'references', 'guide.md'), 'utf8'), 'Reference');
  const first = await call('printf persisted > /workspace/marker; id -u', { timeoutSeconds: 600 });
  assert.equal(first.exitCode, 0); assert.match(first.stdout, /1000/);
  const second = await call('set -e; cat marker; test ! -e /var/run/docker.sock; test ! -e /data/db/wangke.sqlite; test -z "$MODEL_API_KEY"; ! touch /outside-workspace');
  assert.equal(second.exitCode, 0); assert.match(second.stdout, /persisted/);
  const save = await call("printf 'artifact content' > /tmp/staged.txt && wangke-save /tmp/staged.txt '分析报告/计算结果.txt'");
  assert.equal(save.exitCode, 0, save.stderr); assert.equal(JSON.parse(save.stdout).reused, false);
  const saveRetry = await call("printf 'artifact content' > /tmp/staged.txt && wangke-save /tmp/staged.txt '分析报告/计算结果.txt'");
  assert.equal(saveRetry.exitCode, 0, saveRetry.stderr); assert.equal(JSON.parse(saveRetry.stdout).reused, true);
  const saveNew = await call("printf 'new artifact content' > /tmp/staged.txt && wangke-save /tmp/staged.txt '分析报告/计算结果.txt'");
  assert.equal(saveNew.exitCode, 0, saveNew.stderr); assert.equal(JSON.parse(saveNew.stdout).path, '分析报告/计算结果 (2).txt');
  const readFile = (filePath, scope = {}) => fetch(`${baseUrl}/files/read`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ threadId, executionId: crypto.randomUUID(), path: filePath, ...scope }) });
  assert.equal((await readFile('missing.pdf', { systemWrite: true })).status, 400);
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
  const cancel = await fetch(`${baseUrl}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ executionId }) });
  assert.equal(cancel.status, 200);
  await running;
  assert.equal(fs.existsSync(path.join(projectsRoot, projectId, 'must-not-exist')), false);
  assert.throws(() => execFileSync('docker', ['inspect', `wangke-exec-${executionId}`], { stdio: 'pipe' }));
  assert.equal((await call('cat shared.txt', { projectId })).exitCode, 0);
  const timedExecution = crypto.randomUUID();
  const timed = await call('sleep 5; touch must-not-complete', { projectId, executionId: timedExecution, timeoutSeconds: 1 });
  assert.notEqual(timed.exitCode, 0, 'command deadline kills the process');
  assert.equal(fs.existsSync(path.join(projectsRoot, projectId, 'must-not-complete')), false);
  assert.throws(() => execFileSync('docker', ['inspect', `wangke-exec-${timedExecution}`], { stdio: 'pipe' }));
  for (const timeoutSeconds of [0, 601, '600', null]) {
    const invalid = await fetch(`${baseUrl}/execute`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ owner, threadId, executionId: crypto.randomUUID(), command: 'true', timeoutSeconds }) });
    assert.equal(invalid.status, 400, 'broker independently rejects invalid deadlines');
  }
  for (const systemWrite of [null, 1, 'true']) {
    const invalid = await fetch(`${baseUrl}/execute`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ owner, threadId, executionId: crypto.randomUUID(), command: 'true', systemWrite }) });
    assert.equal(invalid.status, 400, 'broker independently validates the system-write flag');
  }
  console.log('Real sandbox: whole-system read-only/default and one-step writable mounts, arbitrary files/delete/Skills, owner isolation, legacy/project persistence, binary transfers, non-root and cancellation cleanup passed');
} finally {
  broker.kill('SIGTERM');
  await new Promise(resolve => { if (broker.exitCode !== null) resolve(); else broker.once('exit', resolve); });
  execFileSync('docker', ['volume', 'rm', `wangke-workspace-${threadId}`], { stdio: 'inherit' });
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
