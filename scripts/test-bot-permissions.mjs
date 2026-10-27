import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';
import { BotSettingsTools } from '../apps/api/src/agent/settings.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-bot-permissions-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const projects = new ProjectRepository(store, path.join(directory, 'files'));
const settings = new BotSettingsTools(configuration, projects);
const owner = crypto.randomUUID(), agent = crypto.randomUUID(), threadId = crypto.randomUUID(), now = new Date().toISOString();
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, 'Owner', now);
store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(agent, owner, 'Bot', 'assistant', '', now, now);
store.db.prepare("INSERT INTO threads(id,owner_id,agent_id,mode,title,created_at,updated_at) VALUES(?,?,?,'bot','Main',?,?)").run(threadId, owner, agent, now, now);
store.db.prepare('INSERT INTO thread_participants VALUES(?,?,?)').run(threadId, agent, now);
const thread = projects.thread(threadId);
const get = () => configuration.get(owner);
const revision = () => JSON.parse(settings.execute('settings', { action: 'get' }, thread)).revision;
const state = id => store.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
const response = (name, args) => Response.json({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }] });
const until = async fn => {
  for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for permissions test');
};
let runner;
let commands = 0;
async function runTool(name, args, { approved, beforeResolve, restart = false, targetThread = threadId } = {}) {
  const id = crypto.randomUUID();
  let calls = 0;
  const options = { configuration, projects, sandbox: async () => { commands++; return { stdout: 'done', stderr: '', exitCode: 0 }; },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (calls++ === 0) return response(name, args);
      return response('send_message', { kind: 'text', text: body.messages.filter(m => m.role === 'tool').at(-1).content });
    },
  };
  store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,'bot','queued',?)").run(id, targetThread, now);
  runner = new BotRunner(store, options); runner.start();
  await until(() => ['waiting_user', 'completed', 'failed'].includes(state(id).status));
  if (approved !== undefined) {
    assert.equal(state(id).status, 'waiting_user');
    await beforeResolve?.();
    if (restart) await runner.close();
    store.db.prepare('UPDATE approvals SET status=? WHERE run_id=?').run(approved ? 'approved' : 'rejected', id);
    store.db.prepare("UPDATE runs SET status='queued' WHERE id=?").run(id);
    if (restart) { runner = new BotRunner(store, options); runner.start(); } else runner.enqueue();
    await until(() => ['completed', 'failed'].includes(state(id).status));
  }
  assert.equal(state(id).status, 'completed', JSON.stringify(state(id)));
  await runner.close();
  return { id, result: store.db.prepare('SELECT result FROM run_steps WHERE run_id=? AND tool=?').get(id, name).result };
}

try {
  configuration.save(owner, { ...get(), providers: [{ id: 'model', name: 'Model', baseUrl: 'https://model.example/v1', apiKey: 'private-test-key', protocol: 'openai-chat', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'model', model: 'first' }, trustedAgentIds: [agent] });
  assert.equal(configuration.policy(owner, threadId).write, 'allow');
  assert.equal(configuration.policy(owner, threadId).shell, 'allow');
  configuration.save(owner, { ...get(), policy: { ...get().policy, write: 'deny', shell: 'deny' } });
  assert.equal(configuration.policy(owner, threadId).write, 'deny', 'trust never overrides an explicit prohibition');
  assert.equal(configuration.policy(owner, threadId).shell, 'deny');
  configuration.save(owner, { ...get(), policy: { ...get().policy, write: 'allow', shell: 'allow', remove: 'allow' } });

  const created = JSON.parse((await runTool('projects', { action: 'create', name: 'Bot-created project' })).result);
  assert.equal(created.grants[0].role, 'manage');
  assert.equal(created.grants[0].agentId, agent);
  assert.equal(created.url, `#/projects/${created.id}`);
  assert.equal(projects.list(owner).length, 1);
  assert.deepEqual(projects.files.list(created.id, ''), []);

  const read = await runTool('settings', { action: 'get' });
  assert.ok(JSON.parse(read.result).providers[0].configured);
  assert.ok(!state(read.id).context_json.includes('private-test-key'));
  await runTool('settings', { action: 'set_model', expectedRevision: revision(), slot: 'llmModel', providerId: 'model', model: 'second' });
  assert.equal(get().llmModel.model, 'second');
  assert.equal(configuration.get(owner, true).providers[0].apiKey, 'private-test-key');

  await runTool('settings', { action: 'set_policy', expectedRevision: revision(), policy: { network: 'allow' } }, {
    approved: false, beforeResolve: () => assert.equal(get().policy.network, 'deny'),
  });
  assert.equal(get().policy.network, 'deny');
  await runTool('settings', { action: 'set_policy', expectedRevision: revision(), policy: { network: 'allow' } }, { approved: true, restart: true });
  assert.equal(get().policy.network, 'allow');

  const conflict = await runTool('settings', { action: 'set_provider', expectedRevision: revision(), providerId: 'model', provider: { baseUrl: 'https://new.example/v1' } }, {
    approved: true, restart: true, beforeResolve: () => {
      assert.equal(get().providers[0].baseUrl, 'https://model.example/v1');
      configuration.save(owner, { ...get(), policy: { ...get().policy, maxSteps: 75 } });
    },
  });
  assert.match(conflict.result, /settings_conflict_read_again/);
  assert.equal(get().providers[0].baseUrl, 'https://model.example/v1');
  assert.equal(get().policy.maxSteps, 75);
  await runTool('settings', { action: 'set_provider', expectedRevision: revision(), providerId: 'model', provider: { baseUrl: 'https://new.example/v1' } }, { approved: true });
  assert.equal(get().providers[0].baseUrl, 'https://new.example/v1');
  assert.equal(configuration.get(owner, true).providers[0].apiKey, 'private-test-key');
  await runTool('settings', { action: 'set_budget', expectedRevision: revision(), maxSteps: 100 }, { approved: false });
  assert.equal(get().policy.maxSteps, 75);
  await runTool('settings', { action: 'set_budget', expectedRevision: revision(), maxSteps: 50 });
  assert.equal(get().policy.maxSteps, 50);
  const forged = await runTool('settings', { action: 'set_policy', expectedRevision: revision(), policy: { trustedAgentIds: [agent] } });
  assert.match(forged.result, /invalid_policy/);
  const secretWrite = await runTool('settings', { action: 'set_provider', expectedRevision: revision(), providerId: 'model', provider: { apiKey: 'forged' } });
  assert.match(secretWrite.result, /invalid_provider/);

  await runTool('shell', { command: 'node -e "console.log(42)"' });
  assert.equal(commands, 1);
  await runTool('shell', { command: 'rm -rf /workspace/results' }, { approved: false });
  assert.equal(commands, 1);
  await runTool('shell', { command: 'python publish.py', requiresApproval: true }, { approved: false });
  assert.equal(commands, 1);
  await runTool('shell', { command: 'rm -rf /workspace/results' }, { approved: true, restart: true });
  assert.equal(commands, 2, 'one approved operation is executed exactly once after restart');

  const projectThread = crypto.randomUUID();
  store.db.prepare("INSERT INTO threads(id,owner_id,agent_id,project_id,mode,title,created_at,updated_at) VALUES(?,?,?,?,'bot','Project',?,?)").run(projectThread, owner, agent, created.id, now, now);
  const denied = await runTool('settings', { action: 'get' }, { targetThread: projectThread });
  assert.match(denied.result, /settings_access_denied/);
  const file = projects.files.write(created.id, 'keep.txt', 'keep', null);
  await runTool('workspace', { action: 'remove', path: 'keep.txt', expectedRevision: file.revision }, { targetThread: projectThread, approved: false });
  assert.equal(projects.files.read(created.id, 'keep.txt').text, 'keep');

  configuration.save(owner, { ...get(), policy: { ...get().policy, write: 'deny' } });
  assert.match((await runTool('projects', { action: 'create', name: 'Forbidden' })).result, /denied/);
  assert.equal(projects.list(owner).length, 1);
  console.log('Bot permissions: project creation, redacted config, exact approvals, rejection, restart, config conflicts, secret protection, trust/deny, shell and project boundaries passed');
} finally { await runner?.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
