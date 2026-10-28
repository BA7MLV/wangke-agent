import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { taskCourseFile } from '../apps/api/src/cloud/execution.ts';
import { executeMediaTask, runMediaProcess } from '../apps/api/src/cloud/media.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';
import { ResourceFiles } from '../apps/api/src/projects/resources.ts';
import { executeNodeTask } from '../apps/api/runtime/node.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-resource-compat-'));
const filesDir = path.join(directory, 'files');
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const owner = crypto.randomUUID(), other = crypto.randomUUID();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, new Date().toISOString());
const records = new CloudRecords(store);
const projects = new ProjectRepository(store, path.join(filesDir, 'projects'));
const resources = new ResourceFiles(projects, filesDir);
const put = (table, key, after) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after,
  baseRevision: store.db.prepare('SELECT revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, JSON.stringify(key))?.revision }]);
const upload = async text => receiveFile(store, filesDir, owner, Readable.from([text]), 'compat', 'text/markdown', 1024 * 1024, Buffer.byteLength(text));
const context = {
  owner, store, records, filesDir, configuration: new CloudConfiguration(store, path.join(directory, 'config')),
  task: { id: crypto.randomUUID(), kind: 'material', input: { videoId: 'compat', format: 'md' } },
  signal: new AbortController().signal, fetch, checkActive() {}, report() {},
};
const conflict = error => error.code === 'project_file_conflict' && error.status === 409;
try {
  const original = await upload('# Old backup\n\nOriginal upload.');
  put('videos', 'compat', { id: 'compat', name: 'Compatibility', kind: 'material', materialFormat: 'md', mimeType: 'text/markdown', createdAt: 1 });
  put('courseFiles', 'compat', { id: 'compat', fileId: original.id, mimeType: 'text/markdown' });
  const root = resources.list(owner);
  const mapped = resources.placement(owner, 'compat');
  const physical = path.join(filesDir, 'projects', mapped.project_id, mapped.path);
  fs.writeFileSync(physical, '# Current disk\n\nNative parsing must read this content.');
  resources.list(owner);
  await executeNodeTask(context);
  const blocks = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='materialBlocks' AND value IS NOT NULL").all(owner).map(row => JSON.parse(row.value));
  assert.ok(blocks.some(block => block.text.includes('Native parsing must read this content.')), 'native parser uses the resource, not its old upload');
  let parsing = false;
  await assert.rejects(executeNodeTask({ ...context,
    report(event) { if (event.phase === 'parse') parsing = true; },
    checkActive() { if (parsing) { parsing = false; fs.writeFileSync(physical, '# Changed during parsing'); } },
  }), conflict, 'native parsing cannot commit an index after the file changes');
  resources.list(owner);

  const pending = await upload('# Worker edit\n\nSame shared file.');
  put('files', 'compat', { id: 'compat', blob: { $file: pending.id } });
  resources.migrate(owner);
  assert.equal(fs.readFileSync(physical, 'utf8'), '# Worker edit\n\nSame shared file.');
  assert.equal(records.get(owner, 'files', 'compat'), null, 'worker compatibility writes do not leave another active copy');
  put('files', 'compat', { id: 'compat', blob: { $file: pending.id } });
  resources.migrate(owner);
  assert.equal(records.get(owner, 'files', 'compat'), null, 'replaying a consumed blob also clears the compatibility copy');

  const pinned = taskCourseFile(context, 'compat');
  const privateFile = path.join(directory, 'private.txt');
  fs.writeFileSync(privateFile, 'private content');
  fs.unlinkSync(physical); fs.symlinkSync(privateFile, physical);
  try {
    const content = Buffer.alloc(pinned.size);
    fs.readSync(pinned.fd, content, 0, content.length, 0);
    assert.equal(content.toString(), '# Worker edit\n\nSame shared file.');
    const result = await runMediaProcess(['-e', "process.stdout.write(require('node:fs').readFileSync(3))"], context.signal, { executable: process.execPath, inputFd: pinned.fd });
    assert.equal(result.toString(), '# Worker edit\n\nSame shared file.', 'subprocesses inherit the checked descriptor, never the swapped path');
    assert.throws(() => pinned.assertCurrent(), error => error.status === 403);
    assert.equal(taskCourseFile({ ...context, owner: other }, 'compat'), null, 'another owner cannot resolve the resource');
  } finally { pinned.close(); }
  fs.unlinkSync(physical); fs.writeFileSync(physical, '# Restored'); resources.list(owner);

  const reference = records.get(owner, 'courseFiles', 'compat');
  fs.writeFileSync(physical, '# Concurrent Bot edit');
  put('courseFiles', 'compat', null);
  assert.throws(() => resources.migrate(owner), conflict, 'legacy delete cannot unlink a newer Bot edit');
  assert.equal(fs.readFileSync(physical, 'utf8'), '# Concurrent Bot edit');
  put('courseFiles', 'compat', reference); resources.list(owner);
  put('courseFiles', 'compat', null); resources.migrate(owner);
  assert.ok(!fs.existsSync(physical), 'legacy source deletion reaches the actual file');
  assert.equal(records.get(owner, 'videos', 'compat').fileDeleted, 1);
  assert.equal(taskCourseFile(context, 'compat'), null, 'missing resources never fall back to old blobs');
  assert.ok(fs.existsSync(path.join(filesDir, `${original.id}.bin`)), 'original backup is retained');
  fs.writeFileSync(physical, '# Recreated by Bot'); resources.list(owner); resources.migrate(owner);
  assert.equal(fs.readFileSync(physical, 'utf8'), '# Recreated by Bot', 'a consumed delete does not remove a later recreation');
  assert.equal(records.get(owner, 'videos', 'compat').fileDeleted, undefined);
  put('videos', 'compat', null); resources.migrate(owner);
  assert.ok(!fs.existsSync(physical));
  assert.equal(resources.placement(owner, 'compat'), undefined, 'whole-course deletion removes its placement too');

  projects.files.write(root.rootId, 'source.md', 'source', null);
  projects.files.write(root.rootId, 'target.md', 'target', null);
  const listing = resources.list(owner);
  const source = listing.entries.find(entry => entry.name === 'source.md');
  fs.unlinkSync(path.join(filesDir, 'projects', root.rootId, 'target.md'));
  assert.throws(() => resources.move(owner, root.rootId, source.path, root.rootId, 'target.md', source.revision), error => error.code === 'project_file_exists' && error.status === 409);
  assert.equal(projects.files.read(root.rootId, source.path).text, 'source', 'index collisions are rejected before moving disk contents');

  const movie = await upload('video fixture');
  put('videos', 'movie', { id: 'movie', name: 'Lecture.1', mimeType: 'video/mp4', createdAt: 2 });
  put('courseFiles', 'movie', { id: 'movie', fileId: movie.id, mimeType: 'video/mp4' });
  resources.migrate(owner);
  assert.equal(resources.placement(owner, 'movie').path, 'Lecture.1.mp4', 'dots in an old video title are not mistaken for video extensions');
  const mp4 = await runMediaProcess(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=2', '-t', '1', '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], context.signal);
  fs.writeFileSync(path.join(filesDir, 'projects', root.rootId, 'external.mp4'), mp4);
  const external = resources.list(owner).entries.find(entry => entry.name === 'external.mp4');
  const course = records.get(owner, 'videos', external.courseId);
  put('videos', external.courseId, { ...course, duration: 900 });
  assert.equal(await executeMediaTask({ ...context, task: { ...context.task, kind: 'cover', input: { videoId: external.courseId } } }), true, 'native covers read real Bot-created videos, including seek fallback');
  console.log('Resource compatibility: native parsing, pinned subprocess I/O, worker write-through, legacy deletion/CAS/recreation, move preflight and video names OK');
} finally {
  store.close(); fs.rmSync(directory, { recursive: true, force: true });
}
