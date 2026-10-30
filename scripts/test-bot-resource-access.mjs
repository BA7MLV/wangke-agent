import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';
import { ProjectTools } from '../apps/api/src/projects/tools.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';
import { SystemMaterials } from '../apps/api/src/storage/system-materials.ts';
import { sandboxArgs } from '../infra/sandbox/arguments.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-resource-access-'));
const files = path.join(directory, 'files'); fs.mkdirSync(files);
const store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(files, 'system-files'));
const projects = new ProjectRepository(store, path.join(files, 'projects'));
const config = new CloudConfiguration(store, path.join(directory, 'config'));
const study = new StudyTools(store, config, files);
const service = new BotApplicationService(store, { enqueue() {} }, projects);
const owner = crypto.randomUUID(), other = crypto.randomUUID(), agent = crypto.randomUUID(), at = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, id, at);
store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(agent, owner, 'Bot', 'assistant', '', at, at);
config.save(owner, { ...config.get(owner), providers: [{ id: 'mock', name: 'mock', baseUrl: 'https://model.invalid', protocol: 'openai-chat', apiKey: 'test', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'mock', model: 'mock' }, policy: { ...config.get(owner).policy, read: 'allow', write: 'allow', shell: 'allow', network: 'allow' } });
const bot = projects.botWorkspace(owner), root = projects.resourceRoot(owner);
const target = projects.create(owner, 'No grant'), foreign = projects.create(other, 'Private');
projects.update(owner, target.id, { policy: { shell: 'allow', network: 'allow' } });
projects.files.mkdir(target.id, 'nested');
projects.files.write(target.id, 'nested/notes.md', '# Owner resource', null);
const bytes = Buffer.from('binary resource\0bytes');
fs.writeFileSync(path.join(projects.files.root, target.id, 'nested/result.zip'), bytes);
const status = id => store.db.prepare('SELECT status FROM runs WHERE id=?').get(id).status;
const until = async fn => { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('resource_access_test_timeout'); };
let runner;

async function operation(name, args, { scoped = false, approve, approved = true } = {}) {
  const thread = scoped ? { id: crypto.randomUUID() } : service.create(owner, 'bot', name, agent);
  if (scoped) store.db.prepare("INSERT INTO threads(id,owner_id,project_id,agent_id,mode,title,created_at,updated_at) VALUES(?,?,?,?,'bot',?,?,?)").run(thread.id, owner, bot, agent, name, at, at);
  const message = service.send(owner, thread.id, { clientNonce: crypto.randomUUID(), content: `Use ${name}` });
  const run = store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(message.id).id;
  let calls = 0;
  const executions = [], reads = [];
  const options = { projects, configuration: config, study, sandboxCleanup: async () => {},
    sandbox: async request => {
      executions.push(request);
      assert.ok(projects.hasExecution(request.projectId));
      return { stdout: 'owner resource', stderr: '', exitCode: 0 };
    },
    sandboxFile: async request => {
      reads.push(request);
      assert.ok(projects.hasExecution(request.projectId));
      assert.equal(request.projectId, target.id);
      assert.equal(request.path, 'nested/result.zip');
      return bytes;
    },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.ok(body.tools.some(t => t.function.name === 'projects'), 'all Bot conversations can discover owner projects');
      return Response.json({ choices: [{ message: ++calls === 1
        ? { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] }
        : { content: '完成。' } }] });
    },
  };
  runner = new BotRunner(store, options); runner.start();
  await until(() => ['completed', 'failed', 'paused', 'waiting_user'].includes(status(run)));
  await runner.close();
  if (approve) {
    assert.equal(status(run), 'waiting_user');
    assert.equal(executions.length, 0);
    const approval = store.db.prepare("SELECT id FROM approvals WHERE run_id=? AND status='pending'").get(run);
    const pending = store.db.prepare('SELECT arguments FROM run_steps WHERE run_id=? AND tool=?').get(run, name);
    assert.equal(JSON.parse(pending.arguments).projectId, name === 'shell' ? args.projectId ?? bot : args.projectId, 'approval pins the exact target project');
    await approve({ run, arguments: JSON.parse(pending.arguments), executions });
    service.resolve(owner, approval.id, approved);
    runner = new BotRunner(store, options); runner.start();
    await until(() => ['completed', 'failed', 'paused', 'waiting_user'].includes(status(run)));
    await runner.close();
  }
  assert.equal(status(run), 'completed', `${name}: ${JSON.stringify(store.db.prepare('SELECT error_code FROM runs WHERE id=?').get(run))}`);
  const step = store.db.prepare('SELECT result FROM run_steps WHERE run_id=? AND tool=?').get(run, name);
  return { run, thread: thread.id, result: step.result, executions, reads };
}

try {
  const tools = new ProjectTools(projects), thread = projects.thread(service.create(owner, 'bot', 'Discovery', agent).id);
  const execute = (name, args) => { assert.equal(tools.permission(name, args, thread, config.policy(owner, thread.id)), 'allow'); return JSON.parse(tools.execute(name, args, thread)); };
  assert.equal(projects.get(owner, target.id).grants.length, 0);
  const listing = execute('projects', { action: 'list' });
  assert.ok(listing.some(p => p.id === target.id));
  assert.ok(listing.some(p => p.id === root && p.resourceRoot));
  assert.ok(!listing.some(p => p.id === foreign.id));
  assert.equal(execute('workspace', { action: 'read', projectId: target.id, path: 'nested/notes.md' }).text, '# Owner resource');
  assert.equal(execute('workspace', { action: 'write', projectId: target.id, path: 'nested/new.md', text: 'New', expectedRevision: null }).path, 'nested/new.md');
  assert.throws(() => execute('workspace', { action: 'read', projectId: foreign.id, path: 'private.txt' }), /project_not_found/);

  // Legacy grants must not leave shell less capable than workspace tools.
  projects.grant(owner, bot, agent, 'read');
  assert.equal((await operation('shell', { command: 'pwd' })).executions.length, 1);
  projects.grant(owner, bot, agent, 'manage');
  const crossProject = await operation('shell', { command: 'pwd', projectId: target.id }, { scoped: true });
  assert.equal(crossProject.executions.length, 1);
  assert.equal(crossProject.executions[0].projectId, target.id);
  assert.equal(crossProject.executions[0].network, true);

  const upload = await operation('study_upload_file', { path: 'nested/result.zip', projectId: target.id }, { scoped: true });
  assert.equal(upload.reads.length, 1);
  const registered = JSON.parse(upload.result);
  assert.deepEqual(Buffer.from((await study.file(owner, registered.fileId)).bytes), bytes);
  assert.deepEqual(store.db.prepare('SELECT project_id,path FROM resource_attachments WHERE file_id=?').get(registered.fileId), { project_id: target.id, path: 'nested/result.zip' });
  assert.equal((await operation('shell', { command: 'pwd', projectId: foreign.id })).executions.length, 0);
  assert.equal((await operation('study_upload_file', { path: 'nested/result.zip', projectId: foreign.id })).reads.length, 0);

  // Resumed approvals use the target policy, never the conversation's workspace policy.
  projects.update(owner, bot, { policy: { shell: 'deny', network: 'deny' } });
  projects.update(owner, target.id, { policy: { shell: 'ask', network: 'allow' } });
  const approved = await operation('shell', { command: 'pwd', projectId: target.id }, { approve() {} });
  assert.equal(approved.executions.length, 1);
  assert.equal(approved.executions[0].network, true);
  projects.update(owner, bot, { policy: { shell: 'allow', network: 'allow' } });
  for (const change of [{ shell: 'deny', network: 'allow' }, { shell: 'allow', network: 'deny' }]) {
    projects.update(owner, target.id, { policy: { shell: 'ask', network: 'allow' } });
    const denied = await operation('shell', { command: 'pwd', projectId: target.id }, { approve() { projects.update(owner, target.id, { policy: change }); } });
    assert.equal(denied.executions.length, 0, 'an approval never overrides a new target shell/network denial');
    assert.match(denied.result, /denied/);
  }

  projects.update(owner, target.id, { archived: true });
  assert.ok(execute('projects', { action: 'list' }).find(p => p.id === target.id).archived);
  assert.equal(execute('workspace', { action: 'read', projectId: target.id, path: 'nested/notes.md' }).text, '# Owner resource');
  assert.throws(() => execute('workspace', { action: 'write', projectId: target.id, path: 'blocked.md', text: 'No', expectedRevision: null }), /project_archived/);
  assert.equal((await operation('study_upload_file', { path: 'nested/result.zip', projectId: target.id })).reads.length, 1, 'archived binary resources remain readable');
  assert.equal((await operation('shell', { command: 'pwd', projectId: target.id })).executions.length, 0);

  const materials = new SystemMaterials(store), instructions = materials.read(owner, '/system/AGENTS.md');
  materials.save(owner, instructions.path, 'Owner system instructions', instructions.content, instructions.revision);
  for (const scoped of [false, true]) assert.match((await operation('read', { path: '/system/AGENTS.md' }, { scoped })).result, /Owner system instructions/);

  config.save(owner, { ...config.get(owner, true), trustedAgentIds: [agent], policy: { ...config.get(owner).policy, read: 'allow', write: 'allow', shell: 'allow', remove: 'allow' } });
  for (const scoped of [false, true]) {
    const before = materials.read(owner, '/system/AGENTS.md');
    const edited = await operation('edit', { path: before.path, revision: before.revision, append: `Automatic ${scoped ? 'project' : 'main'} edit` }, { scoped });
    assert.equal(JSON.parse(edited.result).saved, true);
    assert.match(materials.read(owner, before.path).content, scoped ? /Automatic project edit/ : /Automatic main edit/);
  }
  // This is an owner-system rule, not merely a trusted Bot exception.
  config.save(owner, { ...config.get(owner, true), trustedAgentIds: [], policy: { ...config.get(owner).policy, read: 'ask', write: 'ask', shell: 'ask' } });
  const note = '/system/memory/autonomous-test.md';
  await operation('edit', { path: note, revision: 0, create: true, content: 'Automatic note' });
  let before = materials.read(owner, note);
  assert.match((await operation('read', { path: note })).result, /Automatic note/);
  assert.match((await operation('grep', { path: '/system/memory', query: 'Automatic note' })).result, /Automatic note/);
  materials.save(owner, note, 'User concurrent edit', before.content, before.revision);
  const staleEdit = await operation('edit', { path: note, revision: before.revision, append: 'Stale' });
  assert.match(staleEdit.result, /system_revision_conflict/);
  assert.equal(materials.read(owner, note).content, 'User concurrent edit');

  const skill = materials.read(owner, '/system/skills/course-handout/SKILL.md');
  const skillEdit = await operation('edit', { path: skill.path, revision: skill.revision, append: 'Automatic Skill edit' });
  assert.equal(JSON.parse(skillEdit.result).saved, true);
  assert.match(materials.read(owner, skill.path).content, /Automatic Skill edit/);
  assert.match((await operation('read', { path: '/system/skills/course-handout' })).result, /SKILL.md/);
  assert.ok(JSON.parse((await operation('skill_load', { id: -4 })).result).body);

  const mcp = materials.read(owner, '/system/mcp.json');
  const mcpEdit = await operation('edit', { path: mcp.path, revision: mcp.revision, edits: [{ old_string: '"servers": []', new_string: '"servers": [{"name":"Automatic disabled server","url":"https://example.invalid/mcp","enabled":false}]' }] }, { scoped: true });
  assert.equal(JSON.parse(mcpEdit.result).saved, true, 'project Bot conversations can also modify system MCP without approval');

  const memoryCount = () => store.db.prepare('SELECT COUNT(*) n FROM bot_memories WHERE owner_id=?').get(owner).n;
  const count = memoryCount();
  const savedMemory = await operation('study_memory', { action: 'save', kind: 'preference', content: 'Automatic lasting preference' });
  const memory = JSON.parse(savedMemory.result);
  assert.equal(memoryCount(), count + 1);
  const updatedMemory = JSON.parse((await operation('study_memory', { action: 'save', id: memory.id, revision: memory.revision, content: 'Updated lasting preference' })).result);
  assert.equal(updatedMemory.revision, memory.revision + 1);
  assert.match((await operation('study_memory', { action: 'list' })).result, /Updated lasting preference/);
  // Even remove=allow and trusted Bots cannot bypass deletion confirmation.
  config.save(owner, { ...config.get(owner, true), trustedAgentIds: [agent], policy: { ...config.get(owner).policy, read: 'allow', write: 'allow', shell: 'allow', remove: 'allow' } });
  const rejectedDelete = await operation('study_memory', { action: 'delete', id: memory.id, revision: updatedMemory.revision }, { approved: false, approve() {} });
  assert.match(rejectedDelete.result, /denied/i);
  assert.notEqual(store.db.prepare('SELECT status FROM bot_memories WHERE id=?').get(memory.id).status, 'deleted');
  await operation('study_memory', { action: 'delete', id: memory.id, revision: updatedMemory.revision }, { approve() {
    assert.notEqual(store.db.prepare('SELECT status FROM bot_memories WHERE id=?').get(memory.id).status, 'deleted');
  } });
  assert.equal(store.db.prepare('SELECT status FROM bot_memories WHERE id=?').get(memory.id).status, 'deleted');

  const shellWrite = { command: 'python3 /workspace/update-system.py', description: '修改系统指令、笔记和技能', systemWrite: true, timeoutSeconds: 600 };
  const directShell = await operation('shell', shellWrite);
  assert.equal(directShell.executions.length, 1);
  assert.equal(directShell.executions[0].systemWrite, true);
  assert.equal(directShell.executions[0].timeoutSeconds, 600);
  assert.equal(store.db.prepare('SELECT 1 FROM approvals WHERE run_id=?').get(directShell.run), undefined);
  config.save(owner, { ...config.get(owner, true), trustedAgentIds: [], policy: { ...config.get(owner).policy, read: 'ask', write: 'ask', shell: 'ask' } });
  assert.equal((await operation('shell', shellWrite)).executions[0].systemWrite, true, 'system creates/edits do not ask even with ask policies');
  config.save(owner, { ...config.get(owner, true), policy: { ...config.get(owner).policy, read: 'allow', write: 'allow', shell: 'allow' } });
  const shellDelete = { ...shellWrite, command: 'rm /system/custom.txt', description: '删除系统文件' };
  const approvedShell = await operation('shell', shellDelete, { approve({ arguments: pending }) {
    assert.equal(pending.systemWrite, true);
    assert.equal(pending.command, shellDelete.command);
    assert.equal(pending.timeoutSeconds, 600);
  } });
  assert.equal(approvedShell.executions.length, 1);
  assert.equal(approvedShell.executions[0].systemWrite, true);
  const prompt = store.db.prepare("SELECT content FROM messages WHERE thread_id=? AND kind='approval'").get(approvedShell.thread).content;
  assert.match(prompt, /整个 \/system/); assert.match(prompt, /rm \/system\/custom.txt/);
  assert.equal((await operation('shell', shellDelete, { approved: false, approve() {} })).executions.length, 0);
  assert.equal((await operation('shell', { ...shellWrite, command: 'python3 delete-files.py', requiresApproval: true }, { approved: false, approve() {} })).executions.length, 0, 'opaque deletion scripts must explicitly request approval');
  for (const command of ['find /system -name "*.old" -delete', 'python3 -c "import os; os.remove(\'/system/old.txt\')"', 'node -e "require(\'fs\').rmSync(\'/system/old.txt\')"', 'rsync --delete /workspace/skills/ /system/skills/']) {
    assert.equal((await operation('shell', { ...shellWrite, command }, { approved: false, approve() {} })).executions.length, 0, command);
  }
  assert.equal((await operation('shell', { command: 'pwd' })).executions[0].systemWrite, undefined, 'later commands do not inherit system write permission');
  const ordinaryApproval = await operation('shell', { command: 'pwd', requiresApproval: true }, { approve() {} });
  assert.equal(ordinaryApproval.executions[0].systemWrite, false, 'an ordinary shell approval never grants system write permission');
  const revokedShell = await operation('shell', shellDelete, { approve() { config.save(owner, { ...config.get(owner, true), policy: { ...config.get(owner).policy, write: 'deny' } }); } });
  assert.equal(revokedShell.executions.length, 0);
  assert.match(revokedShell.result, /denied/i);
  assert.equal((await operation('shell', shellWrite)).executions.length, 0);
  before = materials.read(owner, note);
  assert.match((await operation('edit', { path: note, revision: before.revision, append: 'Denied' })).result, /denied/i);
  assert.equal(materials.read(owner, note).content, before.content);
  config.save(owner, { ...config.get(owner, true), policy: { ...config.get(owner).policy, write: 'allow' } });
  config.save(owner, { ...config.get(owner, true), policy: { ...config.get(owner).policy, remove: 'deny' } });
  assert.equal((await operation('shell', shellDelete)).executions.length, 0);
  const revokedDelete = await operation('study_memory', { action: 'delete', id: updatedMemory.id, revision: updatedMemory.revision });
  assert.match(revokedDelete.result, /denied/i);
  config.save(owner, { ...config.get(owner, true), policy: { ...config.get(owner).policy, read: 'deny' } });
  assert.match((await operation('read', { path: note })).result, /denied/i);
  assert.equal((await operation('shell', shellWrite)).executions.length, 0);
  config.save(owner, { ...config.get(owner, true), policy: { ...config.get(owner).policy, read: 'allow', remove: 'allow' } });
  assert.match((await operation('shell', { command: 'pwd', systemWrite: 'true' })).result, /invalid_arguments/);
  await assert.rejects(() => runner.runSandbox({ owner, threadId: thread.id, projectId: bot, executionId: crypto.randomUUID(), command: 'pwd', systemWrite: true }, new AbortController().signal), /system_write_scope_mismatch/);
  // Writable mounts remain bound to the exact persisted owner/thread/step,
  // arguments and any deletion approval, even when ordinary edits are automatic.
  const request = approvedShell.executions[0];
  store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(approvedShell.run);
  store.db.prepare("UPDATE run_steps SET status='running' WHERE id=?").run(request.executionId);
  for (const changed of [{ owner: other }, { threadId: thread.id }, { projectId: foreign.id }, { command: 'echo changed' }, { network: !request.network }, { timeoutSeconds: 120 }]) {
    await assert.rejects(() => runner.runSandbox({ ...request, ...changed }, new AbortController().signal), /system_write_scope_mismatch/);
  }
  store.db.prepare("UPDATE approvals SET status='rejected' WHERE step_id=?").run(request.executionId);
  await assert.rejects(() => runner.runSandbox(request, new AbortController().signal), /system_write_approval_required/);
  store.db.prepare("UPDATE run_steps SET status='completed' WHERE id=?").run(request.executionId);
  store.db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(approvedShell.run);

  const mountArgs = (who, systemWrite = false) => sandboxArgs({ owner: who, threadId: crypto.randomUUID(), projectId: bot, executionId: crypto.randomUUID(), command: 'pwd', systemWrite }, '/host/projects', '/host/system-files');
  const mounts = args => args.flatMap((value, i) => value === '--mount' ? [args[i + 1]] : []);
  const systemPath = `/host/system-files/${crypto.createHash('sha256').update(owner).digest('hex')}/system`;
  assert.ok(mounts(mountArgs(owner)).includes(`type=bind,source=${systemPath},target=/system,readonly`));
  assert.ok(!mounts(mountArgs(owner)).some(mount => mount.includes('target=/system/skills')), 'no writable skills exception');
  assert.ok(mounts(mountArgs(owner, true)).includes(`type=bind,source=${systemPath},target=/system`), 'systemWrite commands can modify the entire owner system directory');
  assert.ok(!mounts(mountArgs(other)).some(mount => mount.includes(systemPath)));
  console.log('Bot resource access: all owner projects/files, autonomous system reads/creates/edits/installs, mandatory deletion approvals, trusted/scoped/untrusted Bots, notes/instructions/Skills/MCP/legacy memory, shell isolation, rejection/restart/CAS/revocation and target policies passed');
} finally {
  await runner?.close();
  store.close(); fs.rmSync(directory, { recursive: true, force: true });
}
