import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';
import { ProjectTools } from '../apps/api/src/projects/tools.ts';
import { ResourceFiles } from '../apps/api/src/projects/resources.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-default-workspace-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const files = path.join(directory, 'files'); fs.mkdirSync(files);
const projects = new ProjectRepository(store, path.join(files, 'projects'));
const resources = new ResourceFiles(projects, files);
const config = new CloudConfiguration(store, path.join(directory, 'config'));
const study = new StudyTools(store, config, files);
const owner = crypto.randomUUID(), other = crypto.randomUUID(), agent = crypto.randomUUID(), at = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, id, at);
store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(agent, owner, 'Default Bot', 'assistant', '', at, at);
config.save(owner, { ...config.get(owner), providers: [{ id: 'mock', name: 'mock', baseUrl: 'https://model.invalid', protocol: 'openai-chat', apiKey: 'test', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'mock', model: 'mock' }, policy: { ...config.get(owner).policy, read: 'allow', write: 'allow', shell: 'allow', network: 'deny' } });
const tool = (name, args) => Response.json({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }] });
const done = () => Response.json({ choices: [{ message: { content: '完成。' } }] });
const status = id => store.db.prepare('SELECT status FROM runs WHERE id=?').get(id).status;
const until = async fn => { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('default_workspace_test_timeout'); };
let runner;
const concurrency = process.env.BOT_CONCURRENCY;
try {
  const service = new BotApplicationService(store, { enqueue() {} }, projects);
  const thread = service.create(owner, 'bot', 'Default workspace', agent);
  assert.equal(projects.thread(thread.id).agent_id, agent, 'IM service preserves the chosen Bot identity');
  const root = projects.resourceRoot(owner), bot = projects.botWorkspace(owner);
  projects.files.write(root, 'root-only.txt', 'from the resource root', null);
  projects.files.write(root, 'input.txt', 'different root file', null);
  const input = await receiveFile(store, files, owner, Readable.from(['Bot input']), 'input.txt', 'text/plain', 1000);
  const sent = service.send(owner, thread.id, { clientNonce: 'input', kind: 'attachment', content: JSON.stringify({ fileId: input.id, caption: '整理文件并生成结果' }) });
  const run = store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(sent.id).id;
  let calls = 0, registered;
  const output = Buffer.from('binary result\0bytes');
  runner = new BotRunner(store, { projects, configuration: config, study,
    sandbox: async request => {
      assert.equal(request.projectId, bot, 'ordinary shell mounts the same Bot folder');
      assert.equal(request.network, false);
      assert.ok(projects.hasExecution(bot));
      assert.equal(projects.files.read(bot, 'input.txt').text, 'Bot input');
      projects.files.write(bot, 'task/drafts/result.zip', output.toString(), null);
      return { stdout: '/workspace', stderr: '', exitCode: 0 };
    },
    sandboxFile: async request => {
      assert.equal(request.projectId, bot);
      assert.equal(request.path, 'task/drafts/result.zip');
      assert.ok(projects.hasExecution(bot));
      return output;
    },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body), last = body.messages.at(-1);
      assert.match(body.messages[0].content, /Default Bot workspace:/);
      assert.ok(body.tools.some(t => t.function.name === 'workspace'));
      assert.ok(body.tools.some(t => t.function.name === 'settings'), 'ordinary Bot keeps its general tools');
      switch (++calls) {
        case 1:
          assert.equal(projects.files.read(bot, 'input.txt').text, 'Bot input', 'incoming attachments exist before any model call or library visit');
          return tool('projects', { action: 'create', name: 'task' });
        case 2:
          assert.deepEqual(JSON.parse(last.content).projectId, bot);
          return tool('workspace', { action: 'mkdir', path: 'task/drafts' });
        case 3: return tool('workspace', { action: 'write', path: 'task/drafts/notes.md', text: '# Notes', expectedRevision: null });
        case 4: return tool('workspace', { action: 'read', path: 'input.txt' });
        case 5:
          assert.equal(JSON.parse(last.content).text, 'Bot input');
          assert.equal(JSON.parse(last.content).projectId, bot);
          return tool('workspace', { action: 'read', projectId: root, path: 'input.txt' });
        case 6:
          assert.equal(JSON.parse(last.content).text, 'different root file');
          assert.equal(JSON.parse(last.content).projectId, root);
          return tool('shell', { command: 'generate result' });
        case 7: return tool('study_upload_file', { path: '/workspace/task/drafts/result.zip' });
        case 8:
          registered = JSON.parse(last.content).fileId;
          assert.ok(registered);
          return tool('study_send_file', { fileId: registered });
        case 9: return tool('finish_turn', {});
        default: throw new Error('unexpected_model_call');
      }
    },
  });
  projects.isActive = id => runner.isProjectActive(id);
  runner.start(); await until(() => ['completed', 'failed', 'paused'].includes(status(run))); await runner.close();
  assert.equal(status(run), 'completed'); assert.equal(calls, 9);
  assert.equal(projects.hasExecution(bot), false);
  assert.deepEqual(resources.list(owner).entries.map(e => e.name).sort(), ['Bot', 'input.txt', 'root-only.txt']);
  assert.deepEqual(resources.list(owner, bot).entries.map(e => e.name).sort(), ['input.txt', 'task']);
  assert.equal(projects.files.read(bot, 'task/drafts/notes.md').text, '# Notes');
  assert.deepEqual(store.db.prepare('SELECT project_id,path,status FROM resource_attachments WHERE file_id=?').get(registered), { project_id: bot, path: 'task/drafts/result.zip', status: 'done' });
  assert.equal(resources.list(owner, bot, 'task/drafts').entries.length, 2, 'sending a generated file does not duplicate it at the top of Bot');

  const tools = new ProjectTools(projects), current = projects.thread(thread.id), policy = config.policy(owner, thread.id);
  const execute = (name, args, context = current) => { assert.equal(tools.permission(name, args, context, policy), 'allow'); return JSON.parse(tools.execute(name, args, context)); };
  const scopes = execute('projects', { action: 'list' });
  assert.equal(scopes.find(p => p.defaultWorkspace).id, bot);
  assert.equal(scopes.find(p => p.resourceRoot).id, root);
  assert.throws(() => execute('workspace', { action: 'read', path: 'root-only.txt' }), /project_file_not_found/, 'missing Bot files never silently fall back to the root');
  assert.equal(execute('workspace', { action: 'read', projectId: root, path: 'root-only.txt' }).text, 'from the resource root');
  assert.throws(() => execute('workspace', { action: 'read', path: '../root-only.txt' }), /invalid_project_path/);
  const foreign = projects.create(other, 'Private');
  assert.throws(() => execute('workspace', { action: 'list', projectId: foreign.id, path: '' }), /project_not_found/);
  const existingBotName = projects.create(other, 'Bot');
  const otherBot = projects.botWorkspace(other);
  assert.notEqual(otherBot, existingBotName.id);
  assert.equal(projects.get(other, otherBot).name, 'Bot (2)', 'a same-named user folder is never mistaken for the default workspace');
  const newAgent = crypto.randomUUID();
  store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(newAgent, other, 'New Bot', 'assistant', '', at, at);
  projects.provisionAgent(other, newAgent);
  assert.equal(projects.authorize(other, otherBot, newAgent, 'manage').id, otherBot);
  assert.equal(projects.get(other, existingBotName.id).grants.length, 0);
  projects.grant(owner, root, agent, null);
  assert.throws(() => execute('workspace', { action: 'list', projectId: root, path: '' }), /project_access_denied/);
  assert.ok(!execute('projects', { action: 'list' }).some(p => p.id === root), 'listing never restores a revoked root grant');
  projects.update(owner, bot, { name: 'Bot 工作文件' });
  assert.equal(projects.botWorkspace(owner), bot);
  assert.equal(execute('workspace', { action: 'read', path: 'input.txt' }).text, 'Bot input');
  projects.grant(owner, bot, agent, 'read');
  assert.throws(() => execute('projects', { action: 'create', name: 'forbidden' }), /project_access_denied/);
  projects.grant(owner, bot, agent, null);
  assert.throws(() => execute('workspace', { action: 'list', path: '' }), /project_access_denied/);
  assert.equal(projects.get(owner, bot).grants.length, 0, 'default resolution never restores revoked grants');
  projects.grant(owner, bot, agent, 'manage');

  const chat = service.create(owner, 'chat', 'Course chat'), chatRun = crypto.randomUUID();
  store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,'chat','running',?)").run(chatRun, chat.id, at);
  assert.doesNotThrow(() => projects.assertIdle(bot), 'unrelated course chat does not lock the default Bot folder');

  // Old IM threads had participants but no agent_id; their workspace is the same.
  const legacy = service.create(owner, 'bot', 'Legacy IM', agent);
  store.db.prepare('UPDATE threads SET agent_id=NULL WHERE id=?').run(legacy.id);
  assert.equal(projects.workspaceId(projects.thread(legacy.id)), bot);
  const scoped = crypto.randomUUID();
  store.db.prepare("INSERT INTO threads(id,owner_id,project_id,agent_id,mode,created_at,updated_at) VALUES(?,?,?,?,'bot',?,?)").run(scoped, owner, bot, agent, at, at);
  const scopedContext = projects.thread(scoped);
  assert.throws(() => execute('workspace', { action: 'list', projectId: root, path: '' }, scopedContext), /project_access_denied/, 'explicit folder conversations stay scoped');
  const runs = [thread.id, legacy.id, scoped].map(id => {
    const message = service.send(owner, id, { clientNonce: crypto.randomUUID(), content: 'run shell' });
    return store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(message.id).id;
  });
  process.env.BOT_CONCURRENCY = '3';
  let active = 0, executions = 0;
  runner = new BotRunner(store, { projects, configuration: config, study,
    sandbox: async request => {
      assert.equal(request.projectId, bot); assert.equal(++active, 1, 'all sessions sharing Bot are serialized'); executions++;
      try { await new Promise(resolve => setTimeout(resolve, 30)); return { stdout: 'ok', stderr: '', exitCode: 0 }; }
      finally { active--; }
    },
    fetch: async (_url, init) => JSON.parse(init.body).messages.some(m => m.role === 'tool') ? done() : tool('shell', { command: 'pwd' }),
  });
  runner.start(); await until(() => runs.every(id => ['completed', 'failed', 'paused'].includes(status(id)))); await runner.close();
  assert.ok(runs.every(id => status(id) === 'completed')); assert.equal(executions, 3);
  console.log('Default Bot workspace: early attachment import, nested folders, shared shell/files, explicit root lookup, grants/owner isolation, rename/revocation, export deduplication, legacy IM and shared-workspace serialization passed');
} finally {
  await runner?.close();
  if (concurrency === undefined) delete process.env.BOT_CONCURRENCY; else process.env.BOT_CONCURRENCY = concurrency;
  store.close(); fs.rmSync(directory, { recursive: true, force: true });
}
