import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { sandboxArgs } from '../infra/sandbox/arguments.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-network-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const projects = new ProjectRepository(store, path.join(directory, 'projects'));
const owner = crypto.randomUUID(), agent = crypto.randomUUID(), at = new Date().toISOString();
const previousNetwork = process.env.SANDBOX_NETWORK;
let runner;
const until = async fn => {
  for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('network_test_timeout');
};
try {
  store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, 'Network test', at);
  store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(agent, owner, 'Bot', 'assistant', '', at, at);
  assert.equal(configuration.get(owner).policy.network, 'allow', 'new accounts allow networking');
  configuration.save(owner, { ...configuration.get(owner), providers: [{ id: 'mock', name: 'Mock', baseUrl: 'https://model.invalid', apiKey: 'test', protocol: 'openai-chat', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'mock', model: 'mock' }, policy: { ...configuration.get(owner).policy, shell: 'allow' } });
  const service = new BotApplicationService(store, { enqueue() {} }, projects);
  const workspace = projects.botWorkspace(owner);
  assert.equal(projects.get(owner, workspace).policy.network, 'allow');
  const folder = projects.create(owner, 'New folder', agent);
  assert.equal(folder.policy.network, 'allow', 'new resource scopes inherit the global network switch');
  const network = value => configuration.save(owner, { ...configuration.get(owner, true), policy: { ...configuration.get(owner).policy, network: value } });
  const run = async (expected, projectId) => {
    const thread = projectId ? { id: crypto.randomUUID() } : service.create(owner, 'bot', 'Network switch', agent);
    if (projectId) store.db.prepare("INSERT INTO threads(id,owner_id,project_id,agent_id,mode,created_at,updated_at) VALUES(?,?,?,?,'bot',?,?)").run(thread.id, owner, projectId, agent, at, at);
    const message = service.send(owner, thread.id, { clientNonce: crypto.randomUUID(), content: 'Check network policy' });
    const id = store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(message.id).id;
    let requests = 0, calls = 0;
    runner = new BotRunner(store, { projects, configuration,
      sandbox: async request => { requests++; assert.equal(request.network, expected); return { stdout: 'ok', stderr: '', exitCode: 0 }; },
      fetch: async () => Response.json({ choices: [{ message: ++calls === 1
        ? { tool_calls: [{ function: { name: 'shell', arguments: JSON.stringify({ command: 'pwd' }) } }] }
        : { content: 'Done.' } }] }),
    });
    runner.start();
    await until(() => ['completed', 'failed', 'waiting_user'].includes(store.db.prepare('SELECT status FROM runs WHERE id=?').get(id).status));
    await runner.close();
    assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(id).status, 'completed');
    assert.equal(requests, 1);
  };
  await run(true);
  network('deny');
  assert.equal(new CloudConfiguration(store, path.join(directory, 'config')).get(owner).policy.network, 'deny', 'saved opt-outs survive configuration reloads');
  await run(false);
  network('allow');
  await run(true);
  projects.update(owner, folder.id, { policy: { shell: 'allow', network: 'deny' } });
  await run(false, folder.id);
  assert.equal(new ProjectRepository(store, path.join(directory, 'projects')).get(owner, folder.id).policy.network, 'deny', 'existing folder denials are not upgraded to allow');
  projects.update(owner, folder.id, { policy: { shell: 'allow', network: 'allow' } });
  await run(true, folder.id);
  network('deny');
  await run(false, folder.id);

  const request = { threadId: crypto.randomUUID(), executionId: crypto.randomUUID(), command: 'pwd' };
  const mode = request => { const args = sandboxArgs(request); return args[args.indexOf('--network') + 1]; };
  delete process.env.SANDBOX_NETWORK;
  assert.equal(mode({ ...request, network: true }), 'bridge');
  assert.equal(mode({ ...request, network: false }), 'none');
  assert.equal(mode(request), 'none', 'missing authorization never grants networking');
  assert.equal(mode({ ...request, network: true, filePath: 'report.csv' }), 'none', 'fixed file readers remain offline');
  process.env.SANDBOX_NETWORK = 'none';
  assert.equal(mode({ ...request, network: true }), 'none', 'explicit deployment opt-outs remain effective');
  console.log('Bot networking: default allow, persistent global/folder switches, runtime policy intersection, bridge fallback and offline file readers passed');
} finally {
  await runner?.close();
  if (previousNetwork === undefined) delete process.env.SANDBOX_NETWORK; else process.env.SANDBOX_NETWORK = previousNetwork;
  store.close(); fs.rmSync(directory, { recursive: true, force: true });
}
