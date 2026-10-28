import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { inspectDatabase, fenceRemoteWorkers } from '../apps/api/src/storage/release.ts';
import { ReleaseTransaction, imageOverride } from './lib/release-transaction.mjs';
import { atomicJSON, readJSON, verifyPoint, acquireLock, copyPass } from './lib/release-storage.mjs';
import { manifestIdentity } from './release-plan.mjs';

const Database = createRequire(new URL('../apps/api/package.json', import.meta.url))('better-sqlite3');
const image = (service, letter, commit) => ({ image: `registry.invalid/${service}@sha256:${letter.repeat(64)}`, sourceCommit: commit.repeat(40) });
function fixture(t, options = {}) {
  const installation = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/release-recovery-'));
  t.after(() => fs.rmSync(installation, { recursive: true, force: true }));
  fs.mkdirSync(path.join(installation, 'data/files/empty'), { recursive: true });
  fs.mkdirSync(path.join(installation, 'data/config'), { recursive: true });
  fs.writeFileSync(path.join(installation, '.env'), 'SECRET=original\n');
  fs.writeFileSync(path.join(installation, 'data/config/key'), 'credential-key');
  fs.writeFileSync(path.join(installation, 'data/files/note.txt'), 'before');
  const dbPath = path.join(installation, 'data/db/wangke.sqlite');
  const initial = new DatabaseStore(dbPath);
  const owner = crypto.randomUUID(), task = crypto.randomUUID(), at = new Date().toISOString();
  initial.db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, 'Owner', at);
  initial.db.prepare("INSERT INTO app_state VALUES('file-ref','note.txt')").run();
  initial.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at,executor,worker_id,lease_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(task, owner, task, 'chat', task, '{}', 'running', at, at, 'browser', 'old-lease', new Date(Date.now() + 600000).toISOString());
  const database = { identity: 'sha256:old-migration-code', ...inspectDatabase(initial.db) }; initial.close();
  const previous = { format: 1, sourceCommit: 'a'.repeat(40), images: { api: image('api', 'a', 'a'), web: image('web', 'b', 'a') }, database };
  const target = { ...previous, sourceCommit: 'c'.repeat(40), baselineCommit: previous.sourceCommit, baselineDigest: manifestIdentity(previous), images: { ...previous.images, api: image('api', 'c', 'c') }, database: { ...database, identity: 'sha256:new-migration-code' } };
  const calls = []; let stopped = false, active = previous;
  const adapter = {
    async preflight() { calls.push('pull-and-preflight'); },
    async stopWriters() {
      calls.push('stop-and-prove-writers'); stopped = true;
      if (options.beforeBarrier) { const action = options.beforeBarrier; options.beforeBarrier = null; action(installation, dbPath); }
    },
    async snapshot(destination) {
      assert.equal(stopped, true); calls.push('fence-and-backup');
      const db = new Database(dbPath); fenceRemoteWorkers(db);
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(destination, 'db/wangke.sqlite') + suffix, { force: true });
      await db.backup(path.join(destination, 'db/wangke.sqlite')); db.close();
      const backup = new Database(path.join(destination, 'db/wangke.sqlite')); const result = inspectDatabase(backup); backup.close(); return result;
    },
    async startStaged(next) {
      assert.equal(stopped, true); calls.push('start-staged'); active = next; stopped = false;
      if (options.badMigration) {
        const db = new Database(dbPath); db.prepare("UPDATE app_state SET value='broken.txt' WHERE key='file-ref'").run(); db.exec('CREATE TABLE partial_migration (id INTEGER)'); db.close();
        fs.writeFileSync(path.join(installation, 'data/files/note.txt'), 'broken migration');
        throw new Error('migration_crash');
      }
    },
    async staged() { calls.push('check-staged'); if (options.failStaged) throw new Error('new_schema_not_ready'); },
    async activate() {
      calls.push('activate');
      if (options.lostAck) {
        options.lostAck = false;
        fs.writeFileSync(path.join(installation, 'data/files/accepted.txt'), 'newly accepted data');
        throw new Error('activation_ack_lost');
      }
    },
    async resumeTarget(next) { calls.push('resume-target'); active = next; stopped = false; },
    async verifyRestored(previous) {
      calls.push('verify-restored');
      if (options.failRestoreVerify) { options.failRestoreVerify = false; throw new Error('verify_transport_lost'); }
      const db = new Database(dbPath); assert.equal(inspectDatabase(db).schemaHash, previous.database.schemaHash); db.close();
    },
    async startPrevious(previous) { calls.push('start-previous'); active = previous; stopped = false; },
    async web() { calls.push('replace-web'); if (options.failWeb) throw new Error('web_failed'); },
    async ready(next) { calls.push('ready'); assert.equal(active.images.api.image, next.images.api.image); },
  };
  const release = new ReleaseTransaction(installation, adapter);
  atomicJSON(release.baseline, previous); atomicJSON(release.override, imageOverride(previous));
  return { installation, dbPath, previous, target, calls, release, task, options };
}

test('consistent point includes late rename/deletion, empty dirs, secrets and fenced browser leases', async t => {
  const f = fixture(t, { beforeBarrier(root, dbPath) {
    fs.renameSync(path.join(root, 'data/files/note.txt'), path.join(root, 'data/files/final.txt'));
    fs.writeFileSync(path.join(root, 'data/files/final.txt'), 'last committed bytes');
    const db = new Database(dbPath); db.prepare("UPDATE app_state SET value='final.txt' WHERE key='file-ref'").run(); db.close();
  } });
  const result = await f.release.deploy(f.target, 'api');
  const point = verifyPoint(result.point), payload = path.join(result.point, 'payload');
  assert.equal(readJSON(f.release.baseline).sourceCommit, f.target.sourceCommit);
  assert.equal(fs.readFileSync(path.join(payload, 'data/files/final.txt'), 'utf8'), 'last committed bytes');
  assert.equal(fs.existsSync(path.join(payload, 'data/files/note.txt')), false);
  assert.equal(fs.statSync(path.join(payload, 'data/files/empty')).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(payload, '.env'), 'utf8'), 'SECRET=original\n');
  const db = new Database(path.join(payload, 'data/db/wangke.sqlite'));
  assert.equal(db.prepare("SELECT value FROM app_state WHERE key='file-ref'").get().value, 'final.txt');
  const lease = db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(f.task);
  assert.equal(lease.status, 'queued'); assert.equal(lease.worker_id, null); assert.equal(lease.lease_expires_at, null); db.close();
  assert.equal(point.database.identity, f.previous.database.identity);
  assert.ok(f.calls.indexOf('pull-and-preflight') < f.calls.indexOf('stop-and-prove-writers'));
  assert.ok(!f.calls.includes('replace-web'));
});

test('partial destructive migration restores DB AND files before previous single instance starts', async t => {
  const f = fixture(t, { badMigration: true });
  await assert.rejects(() => f.release.deploy(f.target, 'api'), /migration_crash/);
  assert.equal(readJSON(f.release.journal).phase, 'rolled-back');
  assert.equal(readJSON(f.release.baseline).sourceCommit, f.previous.sourceCommit);
  assert.equal(fs.readFileSync(path.join(f.installation, 'data/files/note.txt'), 'utf8'), 'before');
  const db = new Database(f.dbPath); assert.equal(db.prepare("SELECT value FROM app_state WHERE key='file-ref'").get().value, 'note.txt');
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='partial_migration'").get().n, 0); db.close();
  assert.ok(f.calls.indexOf('verify-restored') < f.calls.indexOf('start-previous'));
  assert.ok(fs.existsSync(path.join(f.installation, `failed-data-${readJSON(f.release.journal).id}`)));
});

test('lost activation ack NEVER restores accepted data; forward recovery promotes only after ready', async t => {
  const f = fixture(t, { lostAck: true });
  await assert.rejects(() => f.release.deploy(f.target, 'api'), /forward_recovery/);
  assert.equal(readJSON(f.release.baseline).sourceCommit, f.previous.sourceCommit);
  assert.equal(readJSON(f.release.journal).phase, 'activation-intent');
  await f.release.recover();
  assert.equal(readJSON(f.release.journal).phase, 'complete');
  assert.equal(readJSON(f.release.baseline).sourceCommit, f.target.sourceCommit);
  assert.equal(fs.readFileSync(path.join(f.installation, 'data/files/accepted.txt'), 'utf8'), 'newly accepted data');
  assert.ok(!f.calls.includes('verify-restored')); assert.ok(!f.calls.includes('start-previous'));
});

test('restore verification failure stays offline; recover resumes completed swap idempotently', async t => {
  const f = fixture(t, { badMigration: true, failRestoreVerify: true });
  await assert.rejects(() => f.release.deploy(f.target, 'api'), /recovery_required/);
  assert.equal(readJSON(f.release.journal).phase, 'restoring');
  assert.ok(!f.calls.includes('start-previous'));
  await f.release.recover();
  assert.equal(readJSON(f.release.journal).phase, 'rolled-back');
});

test('corrupt snapshot refuses recovery without starting the old binary against migrated data', async t => {
  const f = fixture(t, { badMigration: true, failRestoreVerify: true });
  await assert.rejects(() => f.release.deploy(f.target, 'api'));
  const state = readJSON(f.release.journal);
  fs.writeFileSync(path.join(state.point, 'payload/data/files/note.txt'), 'corrupt');
  await assert.rejects(() => f.release.recover(), /checksum/);
  assert.ok(!f.calls.includes('start-previous'));
});

test('web-only release does not stop API or snapshot; failed build/readiness never advances baseline', async t => {
  const f = fixture(t);
  const target = { ...f.target, database: f.previous.database, images: { ...f.previous.images, web: image('web', 'd', 'c') } };
  await f.release.deploy(target, 'web');
  assert.deepEqual(f.calls, ['pull-and-preflight', 'replace-web', 'ready']);
  const failed = fixture(t, { failWeb: true });
  await assert.rejects(() => failed.release.deploy({ ...target, baselineCommit: failed.previous.sourceCommit }, 'web'), /recovery_required/);
  assert.equal(readJSON(failed.release.baseline).sourceCommit, failed.previous.sourceCommit);
  assert.ok(!failed.calls.includes('stop-and-prove-writers'));
});

test('stale baseline, wrong scope, live lock and unsafe snapshots fail before deployment', async t => {
  const f = fixture(t);
  await assert.rejects(() => f.release.deploy({ ...f.target, baselineCommit: 'f'.repeat(40) }, 'api'), /stale/);
  await assert.rejects(() => f.release.deploy(f.target, 'web'), /scope/);
  const unlock = acquireLock(f.release.root);
  assert.throws(() => acquireLock(f.release.root, true), /already_running/); unlock();
  fs.symlinkSync('/etc/passwd', path.join(f.installation, 'data/files/not-a-file'));
  await assert.rejects(() => f.release.deploy(f.target, 'api'), /unsafe_snapshot/);
  assert.ok(!f.calls.includes('stop-and-prove-writers'));
});

test('full artifact manifests never enable optional sandbox services on a standard installation', t => {
  const f = fixture(t);
  const manifest = { ...f.target, images: { ...f.target.images, sandbox: image('sandbox', 'd', 'c'), broker: image('broker', 'e', 'c') } };
  const standard = imageOverride(manifest);
  assert.deepEqual(Object.keys(standard.services).sort(), ['api', 'web']);
  const sandbox = imageOverride(manifest, { services: { 'sandbox-broker': {}, 'sandbox-image': {} } });
  assert.equal(sandbox.services['sandbox-broker'].image, manifest.images.broker.image);
  assert.equal(sandbox.services['sandbox-broker'].environment.SANDBOX_IMAGE, manifest.images.sandbox.image);
});

test('backup fences writers and returns a sealed point without promoting/changing the deployed baseline', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.release.baseline, 'utf8');
  const result = await f.release.snapshot();
  verifyPoint(result.point);
  assert.equal(result.phase, 'complete');
  assert.equal(fs.readFileSync(f.release.baseline, 'utf8'), before);
  assert.ok(f.calls.includes('start-previous'));
  assert.ok(!f.calls.includes('activate') && !f.calls.includes('replace-web'));
});

test('recovery after a crash between data-directory renames completes the swap before startup', async t => {
  const f = fixture(t);
  const result = await f.release.snapshot();
  const state = { ...result, backupOnly: false, phase: 'restoring', restorePhase: 'swap' };
  const stage = path.join(f.installation, `restore-${state.id}`);
  copyPass(path.join(state.point, 'payload/data'), stage);
  fs.renameSync(path.join(f.installation, 'data'), path.join(f.installation, `failed-data-${state.id}`));
  atomicJSON(f.release.journal, state);
  const restarted = new ReleaseTransaction(f.installation, f.release.adapter);
  await restarted.recover();
  assert.equal(readJSON(restarted.journal).phase, 'rolled-back');
  assert.equal(fs.readFileSync(path.join(f.installation, 'data/files/note.txt'), 'utf8'), 'before');
  assert.equal(fs.existsSync(stage), false);
});

test('explicit data-loss restore uses matching old DB/files, but snapshots current data first', async t => {
  const f = fixture(t);
  const backup = await f.release.snapshot();
  fs.writeFileSync(path.join(f.installation, 'data/files/note.txt'), 'later data');
  const target = { ...f.previous, baselineCommit: f.previous.sourceCommit, baselineDigest: manifestIdentity(f.previous) };
  const restored = await f.release.deploy(target, 'full', backup.point);
  assert.equal(restored.phase, 'complete');
  assert.equal(fs.readFileSync(path.join(f.installation, 'data/files/note.txt'), 'utf8'), 'before');
  assert.equal(fs.readFileSync(path.join(restored.point, 'payload/data/files/note.txt'), 'utf8'), 'later data');
  assert.ok(fs.existsSync(path.join(f.installation, `failed-data-${restored.requestedRestore.id}`)));
});

test('same-commit tampered baseline and incompatible restore point are rejected before pull/stop', async t => {
  const f = fixture(t);
  await assert.rejects(() => f.release.deploy({ ...f.target, baselineDigest: '0'.repeat(64) }, 'api'), /baseline_digest/);
  assert.deepEqual(f.calls, []);
  const backup = await f.release.snapshot();
  const count = f.calls.length;
  await assert.rejects(() => f.release.deploy(f.target, 'full', backup.point), /restore_database_manifest_mismatch/);
  assert.equal(f.calls.length, count);
});
