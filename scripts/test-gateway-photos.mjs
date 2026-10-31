import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { MAX_BOT_MESSAGE_ATTACHMENTS } from '@wangke/contracts';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';
import { GatewayCore } from '../apps/api/src/gateway/core.ts';
import { IlinkPlugin } from '../apps/api/src/gateway/adapters/ilink.ts';
import { photoBatch, PHOTO_QUIET_MS, PHOTO_MAX_WAIT_MS } from '../apps/api/src/gateway/photo-batch.ts';

const message = (id, text = '', patch = {}) => ({ messageId: String(id), tenant: '', peer: 'me', chat: 'me', topic: '', direct: true, human: true, context: `context-${id}`, text, ...patch });
const photo = (id, text = '', patch = {}) => message(id, text, { attachments: [{ key: String(id), name: `${id}.png`, mime: 'image/png' }], ...patch });
const item = (id, received_at, m = photo(id)) => ({ id, received_at, message: m });
const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).png().toBuffer();
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('photo burst waits for quiet through long uploads, up to 99 images; text and controls stay isolated', () => {
  assert.equal(photoBatch([item(1, 0)], 1999).ready, false);
  assert.equal(photoBatch([item(1, 0)], PHOTO_QUIET_MS).ready, true);
  const continuous = Array.from({ length: 7 }, (_, i) => item(i + 1, i * 1200));
  assert.equal(photoBatch(continuous, 7900).ready, false);
  assert.equal(photoBatch(continuous, 8000).ready, false);
  assert.equal(photoBatch([...continuous, item(8, 8100)], 8100).items.length, 8);
  assert.equal(photoBatch([item(1, 0), item(2, PHOTO_MAX_WAIT_MS + 1)], PHOTO_MAX_WAIT_MS + 1).items.length, 1);
  assert.equal(photoBatch(Array.from({ length: MAX_BOT_MESSAGE_ATTACHMENTS + 1 }, (_, i) => item(i + 1, 0)), 0).items.length, 99);
  const source = item(1, 0);
  for (const m of [photo(2, '', { peer: 'other' }), photo(2, '', { chat: 'other' }), photo(2, '', { topic: 'other' }), photo(2, '', { tenant: 'other' }), message(2, '/status'), message(2, '/stop'), message(2, '同意'), message(2, 'yes', { approvalReply: { id: 'approval' } }), message(2, '', { attachments: [{ key: 'pdf', mime: 'application/pdf' }] })]) {
    const result = photoBatch([source, item(2, 100, m)], 100);
    assert.deepEqual(result.items, [source]); assert.equal(result.ready, true);
  }
  const result = photoBatch([source, item(2, 100, message(2, '一起总结')), item(3, 200, message(3, '另一个问题'))], 200);
  assert.deepEqual(result.items.map(i => i.id), [1, 2, 3]); assert.equal(result.ready, false);
  const overtaken = photoBatch([source, item(2, 100, message(2, '一起总结')), item(3, 200)], 200);
  assert.deepEqual(overtaken.items.map(i => i.id), [1, 2, 3]); assert.equal(overtaken.ready, false);
  assert.equal(photoBatch([source, item(2, PHOTO_QUIET_MS + 100)], PHOTO_QUIET_MS + 100).items.length, 1);
  assert.equal(photoBatch([source, item(2, 100, message(2, '开始'))], 100).ready, true);
});

test('runtime progress projects only marked image milestones to WeChat', async t => {
  const f = await fixture(t);
  f.bot.append(f.account.thread, 'assistant', 'progress', '正在收集图片，可以继续发送。', 'web:status:collecting:test');
  f.bot.append(f.account.thread, 'assistant', 'progress', '正在读取这批图片，请稍候。', 'im:status:test:image-reading');
  f.bot.append(f.account.thread, 'assistant', 'progress', '内部工具进度', 'bot:test:progress');
  await f.gateway.tick();
  assert.deepEqual(f.sent.filter(p => p.text.includes('图片')).map(p => p.text), ['正在读取这批图片，请稍候。']);
  assert.equal(f.sent.some(p => p.text === '内部工具进度'), false);
});

async function fixture(t) {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-photos-'));
  const files = path.join(directory, 'files'); fs.mkdirSync(files);
  const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const secrets = new CloudConfiguration(store, path.join(directory, 'config'));
  const at = new Date().toISOString();
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run('owner', 'owner', at);
  store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('agent', 'owner', 'Bot', 'study', 'Study', at, at);
  const bot = new BotApplicationService(store, { enqueue() {}, cancel() {} });
  const downloads = [], sent = [], hooks = {};
  const gateway = new GatewayCore(store, secrets, bot, { ilink: () => ({
    manifest: new IlinkPlugin(async () => {}).manifest,
    validate() {}, async start(_c, ctx) { ctx.health('connected'); }, async stop() {},
    async send(_c, _peer, payload, id) { sent.push(payload); return id; },
    async download(_c, _m, attachment, signal) {
      downloads.push(attachment.key); await hooks.download?.(attachment, signal);
      return { bytes: png, name: attachment.name, mime: 'image/png' };
    },
  }) }, files);
  t.after(async () => { await gateway.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const addAccount = async name => {
    const { id } = await gateway.save('owner', { channel: 'ilink', agentId: 'agent', enabled: true, config: { botId: name, botToken: name } });
    gateway.receive(id, [message('pair', gateway.pair('owner', id).command)]); await gateway.tick();
    return { id, ...store.db.prepare('SELECT id AS binding,thread_id AS thread FROM gateway_bindings WHERE account_id=?').get(id) };
  };
  const account = await addAccount('one');
  const countRuns = () => store.db.prepare('SELECT COUNT(*) n FROM runs').get().n;
  const userMessages = (thread = account.thread) => store.db.prepare("SELECT * FROM messages WHERE thread_id=? AND role='user' ORDER BY seq").all(thread);
  const statuses = () => store.db.prepare("SELECT status FROM gateway_inbox WHERE external_id NOT LIKE '%pair%' ORDER BY id").all().map(r => r.status);
  return { store, secrets, bot, gateway, account, files, downloads, sent, hooks, countRuns, userMessages, statuses, addAccount, advance(ms) { clock += ms; } };
}

test('eight images across polls yield one owned attachment envelope and one run; replay is inert', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 8; i++) {
    f.gateway.receive(f.account.id, [photo(i)], `cursor-${i}`);
    await f.gateway.tick(); assert.equal(f.countRuns(), 0);
    f.advance(150);
  }
  // Retransmission must not reset the quiet window or duplicate a photo.
  f.gateway.receive(f.account.id, [photo(8)]);
  f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  assert.equal(f.countRuns(), 1); assert.equal(f.userMessages().length, 1);
  const payload = JSON.parse(f.userMessages()[0].content);
  assert.deepEqual(payload.attachments.map(a => a.originalName), Array.from({ length: 8 }, (_, i) => `${i + 1}.png`));
  assert.equal(new Set(payload.attachments.map(a => a.fileId)).size, 8);
  assert.deepEqual(f.statuses(), Array(8).fill('done'));
  assert.equal(f.secrets.open(f.store.db.prepare('SELECT context FROM gateway_bindings WHERE id=?').get(f.account.binding).context), 'context-8');
  f.gateway.receive(f.account.id, Array.from({ length: 8 }, (_, i) => photo(i + 1))); await f.gateway.tick();
  assert.equal(f.countRuns(), 1); assert.equal(f.downloads.length, 8);
});

test('eight photos in one poll include the following caption without an extra task', async t => {
  const f = await fixture(t);
  f.gateway.receive(f.account.id, Array.from({ length: 8 }, (_, i) => photo(i + 1, i === 0 ? '第一页开始' : '')));
  await f.gateway.tick(); assert.equal(f.countRuns(), 0);
  f.advance(500); f.gateway.receive(f.account.id, [message('caption', '这八张一起总结')]); await f.gateway.tick();
  assert.equal(f.countRuns(), 0);
  f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  assert.equal(f.countRuns(), 1);
  assert.equal(JSON.parse(f.userMessages()[0].content).caption, '第一页开始\n这八张一起总结');
  assert.deepEqual(f.statuses(), Array(9).fill('done'));
});

test('text-first and multi-text bursts stay in arrival order with the following images', async t => {
  const f = await fixture(t);
  f.gateway.receive(f.account.id, [
    message('text-1', '先看这些图'),
    photo(1),
    message('text-2', '重点看标题和表格'),
    photo(2),
    message('text-3', '最后给出结论'),
  ]);
  await f.gateway.tick(); assert.equal(f.countRuns(), 0);
  f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  assert.equal(f.countRuns(), 1);
  const input = JSON.parse(f.userMessages()[0].content);
  assert.deepEqual(input.caption, '先看这些图\n重点看标题和表格\n最后给出结论');
  assert.deepEqual(input.attachments.map(a => a.originalName), ['1.png', '2.png']);
  assert.deepEqual(f.statuses(), Array(5).fill('done'));
});

test('pending photo batches survive a gateway restart and do not delay another account', async t => {
  const f = await fixture(t), other = await f.addAccount('two');
  f.gateway.receive(f.account.id, [photo(1), photo(2)]);
  f.gateway.receive(other.id, [message('question', '直接回答')]); await f.gateway.tick();
  assert.equal(f.userMessages().length, 0); assert.equal(f.userMessages(other.thread).length, 1);
  await f.gateway.close(); f.gateway.start(false);
  f.advance(300); f.gateway.receive(f.account.id, [photo(3)]); await f.gateway.tick();
  assert.equal(f.userMessages().length, 0);
  f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  assert.equal(f.countRuns(), 2); assert.equal(JSON.parse(f.userMessages()[0].content).attachments.length, 3);
  assert.equal(f.userMessages(other.thread).length, 1);
});

test('stop during accumulation cancels the whole batch without starting a run', async t => {
  const f = await fixture(t);
  f.gateway.receive(f.account.id, [photo(1), photo(2)]); await f.gateway.tick();
  f.gateway.receive(f.account.id, [message('stop', '/stop')]);
  f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  assert.equal(f.countRuns(), 0); assert.equal(f.downloads.length, 0);
  assert.deepEqual(f.statuses(), ['cancelled', 'cancelled', 'done']);
});

test('stop during download aborts all batch members and publishes no partial photo reply', async t => {
  const f = await fixture(t), started = deferred(), release = deferred();
  let downloadSignal;
  f.hooks.download = async (_a, signal) => { downloadSignal = signal; started.resolve(); await release.promise; };
  f.gateway.receive(f.account.id, [photo(1), photo(2)]); f.advance(PHOTO_QUIET_MS);
  const tick = f.gateway.tick(); await started.promise;
  f.gateway.receive(f.account.id, [message('stop', '/stop')]);
  assert.equal(downloadSignal.aborted, true); release.resolve(); await tick;
  assert.equal(f.countRuns(), 0); assert.equal(f.userMessages().length, 0);
  assert.deepEqual(f.statuses(), ['cancelled', 'cancelled', 'done']);
});

test('download failure marks the entire batch failed, never runs on an incomplete subset', async t => {
  const f = await fixture(t);
  f.hooks.download = a => { if (a.key === '2') throw new Error('download failed'); };
  f.gateway.receive(f.account.id, [photo(1), photo(2), photo(3)]); f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  assert.equal(f.countRuns(), 0); assert.equal(f.userMessages().length, 0);
  assert.deepEqual(f.statuses(), ['failed', 'failed', 'failed']);
});

test('nine photos remain one request instead of splitting at the former eight-image limit', async t => {
  const f = await fixture(t);
  f.gateway.receive(f.account.id, Array.from({ length: 9 }, (_, i) => photo(i + 1))); await f.gateway.tick();
  assert.equal(f.countRuns(), 0);
  f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  assert.equal(f.countRuns(), 1);
  assert.deepEqual(f.userMessages().map(m => JSON.parse(m.content).attachments.length), [9]);
  assert.equal(f.downloads.length, 9);
});

test('99 separate uploads spanning more than eight seconds, with an overtaking caption, remain one turn', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 99; i++) {
    f.gateway.receive(f.account.id, [photo(i)]);
    if (i === 95) f.gateway.receive(f.account.id, [message('caption', '请读完再回答')]);
    await f.gateway.tick(); assert.equal(f.countRuns(), 0);
    f.advance(150);
  }
  f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  assert.equal(f.countRuns(), 1);
  const input = JSON.parse(f.userMessages()[0].content);
  assert.equal(input.attachments.length, 99); assert.equal(input.caption, '请读完再回答');
  assert.deepEqual(input.attachments.map(a => a.originalName), Array.from({ length: 99 }, (_, i) => `${i + 1}.png`));
  assert.deepEqual(f.statuses(), Array(100).fill('done'));
});

function reply(protocol, text, truncated = false) {
  if (protocol === 'anthropic-messages') return Response.json({ stop_reason: truncated ? 'max_tokens' : 'end_turn', content: [{ type: 'text', text }] });
  if (protocol === 'openai-responses') return Response.json({ status: truncated ? 'incomplete' : 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
  return Response.json({ choices: [{ finish_reason: truncated ? 'length' : 'stop', message: { content: text } }] });
}

function imageRunner(f, protocol = 'openai-chat', hook) {
  f.secrets.save('owner', { ...f.secrets.get('owner', true), providers: [{ id: 'test', name: 'Test', baseUrl: 'https://offline.invalid', apiKey: 'test', protocol, serves: ['chat', 'vision'] }], llmModel: { providerId: 'test', model: 'chat' }, visionModel: { providerId: 'test', model: 'vision' } });
  const requests = [], readings = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'vision') {
      const index = Number(/Image (\d+) of/.exec(JSON.stringify(body))?.[1]);
      readings.push(index);
      const result = await hook?.(index, init.signal);
      return result ?? reply(protocol, `读图结果：第 ${index} 张。`);
    }
    requests.push(body);
    return reply(protocol, '合并后的回复。');
  };
  const study = new StudyTools(f.store, f.secrets, f.files, fetch);
  return { requests, readings, runner: new BotRunner(f.store, { configuration: f.secrets, study, fetch }) };
}

async function until(condition) {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for image pipeline');
}

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) test(`${protocol}: every image is read before the first answer request; one final delivery`, async t => {
  const f = await fixture(t);
  const count = protocol === 'openai-chat' ? 99 : 8;
  const photos = Array.from({ length: count }, (_, i) => photo(i + 1).attachments[0]);
  f.gateway.receive(f.account.id, [photo('a', '', { attachments: photos.slice(0, 4) }), photo('b', '', { attachments: photos.slice(4) }), message('caption', '把这些图放在一起分析')]);
  f.advance(PHOTO_QUIET_MS);
  await f.gateway.tick();
  const payload = JSON.parse(f.userMessages()[0].content);
  assert.equal(payload.attachments.length, count);
  const release = deferred();
  const { runner, requests, readings } = imageRunner(f, protocol, async index => {
    if (index === count) await release.promise;
  });
  try {
    runner.start();
    await until(() => new Set(readings).size >= count - 1 || ['completed', 'failed', 'paused'].includes(f.store.db.prepare('SELECT status FROM runs').get().status));
    assert.ok(new Set(readings).size >= count - 1, JSON.stringify(f.store.db.prepare('SELECT status,error_code FROM runs').get()));
    assert.equal(requests.length, 0, 'no answer generation while the last image is still being read');
    assert.deepEqual(f.sent.filter(p => p.text === '合并后的回复。'), []);
    release.resolve();
    await until(() => ['completed', 'failed', 'paused'].includes(f.store.db.prepare('SELECT status FROM runs').get().status));
    assert.equal(f.store.db.prepare('SELECT status FROM runs').get().status, 'completed', JSON.stringify(f.store.db.prepare('SELECT error_code FROM runs').get()));
    await f.gateway.tick();
    assert.equal(f.countRuns(), 1); assert.equal(requests.length, 1);
    const request = JSON.stringify(requests[0]);
    assert.ok(request.includes('把这些图放在一起分析'));
    for (const file of payload.attachments) assert.ok(request.includes(file.fileId));
    for (let i = 1; i <= count; i++) assert.ok(request.includes(`读图结果：第 ${i} 张。`));
    assert.deepEqual([...readings].sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i + 1));
    assert.deepEqual(f.sent.filter(p => p.text === '合并后的回复。'), [{ text: '合并后的回复。' }]);
  } finally { release.resolve(); await runner.close(); }
});

for (const failure of ['empty', 'truncated', 'denied']) test(`${failure} image reading produces an honest failure notice, never a partial answer`, async t => {
  const f = await fixture(t);
  f.gateway.receive(f.account.id, [photo(1), photo(2)]); f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  const { runner, requests, readings } = imageRunner(f, 'openai-chat', index => index === 2 ? reply('openai-chat', failure === 'empty' ? '' : '不完整的内容', failure === 'truncated') : undefined);
  if (failure === 'denied') f.secrets.save('owner', { ...f.secrets.get('owner', true), policy: { ...f.secrets.get('owner', true).policy, read: 'deny' } });
  try {
    runner.start();
    await until(() => ['completed', 'failed', 'paused'].includes(f.store.db.prepare('SELECT status FROM runs').get().status));
    const run = f.store.db.prepare('SELECT status,error_code FROM runs').get();
    assert.deepEqual(run, { status: 'failed', error_code: 'wechat_image_read_failed' });
    assert.equal(requests.length, 0);
    if (failure === 'denied') assert.equal(readings.length, 0);
    await f.gateway.tick();
    assert.ok(f.sent.at(-1).text.includes('这批图片还没读完'));
    assert.ok(f.sent.at(-1).text.includes('2'));
  } finally { await runner.close(); }
});

test('stop while vision is reading prevents synthesis and late replies', async t => {
  const f = await fixture(t), started = deferred();
  f.gateway.receive(f.account.id, [photo(1), photo(2)]); f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  const { runner, requests } = imageRunner(f, 'openai-chat', async (index, signal) => {
    if (index !== 2) return;
    started.resolve();
    await new Promise((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  });
  try {
    runner.start(); await started.promise;
    f.gateway.receive(f.account.id, [message('stop-reading', '/stop')]);
    await runner.close(); await f.gateway.tick();
    assert.equal(f.store.db.prepare('SELECT status FROM runs').get().status, 'cancelled');
    assert.equal(requests.length, 0);
    assert.ok(!f.sent.some(p => p.text === '合并后的回复。'));
  } finally { await runner.close(); }
});

test('budget pause and runner restart reuse sixteen completed reads before reading the remaining image', async t => {
  const f = await fixture(t);
  f.gateway.receive(f.account.id, Array.from({ length: 17 }, (_, i) => photo(i + 1))); f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  const first = imageRunner(f);
  f.secrets.save('owner', { ...f.secrets.get('owner', true), policy: { ...f.secrets.get('owner', true).policy, maxSteps: 16 } });
  try {
    first.runner.start();
    await until(() => f.store.db.prepare('SELECT status FROM runs').get().status !== 'running' && f.store.db.prepare('SELECT status FROM runs').get().status !== 'queued');
    assert.equal(f.store.db.prepare('SELECT status FROM runs').get().status, 'paused');
    assert.equal(first.readings.length, 16); assert.equal(first.requests.length, 0);
  } finally { await first.runner.close(); }
  const second = imageRunner(f);
  f.secrets.save('owner', { ...f.secrets.get('owner', true), policy: { ...f.secrets.get('owner', true).policy, maxSteps: 100 } });
  f.store.db.prepare("UPDATE runs SET status='queued',error_code=NULL").run();
  try {
    second.runner.start();
    await until(() => ['completed', 'failed', 'paused'].includes(f.store.db.prepare('SELECT status FROM runs').get().status));
    assert.equal(f.store.db.prepare('SELECT status FROM runs').get().status, 'completed');
    assert.deepEqual(second.readings, [17]); assert.equal(second.requests.length, 1);
    const evidence = JSON.stringify(second.requests[0]);
    for (let i = 1; i <= 17; i++) assert.ok(evidence.includes(`读图结果：第 ${i} 张。`), `missing image ${i}`);
  } finally { await second.runner.close(); }
});

test('image preprocessing respects configured read approval before invoking vision', async t => {
  const f = await fixture(t);
  f.gateway.receive(f.account.id, [photo(1)]); f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  const { runner, requests, readings } = imageRunner(f);
  f.secrets.save('owner', { ...f.secrets.get('owner', true), policy: { ...f.secrets.get('owner', true).policy, read: 'ask' } });
  try {
    runner.start();
    await until(() => f.store.db.prepare('SELECT status FROM runs').get().status === 'waiting_user');
    assert.equal(readings.length, 0); assert.equal(requests.length, 0);
    const approval = f.store.db.prepare("SELECT id FROM approvals WHERE status='pending'").get();
    f.bot.resolve('owner', approval.id, true, 'approve', f.account.thread);
    await until(() => ['completed', 'failed', 'paused'].includes(f.store.db.prepare('SELECT status FROM runs').get().status));
    assert.equal(f.store.db.prepare('SELECT status FROM runs').get().status, 'completed');
    assert.deepEqual(readings, [1]); assert.equal(requests.length, 1);
  } finally { await runner.close(); }
});

test('a new burst arriving during download stays ordered and keeps its own quiet window', async t => {
  const f = await fixture(t), started = deferred(), release = deferred();
  f.hooks.download = async a => { if (a.key === '1') { started.resolve(); await release.promise; } };
  f.gateway.receive(f.account.id, [photo(1), photo(2)]); f.advance(PHOTO_QUIET_MS);
  const tick = f.gateway.tick(); await started.promise;
  f.advance(100); f.gateway.receive(f.account.id, [photo(3), photo(4)]);
  release.resolve(); await tick;
  await f.gateway.tick();
  assert.equal(f.countRuns(), 1);
  assert.deepEqual(f.statuses(), ['done', 'done', 'pending', 'pending']);
  f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  assert.deepEqual(f.userMessages().map(m => JSON.parse(m.content).attachments.map(a => a.originalName)), [['1.png', '2.png'], ['3.png', '4.png']]);
  assert.equal(f.downloads.length, 4);
});

test('batch publication rolls back as a unit; recovery reuses saved files and stable message identity', async t => {
  const f = await fixture(t);
  f.gateway.receive(f.account.id, [photo(1), photo(2)]);
  const last = f.store.db.prepare("SELECT MAX(id) id FROM gateway_inbox WHERE status='pending'").get().id;
  f.store.db.exec(`CREATE TRIGGER fail_photo_commit BEFORE UPDATE OF status ON gateway_inbox WHEN NEW.id=${last} AND NEW.status='done' BEGIN SELECT RAISE(ABORT, 'test commit failure'); END`);
  f.advance(PHOTO_QUIET_MS); await f.gateway.tick();
  assert.equal(f.countRuns(), 0); assert.equal(f.userMessages().length, 0);
  assert.deepEqual(f.statuses(), ['failed', 'failed']);
  const ids = f.store.db.prepare('SELECT id FROM files ORDER BY id').all();
  f.store.db.exec('DROP TRIGGER fail_photo_commit');
  f.store.db.prepare("UPDATE gateway_inbox SET status='pending',error=NULL WHERE status='failed'").run();
  await f.gateway.tick();
  assert.equal(f.countRuns(), 1); assert.equal(f.userMessages().length, 1);
  assert.deepEqual(f.statuses(), ['done', 'done']);
  assert.deepEqual(f.store.db.prepare('SELECT id FROM files ORDER BY id').all(), ids);
  assert.equal(f.downloads.length, 2);
});
