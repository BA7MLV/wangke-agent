import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';
import { CloudTaskRunner } from '../apps/api/src/cloud/tasks.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { readDocxUnits } from '@wangke/study-core/materials/docx';
import { receiveFile } from '../apps/api/src/cloud/files.ts';
import { GatewayCore } from '../apps/api/src/gateway/core.ts';
import { DeliveryError } from '../apps/api/src/gateway/plugin.ts';
import { normalizeFeishu, FeishuPlugin } from '../apps/api/src/gateway/adapters/feishu.ts';
import { normalizeIlink, IlinkPlugin, tencentUrl } from '../apps/api/src/gateway/adapters/ilink.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'));
const store = new DatabaseStore(path.join(dir, 'db.sqlite'));
const files = path.join(dir, 'files'); fs.mkdirSync(files);
const cfg = new CloudConfiguration(store, path.join(dir, 'config'));
const owner = 'owner', other = 'other', at = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, at);
store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('agent', owner, 'Study', 'study', 'Use learning tools.', at, at);
const fakeRunner = { enqueue() {}, cancel() {} };
const bot = new BotApplicationService(store, fakeRunner);
const sent = [], contexts = new Map(); let failure, downloadGate, downloads = 0;
function plugin(channel) {
  return { manifest: { id: channel, version: 1, name: channel, capabilities: { direct: true, groups: false, files: true, images: true, proactive: 'yes', deduplicationWindowMs: channel === 'feishu' ? 3600000 : 0 } },
    validate() {}, async start(_c, ctx) { contexts.set(channel, ctx); ctx.health('connected'); }, async stop() {},
    async send(_c, _peer, payload, id) { sent.push({ payload, id }); if (failure) { const e = failure; failure = undefined; throw e; } return `remote-${id}`; },
    async download(_c, _m, attachment, signal) { downloads++; if (downloadGate) await downloadGate(signal); return { bytes: Buffer.from('study attachment'), name: attachment.name, mime: 'text/plain' }; },
  };
}
const factories = { feishu: () => plugin('feishu'), ilink: () => plugin('ilink') };
let gateway = new GatewayCore(store, cfg, bot, factories, files), runner, cloudRunner;
const envelope = (id, text = 'hello', patch = {}) => ({ messageId: id, tenant: 'tenant', peer: 'me', chat: 'chat', topic: '', direct: true, human: true, text, context: 'private-context', ...patch });
const countRuns = () => store.db.prepare('SELECT COUNT(*) n FROM runs').get().n;
async function until(fn) { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout'); }
const response = (name, args) => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
try {
  gateway.start(false);
  const { id: account } = await gateway.save(owner, { channel: 'feishu', agentId: 'agent', enabled: true, preset: 'autonomous', config: { appSecret: 'SUPER-SECRET' } });
  assert.throws(() => gateway.account(other, account), /account_not_found/);
  assert.throws(() => bot.thread(other, bot.create(owner, 'bot', 'private').id), /thread_not_found/);
  const pair = gateway.pair(owner, account);
  gateway.receive(account, [envelope('group', pair.command, { direct: false }), envelope('robot', pair.command, { human: false }), envelope('badpair', '/pair nope')]); await gateway.tick();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_bindings').get().n, 0);
  gateway.receive(account, [envelope('pair', pair.command)]); await gateway.tick();
  const binding = store.db.prepare('SELECT * FROM gateway_bindings WHERE account_id=?').get(account);
  assert.ok(binding); assert.equal(binding.context.includes('private-context'), false);
  assert.equal(JSON.stringify(gateway.list(owner)).includes('SUPER-SECRET'), false);
  assert.equal(store.db.prepare('SELECT config FROM gateway_accounts WHERE id=?').get(account).config.includes('SUPER-SECRET'), false);
  assert.equal(cfg.policy(owner, binding.thread_id).write, 'allow');
  cfg.save(owner, { ...cfg.get(owner, true), policy: { ...cfg.get(owner).policy, write: 'deny' } });
  assert.equal(cfg.policy(owner, binding.thread_id).write, 'deny');
  cfg.save(owner, { ...cfg.get(owner, true), policy: { ...cfg.get(owner).policy, write: 'ask' } });

  // Feishu dedupe is message_id, never event_id, and tenant/account namespaces remain distinct.
  const raw = { sender: { sender_type: 'user', sender_id: { open_id: 'me' }, tenant_key: 'tenant' }, message: { message_id: 'same-message', chat_type: 'p2p', chat_id: 'chat', message_type: 'text', content: '{"text":"course question"}' } };
  const before = countRuns();
  gateway.receive(account, [normalizeFeishu({ ...raw, event_id: 'event-a' }), normalizeFeishu({ ...raw, event_id: 'event-b' })]); await gateway.tick();
  assert.equal(countRuns() - before, 1);
  gateway.receive(account, [envelope('intruder', 'secret', { peer: 'someone-else' })]); await gateway.tick(); assert.equal(countRuns() - before, 1);
  gateway.receive(account, [envelope('wrong-tenant', 'secret', { tenant: 'other-tenant' }), envelope('wrong-chat', 'secret', { chat: 'other-chat' })]); await gateway.tick(); assert.equal(countRuns() - before, 1);
  const secondAccount = (await gateway.save(owner, { channel: 'feishu', agentId: 'agent', enabled: true, config: {} })).id;
  gateway.receive(secondAccount, [normalizeFeishu(raw)]); await gateway.tick();
  assert.equal(countRuns() - before, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_inbox WHERE external_id=?').get(JSON.stringify(['tenant', 'same-message'])).n, 2);

  // Exact approval ownership, conversation matching and one-shot resolution.
  const approvalMessage = bot.append(binding.thread_id, 'assistant', 'approval', 'run this exact operation');
  store.db.prepare('INSERT INTO approvals(id,thread_id,message_id,status,created_at) VALUES(?,?,?,?,?)').run('exact-approval', binding.thread_id, approvalMessage.id, 'pending', at);
  assert.equal(bot.resolve(other, 'exact-approval', true).error, 'approval_not_found');
  assert.equal(bot.resolve(owner, 'exact-approval', true, '', 'different-thread').error, 'approval_not_found');
  gateway.receive(account, [envelope('approve', '/approve exact-approval')]); await gateway.tick();
  assert.equal(store.db.prepare('SELECT status FROM approvals WHERE id=?').get('exact-approval').status, 'approved');
  assert.equal(bot.resolve(owner, 'exact-approval', true).error, 'approval_already_resolved');

  // ACK never waits for a model or attachment download, and stop bypasses a blocked media worker.
  let release;
  downloadGate = signal => new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  const started = performance.now(); gateway.receive(account, [envelope('media', 'read this', { attachments: [{ key: 'k', name: 'notes.txt', mime: 'text/plain' }] })]);
  assert.ok(performance.now() - started < 1000); assert.equal(downloads, 0);
  const work = gateway.tick(); await until(() => downloads > 0);
  const run = store.db.prepare("SELECT id FROM runs WHERE thread_id=? AND status='queued' LIMIT 1").get(binding.thread_id);
  gateway.receive(account, [envelope('stop', '/stop')]);
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id).status, 'cancelled');
  release(); await work; downloadGate = undefined;
  assert.equal(store.db.prepare("SELECT 1 FROM messages WHERE content LIKE '%Attachment fileId=%'").get(), undefined, 'stop must not enqueue a stale media-triggered run');
  gateway.receive(account, [envelope('media-after-stop', 'read new attachment', { attachments: [{ key: 'k2', name: 'notes.txt', mime: 'text/plain' }] })]); await gateway.tick();
  assert.ok(store.db.prepare("SELECT 1 FROM messages WHERE content LIKE '%Attachment fileId=%'").get());

  // Atomic inbox batch+cursor rollback simulates crash before commit.
  const { id: ilink } = await gateway.save(owner, { channel: 'ilink', agentId: 'agent', enabled: true, config: {} });
  store.db.exec(`CREATE TRIGGER simulate_crash BEFORE UPDATE OF cursor ON gateway_accounts WHEN NEW.cursor='crash' BEGIN SELECT RAISE(ABORT,'simulated crash'); END;`);
  assert.throws(() => gateway.receive(ilink, [envelope('batch-a'), envelope('batch-b')], 'crash'), /simulated crash/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_inbox WHERE account_id=?').get(ilink).n, 0);
  assert.equal(store.db.prepare('SELECT cursor FROM gateway_accounts WHERE id=?').get(ilink).cursor, null);
  store.db.exec('DROP TRIGGER simulate_crash');
  gateway.receive(ilink, [envelope('batch-a'), envelope('batch-b')], 'cursor-1');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_inbox WHERE account_id=?').get(ilink).n, 2);
  assert.equal(store.db.prepare('SELECT cursor FROM gateway_accounts WHERE id=?').get(ilink).cursor, 'cursor-1');
  const ilinkPair = gateway.pair(owner, ilink); gateway.receive(ilink, [envelope('ilink-pair', ilinkPair.command)]); await gateway.tick();
  const ilinkBinding = store.db.prepare('SELECT * FROM gateway_bindings WHERE account_id=?').get(ilink);
  assert.notEqual(ilinkBinding.thread_id, binding.thread_id);
  // iLink has no verified remote deduplication window: an unknown send cannot auto-replay.
  store.db.prepare("UPDATE gateway_outbox SET status='sent' WHERE status='pending'").run();
  gateway.enqueue(ilinkBinding.id, 'unknown-ilink', { text: 'result' });
  const ilinkDelivery = store.db.prepare("SELECT id FROM gateway_outbox WHERE binding_id=? AND status='pending'").get(ilinkBinding.id);
  failure = new DeliveryError('transport_result_unknown', true); await gateway.tick();
  assert.equal(store.db.prepare('SELECT status FROM gateway_outbox WHERE id=?').get(ilinkDelivery.id).status, 'uncertain');
  const sentCount = sent.length; await gateway.tick(); assert.equal(sent.length, sentCount);

  // Atomic event checkpoint projection; restart does not create new delivery IDs.
  bot.append(binding.thread_id, 'assistant', 'text', 'x'.repeat(3200)); gateway.project();
  const ids = store.db.prepare('SELECT id FROM gateway_outbox ORDER BY seq').all(); gateway.project(); assert.deepEqual(store.db.prepare('SELECT id FROM gateway_outbox ORDER BY seq').all(), ids);
  const queue = store.db.prepare("SELECT * FROM gateway_outbox WHERE status='pending' ORDER BY seq LIMIT 1").get();
  failure = new DeliveryError('rate_limited', false, 2500); await gateway.tick();
  const backed = store.db.prepare('SELECT * FROM gateway_outbox WHERE id=?').get(queue.id);
  assert.equal(backed.status, 'pending'); assert.ok(backed.next_at > Date.now());
  store.db.prepare('UPDATE gateway_outbox SET next_at=0 WHERE id=?').run(queue.id); await gateway.tick();
  assert.equal(sent.filter(s => s.id === queue.id).length, 2);
  store.db.prepare("UPDATE gateway_outbox SET status='sending' WHERE id=?").run(queue.id);
  await gateway.close(); gateway = new GatewayCore(store, cfg, bot, factories, files); gateway.start(false);
  assert.equal(store.db.prepare('SELECT status FROM gateway_outbox WHERE id=?').get(queue.id).status, 'uncertain');
  assert.throws(() => gateway.retry(owner, queue.id, false), /duplicate_risk/);
  gateway.retry(owner, queue.id, true); await gateway.tick();
  assert.equal(store.db.prepare('SELECT status FROM gateway_outbox WHERE id=?').get(queue.id).status, 'sent');

  // Fixed-interval reminders survive restart, use explicit IANA timezone, coalesce and cancel.
  const study = new StudyTools(store, cfg, files, async () => { throw new Error('no_network'); });
  store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,?,?,?)').run('direct-study-fixture', binding.thread_id, 'bot', 'cancelled', at);
  const ctx = { owner, thread: binding.thread_id, run: 'direct-study-fixture', step: 'reminder-1', signal: new AbortController().signal, checkActive() {}, append: (kind, text) => bot.append(binding.thread_id, 'assistant', kind, text) };
  const reminder = study.plugins.get('study_reminder');
  await assert.rejects(() => reminder.execute({ action: 'create', at: '2099-01-01T09:00:00', timezone: 'Asia/Shanghai', text: 'bad' }, ctx), /invalid_reminder/);
  await assert.rejects(() => reminder.execute({ action: 'create', at: '2099-01-01T09:00:00+08:00', timezone: 'Bad/Zone', text: 'bad' }, ctx));
  const r = await reminder.execute({ action: 'create', at: '2099-01-01T09:00:00+08:00', timezone: 'Asia/Shanghai', text: 'review', intervalSeconds: 86400 }, ctx);
  assert.equal(r.nextAt, '2099-01-01T01:00:00.000Z');
  store.db.prepare('UPDATE bot_reminders SET next_at=? WHERE id=?').run(Date.now() - 86400000 * 4, r.id);
  gateway.reminders(); gateway.reminders();
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE content LIKE '提醒%review'").get().n, 1);
  assert.equal((await reminder.execute({ action: 'cancel', id: r.id }, ctx)).cancelled, true);
  assert.equal((await reminder.execute({ action: 'cancel', id: r.id }, { ...ctx, owner: other })).cancelled, false);

  // Files are real owned blobs; text read and export execute rather than returning placeholders.
  const file = await receiveFile(store, files, owner, Readable.from(['mitochondria']), 'notes.txt', 'text/plain', 1024);
  const read = await study.plugins.get('study_file').execute({ fileId: file.id }, ctx); assert.equal(read.text, 'mitochondria');
  await assert.rejects(() => study.file(other, file.id), /file_not_found/);
  await assert.rejects(() => receiveFile(store, files, owner, Readable.from(['too long']), 'large.txt', 'text/plain', 2));
  const exported = await study.plugins.get('study_export').execute({ name: 'review.md', content: '# Review' }, ctx); assert.equal(Buffer.from((await study.file(owner, exported.fileId)).bytes).toString(), '# Review');
  await assert.rejects(() => study.plugins.get('study_manage').execute({ table: 'preferences', key: 'config', before: null, after: {} }, ctx), /table_not_available/);

  // Revoke makes pending messages and reminders inaccessible and cannot be undone by a replayed pair code.
  gateway.revoke(owner, account, binding.id); await new Promise(r => setTimeout(r, 5));
  const n = countRuns(); gateway.receive(account, [envelope('revoked', 'read secrets'), envelope('replayed-pair', pair.command)]); await gateway.tick(); assert.equal(countRuns(), n);
  assert.equal(store.db.prepare('SELECT revoked FROM gateway_bindings WHERE id=?').get(binding.id).revoked, 1);

  // Actual Bot tool loop -> persistent CloudTaskRunner -> executor commit -> status/result.
  const records = new CloudRecords(store), course = { id: 'course', name: 'Biology', size: 0, mimeType: 'video/mp4', duration: 60, createdAt: 1, status: 'transcribed' };
  records.apply(owner, [{ id: 'seed-course', table: 'videos', key: 'course', before: null, after: course }]);
  for (let i = 1; i <= 3; i++) records.apply(owner, [{ id: `seed-segment-${i}`, table: 'segments', key: i, before: null, after: { id: i, videoId: 'course', idx: i - 1, start: (i - 1) * 20, end: i * 20, text: 'A cell is the basic unit of life.', status: 1 } }]);
  const defaults = cfg.get(owner, true);
  cfg.save(owner, { ...defaults, providers: [{ id: 'mock', name: 'mock', baseUrl: 'https://model.invalid/v1', protocol: 'openai-chat', apiKey: 'test', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'mock', model: 'mock' }, policy: { ...defaults.policy, read: 'allow', write: 'allow' } });
  const learning = bot.create(owner, 'bot', 'learning', 'agent'); let turns = 0, taskId;
  runner = new BotRunner(store, { configuration: cfg, study, fetch: async (_url, init) => {
    const body = JSON.parse(init.body); turns++;
    if (turns === 1) return response('study_task', { action: 'create', kind: 'cards', courseId: 'course' });
    if (!taskId) taskId = store.db.prepare('SELECT id FROM cloud_tasks WHERE parent_run_id IS NOT NULL ORDER BY created_at DESC LIMIT 1').get().id;
    const task = store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(taskId);
    if (task.status !== 'completed') return response('wait', { seconds: 1, reason: 'Wait for durable child result' });
    assert.ok(body.tools.some(t => t.function.name === 'study_file'));
    return response('send_message', { kind: 'text', text: 'cards verified' });
  } });
  const service = new BotApplicationService(store, runner); const msg = service.send(owner, learning.id, { clientNonce: 'learning', content: 'create cards' });
  cloudRunner = new CloudTaskRunner(store, { configuration: cfg, filesDir: files, fetch: async (_url, init) => {
    const handout = JSON.parse(init.body).messages.some(m => typeof m.content === 'string' && m.content.includes('<course_source>'));
    return Response.json({ choices: [{ message: { role: 'assistant', content: handout ? '# Biology\nA cell is the basic unit of life.\n## Review\nWhat is a cell?' : '[{"time":"00:00","q":"Cell?","a":"Unit of life"}]' } }] });
  } });
  cloudRunner.start('http://127.0.0.1:1'); runner.start();
  await until(() => ['completed', 'failed', 'paused'].includes(store.db.prepare('SELECT status FROM runs WHERE trigger_message_id=?').get(msg.id)?.status));
  const learningState = store.db.prepare('SELECT status,error_code FROM runs WHERE trigger_message_id=?').get(msg.id);
  assert.equal(learningState.status, 'completed', learningState.error_code);
  const generatedCards = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='cards' AND value IS NOT NULL").all(owner).map(r => JSON.parse(r.value));
  assert.equal(generatedCards[0].a, 'Unit of life');
  const parent = store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(taskId); assert.ok(parent.parent_run_id && parent.parent_step_id);
  const handout = await study.plugins.get('study_task').execute({ action: 'create', kind: 'handout', courseId: 'course' }, { ...ctx, run: parent.parent_run_id, step: parent.parent_step_id });
  // Reusing a step is idempotent, never spawns an extra child.
  assert.equal(handout.id, taskId);
  const step = crypto.randomUUID(); store.db.prepare('INSERT INTO run_steps(id,run_id,tool,arguments,status,created_at) VALUES(?,?,?,?,?,?)').run(step, parent.parent_run_id, 'study_task', '{}', 'completed', at);
  const h = await study.plugins.get('study_task').execute({ action: 'create', kind: 'handout', courseId: 'course' }, { ...ctx, run: parent.parent_run_id, step });
  await until(() => store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(h.id).status === 'completed');
  const handoutResult = JSON.parse(store.db.prepare('SELECT result FROM cloud_tasks WHERE id=?').get(h.id).result);
  assert.equal(handoutResult.mode, 'text-source');
  assert.equal(records.get(owner, 'handouts', handoutResult.handoutId).blob.$file, handoutResult.fileId);
  const docx = await study.file(owner, handoutResult.fileId);
  assert.equal(Buffer.from(docx.bytes).subarray(0, 2).toString(), 'PK');
  const units = await readDocxUnits(new Blob([docx.bytes]));
  assert.match(JSON.stringify(units), /basic unit of life/);
  const docxRead = await study.plugins.get('study_file').execute({ fileId: handoutResult.fileId }, ctx);
  assert.match(docxRead.text, /basic unit of life/);
  const pdf = await receiveFile(store, files, owner, Readable.from([fs.readFileSync(new URL('./fixtures/sample-zh.pdf', import.meta.url))]), 'lecture.pdf', 'application/pdf', 20 * 1024 * 1024);
  const pdfRead = await study.plugins.get('study_file').execute({ fileId: pdf.id }, ctx);
  assert.ok(pdfRead.text.trim().length > 10);
  const image = await receiveFile(store, files, owner, Readable.from([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')]), 'diagram.png', 'image/png', 1024);
  store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES('vision-fixture',?,'bot','running',?)").run(binding.thread_id, at);
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
    cfg.save(owner, { ...cfg.get(owner, true), providers: [{ ...cfg.get(owner, true).providers[0], protocol }], visionModel: { providerId: 'mock', model: 'vision' } });
    const vision = new StudyTools(store, cfg, files, async (_url, init) => {
      const body = JSON.parse(init.body); assert.equal(body.model, 'vision'); assert.match(init.body, /iVBOR/);
      return Response.json(protocol === 'anthropic-messages' ? { content: [{ type: 'text', text: 'Cell diagram' }] } : protocol === 'openai-responses' ? { output: [{ content: [{ type: 'output_text', text: 'Cell diagram' }] }] } : { choices: [{ message: { content: 'Cell diagram' } }] });
    });
    assert.equal((await vision.plugins.get('study_file').execute({ fileId: image.id, question: 'Read this diagram' }, { ...ctx, run: 'vision-fixture' })).description, 'Cell diagram');
  }
  store.db.prepare("UPDATE runs SET status='completed' WHERE id='vision-fixture'").run();
  cfg.save(owner, { ...cfg.get(owner, true), providers: [{ ...cfg.get(owner, true).providers[0], protocol: 'openai-chat' }] });
  await assert.rejects(() => study.file(other, handoutResult.fileId), /file_not_found/);
  await assert.rejects(() => study.plugins.get('study_task').execute({ action: 'create', kind: 'cards', courseId: 'course' }, { ...ctx, owner: other }), /course_not_found/);
  await runner.close();
  // Exact learning operation approval is rechecked against current policy on resume.
  cfg.save(owner, { ...cfg.get(owner, true), policy: { ...cfg.get(owner).policy, write: 'ask' } });
  const approvalThread = bot.create(owner, 'bot', 'write approval', 'agent');
  let asked = false;
  runner = new BotRunner(store, { configuration: cfg, study, fetch: async () => {
    if (!asked) { asked = true; return response('study_manage', { table: 'videos', key: 'never-write', before: null, after: { id: 'never-write', name: 'denied' } }); }
    return response('send_message', { kind: 'text', text: 'denial respected' });
  } });
  const approvalService = new BotApplicationService(store, runner);
  const am = approvalService.send(owner, approvalThread.id, { clientNonce: 'ask-write', content: 'create course' }); runner.start();
  await until(() => store.db.prepare('SELECT status FROM runs WHERE trigger_message_id=?').get(am.id)?.status === 'waiting_user');
  const exact = store.db.prepare("SELECT * FROM approvals WHERE thread_id=? AND status='pending'").get(approvalThread.id);
  cfg.save(owner, { ...cfg.get(owner, true), policy: { ...cfg.get(owner).policy, write: 'deny' } });
  approvalService.resolve(owner, exact.id, true);
  await until(() => store.db.prepare('SELECT status FROM runs WHERE trigger_message_id=?').get(am.id)?.status === 'completed');
  assert.equal(records.get(owner, 'videos', 'never-write'), null);
  assert.match(store.db.prepare('SELECT result FROM run_steps WHERE id=?').get(exact.step_id).result, /denied/i);

  // Parent stop cancels a running child and expires its cloud permission.
  store.db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=?").run(h.id);
  store.db.prepare("INSERT INTO cloud_permissions(id,owner_id,task_id,capability,arguments,status,created_at) VALUES(?,?,?,?,?,'pending',?)").run('child-permit', owner, h.id, 'write', '{"exact":"args"}', at);
  await until(() => store.db.prepare('SELECT 1 FROM approvals WHERE cloud_permission_id=?').get('child-permit'));
  const linkedApproval = store.db.prepare('SELECT * FROM approvals WHERE cloud_permission_id=?').get('child-permit');
  assert.equal(approvalService.resolve(other, linkedApproval.id, true).error, 'approval_not_found');
  assert.equal(approvalService.resolve(owner, linkedApproval.id, true, '', 'wrong-thread').error, 'approval_not_found');
  approvalService.resolve(owner, linkedApproval.id, true);
  assert.equal(store.db.prepare('SELECT status FROM cloud_permissions WHERE id=?').get('child-permit').status, 'approved');
  assert.equal(approvalService.resolve(owner, linkedApproval.id, true).error, 'approval_already_resolved');
  // Even a completed parent may have live descendants: /stop must cancel those too.
  approvalService.stop(owner, learning.id);
  assert.equal(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(h.id).status, 'cancelled');
  assert.equal(store.db.prepare('SELECT status FROM cloud_permissions WHERE id=?').get('child-permit').status, 'expired');

  // Adapter protocol tests: no user accounts, no network, QR POST and cryptographic media roundtrip.
  assert.throws(() => tencentUrl('https://attacker.invalid'), /untrusted/); assert.throws(() => tencentUrl('https://127.0.0.1', true), /untrusted/);
  let encrypted, mediaRef;
  const ilinkPlugin = new IlinkPlugin(async () => ({ bytes: Buffer.from('encrypted study file'), name: 'study.txt', mime: 'text/plain' }), async (url, init) => {
    if (String(url).includes('get_bot_qrcode')) { assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body).local_token_list, []); assert.equal(init.headers.Authorization, undefined); return Response.json({ qrcode: 'qr-id', qrcode_img_content: 'https://weixin.qq.com/mock-qr' }); }
    if (String(url).includes('getuploadurl')) return Response.json({ ret: 0, upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload' });
    if (String(url).endsWith('/upload')) { encrypted = init.body; assert.equal(init.headers.Authorization, undefined); return new Response('', { headers: { 'x-encrypted-param': 'encrypted-param' } }); }
    if (String(url).includes('sendmessage')) { const b = JSON.parse(init.body); assert.equal(b.msg.client_id, 'stable-id'); mediaRef = b.msg.item_list[0].file_item.media; return Response.json({ ret: 0 }); }
    if (String(url).includes('/download')) return new Response(encrypted);
    throw new Error('unexpected URL');
  });
  const qr = await ilinkPlugin.login({}, { action: 'qr' }, new AbortController().signal); assert.match(qr.qrDataUrl, /^data:image\/png;base64,/);
  await ilinkPlugin.send({ botToken: 'token' }, envelope('x'), { text: '', fileId: file.id }, 'stable-id', new AbortController().signal);
  const normalized = normalizeIlink({ message_id: 1, from_user_id: 'me', message_type: 1, item_list: [{ type: 4, file_item: { file_name: 'study.txt', media: mediaRef } }] });
  const downloaded = await ilinkPlugin.download({}, normalized, normalized.attachments[0], new AbortController().signal); assert.equal(Buffer.from(downloaded.bytes).toString(), 'encrypted study file');
  const feishu = new FeishuPlugin(async () => { throw new Error('unused'); }, async (url, init) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'token' });
    assert.equal(JSON.parse(init.body).uuid, 'fixed-feishu-id'); return new Response('', { status: 429, headers: { 'retry-after': '3' } });
  });
  await assert.rejects(() => feishu.send({}, envelope('x'), { text: 'hello' }, 'fixed-feishu-id', new AbortController().signal), e => e instanceof DeliveryError && e.retryAfterMs === 3000);
  let pollCount = 0, health;
  const polling = new IlinkPlugin(async () => { throw new Error('unused'); }, async (_url, init) => {
    pollCount++; const body = JSON.parse(init.body); assert.equal(init.headers.Authorization, 'Bearer private-token');
    if (pollCount === 1) { assert.equal(body.get_updates_buf, 'old'); return Response.json({ ret: 0, msgs: [{ message_id: 10, from_user_id: 'me', message_type: 1 }], get_updates_buf: 'new' }); }
    assert.equal(body.get_updates_buf, 'new'); return Response.json({ ret: -14 });
  });
  let cursor = 'old', accepted = 0;
  await polling.start({ botToken: 'private-token' }, { signal: new AbortController().signal, cursor: () => cursor, receive: (batch, next) => { accepted += batch.length; cursor = next; }, health: state => { health = state; }, updateConfig() {} });
  assert.equal(accepted, 1); assert.equal(health, 'login_required'); assert.equal(pollCount, 2);
  console.log('Gateway: binding/ownership/deny/revoke, dedupe, fast ACK + stop, atomic cursor, projection/checkpoint, stable retry/429/uncertain restart, reminders/timezone, owned file execution, Bot child cards/handout chain, QR/CDN crypto and Feishu protocol passed');
} finally { await gateway.close(); await runner?.close(); await cloudRunner?.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
