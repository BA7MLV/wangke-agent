import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { sandboxArgs } from '../infra/sandbox/arguments.mjs';
import { workspacePath, workspaceFileReader, workspaceFileLimit } from '../infra/sandbox/file-read.mjs';
import { readSandboxFile } from '../apps/api/src/agent/sandbox.ts';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-workspace-files-'));
const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
const files = path.join(root, 'files'); fs.mkdirSync(files);
const bytes = Buffer.from(Array.from({ length: 512 * 1024 }, (_, i) => i % 256));
fs.writeFileSync(path.join(workspace, 'result.zip'), bytes);
const store = new DatabaseStore(path.join(root, 'db.sqlite'));
const config = new CloudConfiguration(store, path.join(root, 'config'));
const study = new StudyTools(store, config, files);
const owner = crypto.randomUUID(), other = crypto.randomUUID(), at = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, at);
const originalEnv = { url: process.env.SANDBOX_URL, token: process.env.SANDBOX_TOKEN };
let runner, server;
const until = async fn => { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('workspace_file_test_timeout'); };
try {
  for (const invalid of ['../result.zip', '/etc/passwd', '/workspace/../result.zip', 'a//b', 'a/./b', 'a\\b', 'a\0b', '']) assert.throws(() => workspacePath(invalid));
  assert.equal(workspacePath('/workspace/result.zip'), 'result.zip');
  const args = sandboxArgs({ threadId: crypto.randomUUID(), executionId: crypto.randomUUID(), filePath: 'result.zip', network: true });
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.match(args[args.indexOf('--mount') + 1], /,readonly$/);
  assert.ok(args.includes('-I')); assert.ok(!args.includes('bash'));

  // Exercise the production fixed reader against a temporary root without Docker.
  const read = value => spawnSync('python3', ['-I', '-c', workspaceFileReader.replace("'/workspace'", JSON.stringify(workspace)), workspacePath(value)], { cwd: workspace, maxBuffer: workspaceFileLimit + 1024 });
  assert.deepEqual(read('result.zip').stdout, bytes);
  fs.writeFileSync(path.join(root, 'outside'), 'private');
  fs.symlinkSync(path.join(root, 'outside'), path.join(workspace, 'link'));
  fs.symlinkSync(root, path.join(workspace, 'directory-link'));
  fs.linkSync(path.join(root, 'outside'), path.join(workspace, 'hardlink'));
  fs.mkdirSync(path.join(workspace, 'directory'));
  fs.writeFileSync(path.join(workspace, 'empty'), '');
  fs.writeFileSync(path.join(workspace, 'large'), ''); fs.truncateSync(path.join(workspace, 'large'), workspaceFileLimit + 1);
  assert.equal(read('missing').status, 2);
  for (const value of ['link', 'directory-link/outside', 'hardlink', 'directory']) { const result = read(value); assert.equal(result.status, 3); assert.equal(result.stdout.length, 0); }
  for (const value of ['empty', 'large']) assert.equal(read(value).status, 4);

  server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/files/read'); assert.equal(req.headers.authorization, 'Bearer test-token');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (body.path === 'missing') { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.SANDBOX_URL = `http://127.0.0.1:${server.address().port}`; process.env.SANDBOX_TOKEN = 'test-token';
  const request = { threadId: crypto.randomUUID(), executionId: crypto.randomUUID(), path: 'result.zip' };
  assert.deepEqual(Buffer.from(await readSandboxFile(request, new AbortController().signal)), bytes);
  await assert.rejects(() => readSandboxFile({ ...request, path: 'missing' }, new AbortController().signal), /workspace_file_not_found/);

  config.save(owner, { ...config.get(owner), providers: [{ id: 'mock', name: 'mock', baseUrl: 'https://model.invalid', protocol: 'openai-chat', apiKey: 'test', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'mock', model: 'mock' }, policy: { ...config.get(owner).policy, read: 'allow', write: 'allow' } });
  const tool = (name, args) => Response.json({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }] });
  const service = new BotApplicationService(store, { enqueue() {}, cancel() {} });
  const thread = service.create(owner, 'bot', 'binary result');
  const message = service.send(owner, thread.id, { clientNonce: crypto.randomUUID(), content: '生成并发送压缩包' });
  const run = store.db.prepare('SELECT * FROM runs WHERE trigger_message_id=?').get(message.id);
  let reads = 0, calls = 0, fileId;
  const replies = () => store.db.prepare("SELECT kind,content FROM messages WHERE thread_id=? AND role='assistant'").all(thread.id);
  runner = new BotRunner(store, { configuration: config, study, sandboxFile: async request => {
    reads++; assert.equal(request.threadId, thread.id); assert.equal(request.projectId, undefined); assert.equal(request.path, 'result.zip'); return bytes;
  }, fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    switch (++calls) {
      case 1:
        assert.ok(body.tools.some(t => t.function.name === 'study_upload_file'));
        return tool('study_upload_file', { path: '/workspace/result.zip' });
      case 2: {
        assert.deepEqual(replies(), [], 'registration sends no chat message');
        const result = JSON.parse(body.messages.at(-1).content);
        fileId = result.fileId;
        assert.equal(result.sizeBytes, bytes.length); assert.equal(result.mimeType, 'application/zip');
        assert.deepEqual(Buffer.from((await study.file(owner, fileId)).bytes), bytes);
        return tool('study_send_file', { fileId, caption: '生成的压缩包' });
      }
      case 3: return tool('finish_turn', {});
      default: throw new Error('unexpected_model_call');
    }
  } });
  runner.start(); await until(() => ['completed', 'failed', 'paused'].includes(store.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id).status)); await runner.close();
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id).status, 'completed');
  assert.equal(reads, 1); assert.equal(replies().length, 1); assert.equal(JSON.parse(replies()[0].content).fileId, fileId);
  await assert.rejects(() => study.file(other, fileId), /file_not_found/);

  const step = store.db.prepare("SELECT id FROM run_steps WHERE run_id=? AND tool='study_upload_file'").get(run.id).id;
  const context = { owner, thread: thread.id, run: run.id, step, signal: new AbortController().signal, checkActive() {}, append() { throw new Error('must_not_send'); }, readWorkspaceFile: async () => { throw new Error('must_not_reread'); } };
  assert.equal((await study.plugins.get('study_upload_file').execute({ path: 'result.zip' }, context)).fileId, fileId, 'retry returns committed registration');
  await study.plugins.get('study_export').execute({ name: 'draft.md', content: '# Draft', send: false }, { ...context, step: crypto.randomUUID() });
  for (const denied of ['read', 'write']) {
    config.save(owner, { ...config.get(owner, true), policy: { ...config.get(owner).policy, read: 'allow', write: 'allow', [denied]: 'deny' } });
    const target = service.create(owner, 'bot', `deny ${denied}`);
    const message = service.send(owner, target.id, { clientNonce: crypto.randomUUID(), content: 'send file' });
    let calls = 0;
    runner = new BotRunner(store, { configuration: config, study, sandboxFile: async () => { throw new Error('must_not_read'); }, fetch: async () => ++calls === 1 ? tool('study_upload_file', { path: 'result.zip' }) : Response.json({ choices: [{ message: { content: '当前权限不允许读取或登记文件。' } }] }) });
    runner.start(); await until(() => store.db.prepare('SELECT status FROM runs WHERE trigger_message_id=?').get(message.id).status === 'completed'); await runner.close();
    const result = store.db.prepare("SELECT s.result FROM run_steps s JOIN runs r ON r.id=s.run_id WHERE r.trigger_message_id=? AND s.tool='study_upload_file'").get(message.id).result;
    assert.match(result, /Denied/);
  }
  const agent = crypto.randomUUID();
  store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(agent, owner, 'Bot', 'assistant', '', at, at);
  const projects = new ProjectRepository(store, path.join(root, 'projects'));
  const project = projects.create(owner, 'File project', agent);
  const projectRun = () => {
    const thread = { id: crypto.randomUUID() };
    store.db.prepare("INSERT INTO threads(id,owner_id,project_id,agent_id,mode,title,created_at,updated_at) VALUES(?,?,?,?,'bot','project file',?,?)").run(thread.id, owner, project.id, agent, at, at);
    // Create the trigger through the service with project authorization enabled.
    const scoped = new BotApplicationService(store, { enqueue() {}, cancel() {} }, projects);
    const message = scoped.send(owner, thread.id, { clientNonce: crypto.randomUUID(), content: 'register project result' });
    return store.db.prepare('SELECT * FROM runs WHERE trigger_message_id=?').get(message.id);
  };
  const status = id => store.db.prepare('SELECT status FROM runs WHERE id=?').get(id).status;
  config.save(owner, { ...config.get(owner, true), policy: { ...config.get(owner).policy, read: 'ask', write: 'ask' } });
  const approvedRun = projectRun(); let approvalCalls = 0, approvedReads = 0;
  const approvedOptions = { configuration: config, projects, study, sandboxCleanup: async () => {}, sandboxFile: async request => {
    approvedReads++; assert.equal(request.projectId, project.id); assert.equal(request.threadId, approvedRun.thread_id); assert.ok(projects.hasExecution(project.id)); return bytes;
  }, fetch: async () => ++approvalCalls === 1 ? tool('study_upload_file', { path: 'result.zip' }) : Response.json({ choices: [{ message: { content: '文件已登记。' } }] }) };
  runner = new BotRunner(store, approvedOptions); runner.start(); await until(() => status(approvedRun.id) === 'waiting_user'); await runner.close();
  assert.equal(approvedReads, 0);
  const approval = store.db.prepare("SELECT id FROM approvals WHERE run_id=? AND status='pending'").get(approvedRun.id);
  service.resolve(owner, approval.id, true, '同意', approvedRun.thread_id);
  runner = new BotRunner(store, approvedOptions); runner.start(); await until(() => status(approvedRun.id) === 'completed'); await runner.close();
  assert.equal(approvedReads, 1, 'approved registration executes once after restart'); assert.equal(projects.hasExecution(project.id), false);

  for (const action of ['cancel', 'deny', 'revoke']) {
    config.save(owner, { ...config.get(owner, true), policy: { ...config.get(owner).policy, read: 'allow', write: 'allow' } });
    projects.grant(owner, project.id, agent, 'write');
    const pendingRun = projectRun(); let release, requests = 0;
    const count = store.db.prepare('SELECT COUNT(*) n FROM files').get().n;
    runner = new BotRunner(store, { configuration: config, projects, study, sandboxCleanup: async () => {}, sandboxFile: async () => {
      assert.ok(projects.hasExecution(project.id));
      return await new Promise(resolve => { release = () => resolve(bytes); });
    }, fetch: async () => ++requests === 1 ? tool('study_upload_file', { path: 'result.zip' }) : Response.json({ choices: [{ message: { content: '操作已停止。' } }] }) });
    runner.start(); await until(() => Boolean(release));
    if (action === 'cancel') new BotApplicationService(store, runner, projects).stop(owner, pendingRun.thread_id);
    else if (action === 'deny') config.save(owner, { ...config.get(owner, true), policy: { ...config.get(owner).policy, read: 'deny' } });
    else projects.grant(owner, project.id, agent, null);
    release();
    await until(() => !projects.hasExecution(project.id));
    await until(() => ['cancelled', 'completed', 'failed'].includes(status(pendingRun.id))); await runner.close();
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM files').get().n, count + (action === 'revoke' ? 1 : 0), `${action} during binary transfer follows current access policy`);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_id=? AND role='assistant' AND kind='attachment'").get(pendingRun.thread_id).n, 0);
  }
  console.log('Workspace files: binary transfer, path/link/type/size checks, fileId/send, ownership, idempotency, approvals across restart, project leases, cancellation and owner-wide Bot access passed');
} finally {
  await runner?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  for (const [name, value] of [['SANDBOX_URL', originalEnv.url], ['SANDBOX_TOKEN', originalEnv.token]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  store.close(); fs.rmSync(root, { recursive: true, force: true });
}
