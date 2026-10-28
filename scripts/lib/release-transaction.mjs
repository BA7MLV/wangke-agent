import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateManifest, services, manifestIdentity } from '../release-plan.mjs';
import { atomicJSON, readJSON, copyPass, sealPoint, verifyPoint, restorePoint } from './release-storage.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const composeNames = { api: 'api', web: 'web', broker: 'sandbox-broker', sandbox: 'sandbox-image' };
export function imageOverride(manifest, previous = {}, release) {
  const value = structuredClone(previous); value.services ??= {};
  for (const name of services) if (manifest.images[name]) {
    const key = composeNames[name]; value.services[key] ??= {};
    if (['broker', 'sandbox'].includes(name) && !Object.hasOwn(previous.services ?? {}, key)) { delete value.services[key]; continue; }
    value.services[key].image = manifest.images[name].image;
  }
  if (manifest.images.sandbox && manifest.images.broker && value.services['sandbox-broker']) {
    value.services['sandbox-broker'].environment ??= {};
    value.services['sandbox-broker'].environment.SANDBOX_IMAGE = manifest.images.sandbox.image;
  }
  if (release) {
    value.services.api.environment = { ...value.services.api.environment, API_RELEASE_ID: release.id, API_RELEASE_TOKEN: release.token };
  }
  return value;
}

/** Transport-independent durable release state machine. The adapter must prove
 * stopped writers (including sandbox mounts), not merely send a stop command. */
export class ReleaseTransaction {
  constructor(installation, adapter) {
    this.installation = installation; this.adapter = adapter;
    this.root = path.join(installation, 'releases');
    this.journal = path.join(this.root, 'transaction.json');
    this.baseline = path.join(this.root, 'last-success.json');
    this.override = path.join(installation, 'deployment-images.json');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  save = transaction => { atomicJSON(this.journal, transaction); };
  phase(t, phase) {
    t.phase = phase; t.events ??= [];
    t.events.push({ phase, at: new Date().toISOString() });
    this.save(t);
  }
  async promote(t) {
    await this.adapter.ready(t.target);
    this.phase(t, 'promoting');
    atomicJSON(path.join(this.root, 'previous-success.json'), t.previous);
    atomicJSON(this.baseline, t.target);
    this.phase(t, 'complete');
  }
  async deploy(target, scope, restoreSource) {
    validateManifest(target);
    if (!['web', 'api', 'full'].includes(scope)) throw new Error('explicit_release_scope_required');
    if (fs.existsSync(this.journal) && !['complete', 'rolled-back'].includes(readJSON(this.journal).phase)) throw new Error('unfinished_release_use_recover');
    if (!fs.existsSync(this.baseline)) throw new Error('missing_successful_baseline_use_adopt');
    const previous = validateManifest(readJSON(this.baseline));
    if (restoreSource) {
      const point = verifyPoint(restoreSource);
      if (scope !== 'full' || !same(point.database, target.database)) throw new Error('restore_database_manifest_mismatch');
    }
    if (target.baselineCommit !== previous.sourceCommit) throw new Error('stale_deployment_baseline');
    if (target.baselineDigest !== manifestIdentity(previous)) throw new Error('deployment_baseline_digest_mismatch');
    const changed = services.filter(name => !same(target.images[name], previous.images[name]));
    if (changed.some(name => !target.images[name])) throw new Error('removing_release_service_requires_explicit_migration');
    if (scope !== 'full' && changed.some(name => name !== scope)) throw new Error('release_scope_mismatch');
    if (!changed.includes('api') && !same(target.database, previous.database)) throw new Error('database_change_requires_api_release');
    await this.adapter.preflight(target, previous, changed);
    if (restoreSource && !changed.includes('api')) changed.push('api');
    const t = { format: 1, id: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'), previous, target, changed, restoreSource,
      previousOverride: fs.existsSync(this.override) ? readJSON(this.override) : imageOverride(previous), phase: 'prepared' };
    t.targetOverride = imageOverride(target, t.previousOverride, changed.some(name => name !== 'web') ? t : undefined);
    t.point = path.join(this.root, 'points', t.id);
    this.save(t);
    try {
      if (!changed.some(name => name !== 'web')) {
        this.phase(t, 'web'); atomicJSON(this.override, t.targetOverride);
        if (changed.includes('web')) await this.adapter.web(target);
        await this.promote(t); return t;
      }
      const payload = path.join(t.point, 'payload');
      const index = copyPass(path.join(this.installation, 'data'), path.join(payload, 'data'));
      this.phase(t, 'stopping');
      await this.adapter.stopWriters();
      this.phase(t, 'stopped');
      copyPass(path.join(this.installation, 'data'), path.join(payload, 'data'), index);
      fs.copyFileSync(path.join(this.installation, '.env'), path.join(payload, '.env'));
      fs.chmodSync(path.join(payload, '.env'), 0o600);
      const inspected = await this.adapter.snapshot(path.join(payload, 'data'));
      if (inspected.schemaHash !== previous.database.schemaHash) throw new Error('previous_database_shape_mismatch');
      sealPoint(t.point, previous.database);
      atomicJSON(path.join(t.point, 'release.json'), previous);
      this.phase(t, 'snapshot');
      if (restoreSource) {
        this.phase(t, 'restoring-requested');
        t.requestedRestore = { id: crypto.randomUUID() }; this.save(t);
        restorePoint(restoreSource, this.installation, t.requestedRestore, () => this.save(t));
        await this.adapter.verifyRestored(target);
      }
      atomicJSON(this.override, t.targetOverride);
      this.phase(t, 'starting');
      await this.adapter.startStaged(target);
      await this.adapter.staged(target, t);
      this.phase(t, 'staged');
      if (changed.includes('web')) await this.adapter.web(target);
      // After this durable intent the new instance MAY have admitted writes.
      // Never auto-restore the snapshot on a lost activation response.
      this.phase(t, 'activation-intent');
      await this.adapter.activate(t);
      this.phase(t, 'activated');
      await this.promote(t); return t;
    } catch (error) {
      if (['activation-intent', 'activated', 'promoting', 'complete'].includes(t.phase)) throw new Error(`activation_outcome_requires_forward_recovery:${error.message}`);
      try { await this.rollback(t); }
      catch (recovery) { throw new Error(`release_failed:${error.message}; recovery_required:${recovery.message}`); }
      throw error;
    }
  }
  async rollback(t) {
    if (t.phase === 'prepared') { this.phase(t, 'rolled-back'); return; }
    const api = t.changed.some(name => name !== 'web');
    if (api) {
      await this.adapter.stopWriters();
      const complete = fs.existsSync(path.join(t.point, 'point.json'));
      if (!complete && ['starting', 'staged', 'restoring'].includes(t.phase)) throw new Error('missing_required_restore_point');
      if (complete) {
        verifyPoint(t.point);
        this.phase(t, 'restoring');
        restorePoint(t.point, this.installation, t, this.save);
        await this.adapter.verifyRestored(t.previous);
      }
    }
    atomicJSON(this.override, t.previousOverride);
    if (api) await this.adapter.startPrevious(t.previous);
    if (t.changed.includes('web')) await this.adapter.web(t.previous);
    await this.adapter.ready(t.previous);
    this.phase(t, 'rolled-back');
  }
  async recover() {
    const t = readJSON(this.journal);
    if (['complete', 'rolled-back'].includes(t.phase)) return t;
    if (['activation-intent', 'activated', 'promoting'].includes(t.phase)) {
      if (t.backupOnly) {
        atomicJSON(this.override, t.previousOverride);
        await this.adapter.startPrevious(t.previous); await this.adapter.ready(t.previous);
        this.phase(t, 'complete'); return t;
      }
      // A failed ack is not evidence that nobody wrote to the new database.
      atomicJSON(this.override, t.targetOverride);
      if (t.changed.some(name => name !== 'web')) {
        await this.adapter.resumeTarget(t.target, t);
        await this.adapter.activate(t);
      } else if (t.changed.includes('web')) await this.adapter.web(t.target);
      this.phase(t, 'activated'); await this.promote(t);
    } else await this.rollback(t);
    return t;
  }
  async snapshot() {
    if (fs.existsSync(this.journal) && !['complete', 'rolled-back'].includes(readJSON(this.journal).phase)) throw new Error('unfinished_release_use_recover');
    const previous = validateManifest(readJSON(this.baseline));
    await this.adapter.preflight(previous, previous, []);
    const t = { format: 1, id: crypto.randomUUID(), previous, target: previous, changed: ['api'], backupOnly: true,
      previousOverride: readJSON(this.override), phase: 'prepared' };
    t.targetOverride = t.previousOverride; t.point = path.join(this.root, 'points', t.id); this.save(t);
    try {
      const payload = path.join(t.point, 'payload');
      const index = copyPass(path.join(this.installation, 'data'), path.join(payload, 'data'));
      this.phase(t, 'stopping'); await this.adapter.stopWriters(); this.phase(t, 'stopped');
      copyPass(path.join(this.installation, 'data'), path.join(payload, 'data'), index);
      fs.copyFileSync(path.join(this.installation, '.env'), path.join(payload, '.env')); fs.chmodSync(path.join(payload, '.env'), 0o600);
      const inspected = await this.adapter.snapshot(path.join(payload, 'data'));
      if (inspected.schemaHash !== previous.database.schemaHash) throw new Error('previous_database_shape_mismatch');
      sealPoint(t.point, previous.database); atomicJSON(path.join(t.point, 'release.json'), previous);
      this.phase(t, 'activation-intent');
      await this.adapter.startPrevious(previous); await this.adapter.ready(previous);
      this.phase(t, 'complete'); return t;
    } catch (error) {
      if (t.phase === 'activation-intent') throw new Error(`backup_restart_requires_forward_recovery:${error.message}`);
      await this.rollback(t); throw error;
    }
  }
}
