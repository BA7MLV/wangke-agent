import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import sharp from 'sharp';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { receiveFile, fileOperationId } from '../apps/api/src/cloud/files.ts';
import { safeFileName, imageFileName } from '../apps/api/src/cloud/file-names.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';
import { importBotAttachments } from '../apps/api/src/projects/attachments.ts';
import { normalizeFeishu } from '../apps/api/src/gateway/adapters/feishu.ts';
import { normalizeIlink } from '../apps/api/src/gateway/adapters/ilink.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { GatewayCore } from '../apps/api/src/gateway/core.ts';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-names-'));
  const store = new DatabaseStore(path.join(root, 'db.sqlite'));
  const files = path.join(root, 'files'); fs.mkdirSync(files);
  const owner = crypto.randomUUID(), other = crypto.randomUUID(), at = new Date().toISOString();
  for (const id of [owner, other]) store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, id, at);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, files, owner, other, at };
}
const image = format => sharp({ create: { width: 3, height: 2, channels: 3, background: 'white' } })[format]().toBuffer();

test('portable readable names preserve Unicode, valid extensions and byte limits', () => {
  assert.equal(safeFileName('函数分析.png'), '函数分析.png');
  assert.equal(safeFileName('../a\\b\n.png'), '.._a_b_.png');
  assert.equal(safeFileName('CON.jpg'), '_CON.jpg');
  assert.equal(safeFileName('...'), 'Attachment');
  assert.equal(safeFileName('a\u202egpj.exe'), 'a_gpj.exe');
  const long = safeFileName('😀中文'.repeat(100) + '.jpeg');
  assert.ok(Buffer.byteLength(long) <= 240);
  assert.ok(!long.includes('\ufffd'));
  assert.ok(long.endsWith('.jpeg'));
  assert.equal(imageFileName('课程截图.jpg', 'image/png', '图片'), '课程截图.png');
  assert.equal(imageFileName('原图.JPEG', 'image/jpeg', '图片'), '原图.JPEG');
});

test('image uploads sniff actual bytes, preserve blobs/IDs, and normalize only display names', async t => {
  const f = fixture(t);
  for (const format of ['png', 'jpeg', 'gif', 'webp']) {
    const bytes = await image(format);
    const upload = await receiveFile(f.store, f.files, f.owner, Readable.from([bytes.subarray(0, 2), bytes.subarray(2, 7), bytes.subarray(7)]), '课程截图.data', 'application/octet-stream', 10000);
    assert.equal(upload.mimeType, `image/${format}`);
    assert.equal(upload.originalName, `课程截图.${format === 'jpeg' ? 'jpg' : format}`);
    assert.deepEqual(fs.readFileSync(path.join(f.files, `${upload.id}.bin`)), bytes, 'original bytes must not be transcoded');
    assert.equal(upload.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  }
  const bytes = await image('png');
  const id = fileOperationId(f.owner, 'step', 'workspace');
  const upload = await receiveFile(f.store, f.files, f.owner, Readable.from([bytes]), '', 'image/jpeg', 10000, undefined, () => {}, id);
  assert.match(upload.originalName, /^图片_\d{8}_[a-f0-9]{8}\.png$/);
  const retry = await receiveFile(f.store, f.files, f.owner, Readable.from(['not replayed']), 'different.txt', 'text/plain', 10000, undefined, () => {}, id);
  assert.deepEqual(retry, upload, 'same operation reuses its snapshot');
  await assert.rejects(receiveFile(f.store, f.files, f.other, Readable.from([bytes]), 'private.png', 'image/png', 10000, undefined, () => {}, id), /not_owned/);
  const other = await receiveFile(f.store, f.files, f.other, Readable.from([bytes]), '课程截图.png', 'image/png', 10000);
  assert.notEqual(other.id, upload.id, 'no cross-owner content deduplication');
  const before = fs.readdirSync(f.files);
  for (const invalid of [Buffer.from('not an image'), bytes.subarray(0, 24)]) {
    await assert.rejects(receiveFile(f.store, f.files, f.owner, Readable.from([invalid]), 'fake.png', 'application/octet-stream', 10000), /invalid_image_format/);
  }
  assert.deepEqual(fs.readdirSync(f.files), before, 'rejected uploads leave no blobs or staging files');
  const cache = await receiveFile(f.store, f.files, f.owner, Readable.from([bytes]), 'cache-blob', 'application/octet-stream', 10000);
  assert.equal(cache.originalName, 'cache-blob');
  assert.equal(cache.mimeType, 'application/octet-stream', 'opaque application cache must not become a visible image');
});

test('attachment import preserves readable names, numbers collisions, and never resurrects moved files', async t => {
  const f = fixture(t);
  const projects = new ProjectRepository(f.store, path.join(f.files, 'projects'));
  const workspace = projects.botWorkspace(f.owner);
  const thread = crypto.randomUUID();
  f.store.db.prepare("INSERT INTO threads(id,owner_id,mode,created_at,updated_at) VALUES(?,?,'bot',?,?)").run(thread, f.owner, f.at, f.at);
  const bytes = await image('png');
  const uploads = [];
  for (let seq = 1; seq <= 2; seq++) {
    const upload = await receiveFile(f.store, f.files, f.owner, Readable.from([bytes]), '中文原图.jpg', 'image/jpeg', 10000);
    uploads.push(upload);
    f.store.db.prepare("INSERT INTO messages(id,thread_id,seq,role,kind,content,created_at) VALUES(?,?,?,'user','attachment',?,?)").run(crypto.randomUUID(), thread, seq, JSON.stringify({ fileId: upload.id, name: upload.originalName }), f.at);
  }
  importBotAttachments(projects, f.files, f.owner);
  assert.deepEqual(projects.files.list(workspace).map(f => f.name), ['中文原图 (2).png', '中文原图.png'].sort((a, b) => a.localeCompare(b)));
  const first = projects.files.list(workspace).find(f => f.name === '中文原图.png');
  projects.files.move(workspace, first.path, workspace, '用户改名.png', first.revision);
  importBotAttachments(projects, f.files, f.owner);
  assert.ok(projects.files.list(workspace).some(f => f.name === '用户改名.png'));
  assert.ok(!projects.files.list(workspace).some(f => f.name === '中文原图.png'));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM resource_attachments WHERE status=?').get('done').n, 2);
});

test('no-original-name IM images stay unnamed until actual format is known', () => {
  const feishu = normalizeFeishu({ message: { message_type: 'image', content: '{"image_key":"key"}' } });
  assert.equal(feishu.attachments[0].name, '');
  const ilink = normalizeIlink({ item_list: [{ image_item: { media: {} } }] });
  assert.equal(ilink.attachments[0].name, '');
  assert.equal(normalizeIlink({ item_list: [{ file_item: { file_name: '原图.jpeg', media: {} } }] }).attachments[0].name, '原图.jpeg');
});

test('IM retry after a partial download/restart reuses stable named snapshots, not duplicate blobs', async t => {
  const f = fixture(t);
  f.store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('agent', f.owner, 'Bot', 'assistant', '', f.at, f.at);
  const configuration = new CloudConfiguration(f.store, path.join(f.root, 'config'));
  const bot = new BotApplicationService(f.store, { enqueue() {}, cancel() {} });
  const png = await image('png'), downloads = new Map(); let fail = true;
  const factory = () => ({
    manifest: { id: 'feishu', version: 1, name: '飞书', capabilities: { direct: true, groups: false, files: true, images: true, proactive: 'yes', deduplicationWindowMs: 3600000 } },
    validate() {}, async start(_c, ctx) { ctx.health('connected'); }, async stop() {}, async send() { return 'sent'; },
    async download(_c, _m, attachment) {
      downloads.set(attachment.key, (downloads.get(attachment.key) ?? 0) + 1);
      if (attachment.key === 'second' && fail) { fail = false; throw new Error('temporary failure'); }
      return { bytes: png, name: '', mime: 'image/png' };
    },
  });
  let gateway = new GatewayCore(f.store, configuration, bot, { feishu: factory }, f.files);
  const envelope = (messageId, text, attachments = []) => ({ messageId, text, attachments, tenant: 'tenant', peer: 'me', chat: 'chat', topic: '', direct: true, human: true });
  try {
    gateway.start(false);
    const account = (await gateway.save(f.owner, { channel: 'feishu', agentId: 'agent', enabled: true, config: {} })).id;
    gateway.receive(account, [envelope('pair', gateway.pair(f.owner, account).command)]); await gateway.tick();
    gateway.receive(account, [envelope('photos', '两张图片', [{ key: 'first', name: '', mime: 'image/png' }, { key: 'second', name: '', mime: 'image/png' }])]);
    const receivedAt = Date.now(), date = new Date(receivedAt).toISOString().slice(0, 10).replace(/-/g, '');
    f.store.db.prepare("UPDATE gateway_inbox SET received_at=? WHERE status='pending'").run(receivedAt);
    await gateway.tick();
    const first = f.store.db.prepare('SELECT * FROM files WHERE owner_id=?').all(f.owner);
    assert.equal(first.length, 1, 'first snapshot persists despite the next attachment failing');
    assert.match(first[0].original_name, new RegExp(`^飞书图片_${date}_[a-f0-9]{8}\\.png$`));
    await gateway.close();
    f.store.db.prepare("UPDATE gateway_inbox SET status='pending' WHERE status='failed'").run();
    gateway = new GatewayCore(f.store, configuration, bot, { feishu: factory }, f.files); gateway.start(false);
    await gateway.tick();
    assert.equal(downloads.get('first'), 1, 'completed attachment is not downloaded again after restart');
    assert.equal(downloads.get('second'), 2);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM files').get().n, 2);
    assert.equal(f.store.db.prepare('SELECT original_name FROM files WHERE id=?').get(first[0].id).original_name, first[0].original_name);
    const message = f.store.db.prepare("SELECT content FROM messages WHERE role='user' AND kind='attachment'").get();
    assert.equal(JSON.parse(message.content).attachments[0].fileId, first[0].id);
    assert.equal(JSON.parse(message.content).attachments.length, 2);
  } finally { await gateway.close(); }
});

test('new text/copy/upload commits cannot replace a file created after the initial stat check', t => {
  const f = fixture(t);
  const projects = new ProjectRepository(f.store, path.join(f.files, 'projects'));
  const workspace = projects.botWorkspace(f.owner);
  const external = path.join(f.root, 'source'); fs.writeFileSync(external, 'new content');
  const originalLink = fs.linkSync;
  try {
    fs.linkSync = (temporary, target) => { fs.writeFileSync(target, 'concurrent user file', { flag: 'wx' }); return originalLink(temporary, target); };
    assert.throws(() => projects.files.write(workspace, 'text.txt', 'new content', null), /exists/);
    assert.throws(() => projects.files.copy(workspace, 'copy.txt', external), /exists/);
    assert.throws(() => projects.files.installUpload(workspace, 'upload.txt', external), /exists/);
  } finally { fs.linkSync = originalLink; }
  for (const name of ['text.txt', 'copy.txt', 'upload.txt']) assert.equal(projects.files.read(workspace, name).text, 'concurrent user file');
  assert.ok(projects.files.list(workspace).every(f => !f.name.startsWith('.write-')));
});
