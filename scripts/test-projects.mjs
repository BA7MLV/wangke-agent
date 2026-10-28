import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { sandboxArgs } from '../infra/sandbox/arguments.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-projects-'));
process.env.DATA_DIR = directory;
process.env.BOOTSTRAP_SECRET_FILE = path.join(directory, 'config/bootstrap-secret');
process.env.NODE_ENV = 'test';
process.env.MODEL_API_KEY = 'project-test-only';
process.env.MODEL_NAME = 'test';
process.env.BOT_CONCURRENCY = '3';
process.env.CLOUD_BROWSER_DISABLED = '1';
const { buildServer } = await import('../apps/api/src/server.ts');

function response(name, args) {
  return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'model-id', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
}
const modelRequests = [];
const sandboxRequests = [];
const activeProjects = new Set();
let peakProjects = 0;
let otherProject;
const fetcher = async (_url, init) => {
  const body = JSON.parse(init.body);
  modelRequests.push(body);
  const user = body.messages.filter(m => m.role === 'user' && !m.content.startsWith('Approval')).at(-1)?.content;
  const afterTool = body.messages.some(m => m.role === 'tool');
  const toolNames = body.tools.map(t => t.function.name);
  if (body.messages[0].content.includes('Current project:')) {
    assert.ok(toolNames.includes('workspace'));
    assert.ok(!toolNames.includes('projects'));
    assert.ok(!toolNames.some(name => name.startsWith('mcp_')));
  }
  if (!afterTool) {
    if (user === 'write-note') return response('workspace', { action: 'write', path: 'bot-note.md', text: 'persistent bot result', expectedRevision: null });
    if (user === 'write-revoked') return response('workspace', { action: 'write', path: 'revoked.md', text: 'must not exist', expectedRevision: null });
    if (user === 'read-note') return response('workspace', { action: 'read', path: 'bot-note.md' });
    if (user === 'read-only-write') return response('workspace', { action: 'write', path: 'forbidden.md', text: 'forbidden', expectedRevision: null });
    if (user === 'cross-project') return response('projects', { action: 'rename', projectId: otherProject, name: 'forbidden' });
    if (user === 'forge-scope') return response('workspace', { action: 'read', projectId: otherProject, path: 'secret.txt' });
    if (user === 'shell') return response('shell', { command: 'pwd' });
    if (user === 'manage-project') return response('projects', { action: 'rename', projectId: otherProject, name: 'Managed name' });
  }
  const result = body.messages.filter(m => m.role === 'tool').at(-1)?.content;
  return response('send_message', { kind: 'text', text: result || 'done' });
};
const sandbox = async (request, signal) => {
  assert.ok(request.projectId);
  assert.equal(request.network, false, 'project network policy narrows global allow');
  assert.ok(!activeProjects.has(request.projectId), 'same-project sessions must never run concurrently');
  activeProjects.add(request.projectId);
  peakProjects = Math.max(peakProjects, activeProjects.size);
  sandboxRequests.push(request);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 70);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
    });
    return { stdout: '/workspace', stderr: '', exitCode: 0 };
  } finally { activeProjects.delete(request.projectId); }
};
let cleanupAvailable = true;
const cleanups = [];
const options = { dbPath: path.join(directory, 'db/app.sqlite'), fetch: fetcher, sandbox,
  sandboxCleanup: async executionId => { if (!cleanupAvailable) throw new Error('broker offline'); cleanups.push(executionId); },
};
let app;
let db;
let cookie = '';
const call = async (method, url, payload, expected = 200, headers = {}) => {
  const result = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie, ...headers }, ...(payload !== undefined ? { payload } : {}) });
  assert.equal(result.statusCode, expected, `${method} ${url}: ${result.body}`);
  return result;
};
const json = async (...args) => (await call(...args)).json();
const fileUrl = (id, action, filename) => `/projects/${id}/${action}?path=${encodeURIComponent(filename)}`;
const until = async fn => {
  for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for project run');
};
const send = async (threadId, content) => {
  const message = await json('POST', `/threads/${threadId}/messages`, { clientNonce: crypto.randomUUID(), content }, 201);
  return db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(message.id).id;
};
const state = id => db.prepare('SELECT * FROM runs WHERE id=?').get(id);
const finish = id => until(() => ['completed', 'failed', 'cancelled'].includes(state(id).status));

try {
  // Upgrade a populated v13 database, including its original Bot association.
  const legacyPath = path.join(directory, 'legacy.sqlite');
  const legacy = new Database(legacyPath);
  legacy.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
  const source = fs.readFileSync(new URL('../apps/api/src/storage/database.ts', import.meta.url), 'utf8');
  for (const match of source.matchAll(/\[(\d+),\s*`([\s\S]*?)`\]/g)) {
    if (Number(match[1]) > 13) continue;
    legacy.exec(match[2]);
    legacy.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(Number(match[1]), 'legacy');
  }
  const legacyOwner = crypto.randomUUID(), legacyThread = crypto.randomUUID(), legacyAgent = crypto.randomUUID();
  legacy.prepare('INSERT INTO users VALUES(?,?,?)').run(legacyOwner, 'legacy', 'legacy');
  legacy.prepare('INSERT INTO threads(id,owner_id,mode,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(legacyThread, legacyOwner, 'bot', 'Keep history', 'legacy', 'legacy');
  legacy.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(legacyAgent, legacyOwner, 'Original bot', 'assistant', '', 'legacy', 'legacy');
  legacy.prepare('INSERT INTO thread_participants VALUES(?,?,?)').run(legacyThread, legacyAgent, 'legacy');
  legacy.close();
  const migrated = new DatabaseStore(legacyPath);
  assert.deepEqual(migrated.db.prepare('SELECT title,agent_id,project_id,archived FROM threads WHERE id=?').get(legacyThread), { title: 'Keep history', agent_id: legacyAgent, project_id: null, archived: 0 });
  migrated.close();
  const reopened = new DatabaseStore(legacyPath); reopened.close();

  app = buildServer(options);
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  await json('POST', '/bootstrap/initialize', { adminPassword: 'project-test-password' }, 201, { 'x-bootstrap-secret': secret });
  const login = await call('POST', '/auth/password/login', { password: 'project-test-password' });
  cookie = login.headers['set-cookie'].split(';')[0];
  db = new Database(options.dbPath);
  const { agents } = await json('GET', '/agents');
  const agentId = agents[0].id;
  const secondAgent = await json('POST', '/agents', { name: 'Second bot' }, 201);
  const first = await json('POST', '/projects', { name: '课程 A', agentId }, 201);
  const second = await json('POST', '/projects', { name: '课程 B', agentId }, 201);
  otherProject = second.id;
  const workspace = path.join(directory, 'files', first.workspacePath);
  assert.ok(fs.statSync(workspace).isDirectory());
  assert.equal(first.workspacePath, `projects/${first.id}`);
  await json('POST', '/projects', { name: 'bad', agentId: 'missing' }, 404);
  await json('POST', '/projects', { name: '', agentId }, 400);
  await json('POST', '/projects', { name: 'csrf', agentId }, 403, { origin: 'https://evil.example' });

  const renamed = await json('PATCH', `/projects/${first.id}`, { name: '重命名 A' });
  assert.equal(renamed.id, first.id); assert.equal(renamed.workspacePath, first.workspacePath);
  await json('PATCH', `/projects/${first.id}`, { id: crypto.randomUUID(), workspacePath: '/tmp' }, 400);
  await json('POST', fileUrl(first.id, 'directories', 'notes'), undefined, 201);
  await json('PUT', fileUrl(first.id, 'text', 'notes/test.md'), { text: 'initial', expectedRevision: null });
  const text = await json('GET', fileUrl(first.id, 'text', 'notes/test.md'));
  await json('PUT', fileUrl(first.id, 'text', 'notes/test.md'), { text: 'updated', expectedRevision: text.revision });
  await json('PUT', fileUrl(first.id, 'text', 'notes/test.md'), { text: 'stale', expectedRevision: text.revision }, 409);
  assert.equal((await call('GET', fileUrl(first.id, 'download', 'notes/test.md'))).body, 'updated');
  await json('POST', fileUrl(first.id, 'uploads', 'upload.txt'), Buffer.from('uploaded'), 201, { 'content-type': 'application/octet-stream' });
  await json('POST', fileUrl(first.id, 'uploads', 'upload.txt'), Buffer.from('overwrite'), 409, { 'content-type': 'application/octet-stream' });
  assert.equal(fs.readFileSync(path.join(workspace, 'upload.txt'), 'utf8'), 'uploaded');
  await json('GET', fileUrl(second.id, 'text', 'notes/test.md'), undefined, 404);
  for (const filename of ['../secret', '/etc/passwd', `../${second.id}/secret`, 'notes/../../secret', 'notes\\escape', 'notes//bad']) {
    await json('GET', fileUrl(first.id, 'text', filename), undefined, 400);
    await json('PUT', fileUrl(first.id, 'text', filename), { text: 'escape', expectedRevision: null }, 400);
  }
  const outside = path.join(directory, 'outside.txt'); fs.writeFileSync(outside, 'private');
  fs.symlinkSync(outside, path.join(workspace, 'link.txt'));
  fs.symlinkSync(directory, path.join(workspace, 'linked-dir'));
  fs.linkSync(outside, path.join(workspace, 'hardlink.txt'));
  for (const filename of ['link.txt', 'linked-dir/outside.txt', 'hardlink.txt']) await json('GET', fileUrl(first.id, 'text', filename), undefined, 403);
  await json('PUT', fileUrl(first.id, 'text', 'linked-dir/escape'), { text: 'escape', expectedRevision: null }, 403);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'private');
  const listing = (await json('GET', fileUrl(first.id, 'files', ''))).files;
  assert.ok(!listing.some(f => f.name.includes('link')));

  // Ownership is enforced independently of knowing another project's UUID.
  const otherOwner = crypto.randomUUID(), token = crypto.randomUUID();
  db.prepare('INSERT INTO users VALUES(?,?,?)').run(otherOwner, 'Other owner', new Date().toISOString());
  db.prepare('INSERT INTO api_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), otherOwner, crypto.createHash('sha256').update(token).digest('hex'), 'test', '2026', '2999');
  const otherHeaders = { cookie: '', authorization: `Bearer ${token}` };
  assert.equal((await json('GET', '/projects', undefined, 200, otherHeaders)).projects.length, 0);
  await json('GET', `/projects/${first.id}`, undefined, 404, otherHeaders);
  await json('GET', fileUrl(first.id, 'download', 'upload.txt'), undefined, 404, otherHeaders);
  await json('POST', '/threads', { mode: 'bot', projectId: first.id }, 404, otherHeaders);
  const otherAgents = (await json('GET', '/agents', undefined, 200, otherHeaders)).agents;
  await json('PUT', `/projects/${first.id}/agents/${otherAgents[0].id}`, { role: 'write' }, 404);

  const thread = await json('POST', '/threads', { mode: 'bot', projectId: first.id, agentId, title: 'Project session 1' }, 201);
  const sibling = await json('POST', '/threads', { mode: 'bot', projectId: first.id, agentId, title: 'Project session 2' }, 201);
  const otherThread = await json('POST', '/threads', { mode: 'bot', projectId: second.id, agentId }, 201);
  await json('POST', '/threads', { mode: 'bot', projectId: first.id, agentId: secondAgent.id }, 403);
  await json('POST', '/threads', { mode: 'chat', projectId: first.id }, 400);
  await json('PATCH', `/threads/${thread.id}`, { projectId: second.id }, 400);
  await json('POST', `/threads/${thread.id}/participants`, { agentId: secondAgent.id }, 409);
  assert.deepEqual((await json('GET', `/threads?projectId=${first.id}`)).threads.map(t => t.id).sort(), [thread.id, sibling.id].sort());
  assert.deepEqual((await json('POST', '/cloud/mcp/catalog', { threadId: thread.id })).tools, []);
  await json('PUT', '/cloud/mcp/scope', { threadId: thread.id, serverIds: null }, 400);
  await json('POST', `/threads/${thread.id}/messages`, { clientNonce: 'cross-attachment', kind: 'attachment', content: JSON.stringify({ projectId: second.id, projectPath: 'secret.txt' }) }, 400);

  // Exact persisted approval, file visibility from another session, no history mixing.
  const run = await send(thread.id, 'write-note');
  await until(() => state(run).status === 'waiting_user');
  assert.equal(fs.existsSync(path.join(workspace, 'bot-note.md')), false);
  const approval = db.prepare('SELECT id FROM approvals WHERE run_id=?').get(run);
  await json('POST', `/approvals/${approval.id}/resolve`, { approved: true });
  await finish(run); assert.equal(state(run).status, 'completed');
  assert.equal(fs.readFileSync(path.join(workspace, 'bot-note.md'), 'utf8'), 'persistent bot result');
  const readRun = await send(sibling.id, 'read-note'); await finish(readRun);
  const siblingMessages = (await json('GET', `/threads/${sibling.id}`)).messages;
  assert.ok(siblingMessages.at(-1).content.includes('persistent bot result'));
  assert.ok(!siblingMessages.some(m => m.content === 'write-note'));
  const projectAttachment = await json('POST', `/threads/${sibling.id}/messages`, { clientNonce: crypto.randomUUID(), kind: 'attachment', content: JSON.stringify({ projectId: first.id, projectPath: 'bot-note.md' }) }, 201);
  await finish(db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(projectAttachment.id).id);
  for (const command of ['cross-project', 'forge-scope']) {
    const id = await send(sibling.id, command); await finish(id);
    assert.match(db.prepare("SELECT result FROM run_steps WHERE run_id=? AND tool!='send_message'").get(id).result, /denied|invalid_project_tool_arguments/);
  }
  assert.equal((await json('GET', `/projects/${second.id}`)).name, '课程 B');

  const revokedRun = await send(thread.id, 'write-revoked');
  await until(() => state(revokedRun).status === 'waiting_user');
  const revokedApproval = db.prepare('SELECT id FROM approvals WHERE run_id=?').get(revokedRun);
  await json('PUT', `/projects/${first.id}/agents/${agentId}`, { role: null });
  await json('POST', `/approvals/${revokedApproval.id}/resolve`, { approved: true });
  assert.equal(state(revokedRun).status, 'cancelled');
  assert.equal(fs.existsSync(path.join(workspace, 'revoked.md')), false);
  await json('POST', '/runs', { threadId: thread.id }, 403);
  await json('PUT', `/projects/${first.id}/agents/${agentId}`, { role: 'read' });
  const readonlyRun = await send(thread.id, 'read-only-write'); await finish(readonlyRun);
  assert.equal(fs.existsSync(path.join(workspace, 'forbidden.md')), false);
  assert.match(db.prepare("SELECT result FROM run_steps WHERE run_id=? AND tool='workspace'").get(readonlyRun).result, /project_access_denied/);

  // Cross-project management is a separate grant and never leaks into a project session.
  const config = await json('GET', '/cloud/config');
  await json('PUT', '/cloud/config', { ...config, policy: { ...config.policy, write: 'allow', shell: 'allow', network: 'allow' } });
  const botThread = await json('POST', '/threads', { mode: 'bot', agentId }, 201);
  const deniedManage = await send(botThread.id, 'manage-project'); await finish(deniedManage);
  assert.equal((await json('GET', `/projects/${second.id}`)).name, '课程 B');
  await json('PUT', `/projects/${second.id}/agents/${agentId}`, { role: 'manage' });
  const manage = await send(botThread.id, 'manage-project'); await finish(manage);
  assert.equal((await json('GET', `/projects/${second.id}`)).name, 'Managed name');

  // Same-project serialization, independent project concurrency, scoped mount identity.
  await json('PUT', `/projects/${first.id}/agents/${agentId}`, { role: 'write' });
  for (const project of [first, second]) await json('PATCH', `/projects/${project.id}`, { policy: { shell: 'allow', network: 'deny' } });
  const runs = await Promise.all([thread, sibling, otherThread].map(t => send(t.id, 'shell')));
  await Promise.all(runs.map(finish));
  assert.equal(sandboxRequests.length, 3);
  assert.equal(peakProjects, 2);
  assert.equal(sandboxRequests.filter(r => r.projectId === first.id).length, 2);
  for (const r of sandboxRequests) {
    const args = sandboxArgs(r, '/host/data/files/projects');
    assert.ok(args.includes(`type=bind,source=/host/data/files/projects/${r.projectId},target=/workspace`));
    assert.equal(args[args.indexOf('--network') + 1], 'none');
    assert.ok(!args.some(arg => arg.includes('docker.sock')));
  }
  assert.throws(() => sandboxArgs({ ...sandboxRequests[0], projectId: '../other' }, '/host/data/files/projects'));
  const oldArgs = sandboxArgs({ threadId: thread.id, executionId: crypto.randomUUID(), command: 'pwd' });
  assert.ok(oldArgs.includes(`type=volume,source=wangke-workspace-${thread.id},target=/workspace`));

  await json('PATCH', `/threads/${thread.id}`, { title: 'Session renamed', archived: true });
  await json('POST', '/runs', { threadId: thread.id }, 409);
  await json('POST', `/threads/${thread.id}/messages`, { clientNonce: 'archived', content: 'blocked' }, 409);
  await json('PATCH', `/threads/${thread.id}`, { archived: false });
  await until(() => !activeProjects.size);
  const usageBeforeDelete = db.prepare('SELECT id,reserved_tokens FROM bot_requests WHERE run_id IN (SELECT id FROM runs WHERE thread_id=?) ORDER BY id').all(thread.id);
  assert.ok(usageBeforeDelete.length);
  await json('DELETE', `/threads/${thread.id}`);
  for (const usage of usageBeforeDelete) assert.deepEqual(db.prepare('SELECT id,reserved_tokens,run_id,step_id FROM bot_requests WHERE id=?').get(usage.id), { ...usage, run_id: null, step_id: null }, 'conversation deletion preserves owner usage accounting');
  assert.ok(fs.existsSync(path.join(workspace, 'bot-note.md')));
  await json('PATCH', `/projects/${first.id}`, { archived: true });
  await json('POST', '/threads', { mode: 'bot', projectId: first.id, agentId }, 409);
  await json('PUT', fileUrl(first.id, 'text', 'archived.md'), { text: 'no', expectedRevision: null }, 409);
  await json('GET', fileUrl(first.id, 'text', 'bot-note.md'));
  await json('PATCH', `/projects/${first.id}`, { archived: false });

  // A process crash while Docker is still exiting must retain the workspace lock.
  const orphan = crypto.randomUUID();
  await app.close();
  db.prepare('INSERT INTO project_executions(project_id,execution_id) VALUES(?,?)').run(first.id, orphan);
  db.close(); db = null; cleanupAvailable = false;
  app = buildServer(options);
  assert.equal((await json('GET', `/projects/${first.id}`)).workspacePath, first.workspacePath);
  await json('PUT', fileUrl(first.id, 'text', 'locked.md'), { text: 'must wait', expectedRevision: null }, 409);
  cleanupAvailable = true;
  await until(() => cleanups.includes(orphan));
  assert.equal((await json('GET', fileUrl(first.id, 'text', 'bot-note.md'))).text, 'persistent bot result');
  await json('PUT', fileUrl(first.id, 'text', 'recovered.md'), { text: 'unlocked', expectedRevision: null });
  // Deployments without Docker must retain usable project files after a shell failure.
  await app.close();
  delete process.env.SANDBOX_URL; delete process.env.SANDBOX_TOKEN;
  app = buildServer({ ...options, sandbox: undefined, sandboxCleanup: undefined });
  db = new Database(options.dbPath);
  const unavailable = await send(sibling.id, 'shell'); await finish(unavailable);
  assert.equal(state(unavailable).error_code, 'sandbox_unavailable');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM project_executions').get().count, 0);
  await json('PUT', fileUrl(first.id, 'text', 'without-docker.md'), { text: 'still usable', expectedRevision: null });
  console.log('Projects: v13 migration/restart, immutable ID/path, files/conflicts, owner and path isolation, scoped conversations, approvals/revocation, BOT grants, project serialization, orphan execution recovery, mount arguments passed');
} finally {
  await app?.close(); db?.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
