import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const sleep = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
const overlap = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
export class DockerReleaseAdapter {
  constructor(installation, composeFiles, { preloaded = false } = {}) {
    this.preloaded = preloaded;
    this.installation = fs.realpathSync(installation);
    this.data = fs.realpathSync(path.join(installation, 'data'));
    this.files = composeFiles;
    this.override = path.join(installation, 'deployment-images.json');
    this.env = { ...process.env, WANGKE_HOST_DATA_DIR: this.data, WANGKE_UID: String(process.getuid()), WANGKE_GID: String(process.getgid()) };
  }
  run(args, timeout = 240000) { return execFileSync('docker', args, { env: this.env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  compose(args) {
    const files = [...this.files, ...(fs.existsSync(this.override) ? [this.override] : [])];
    return this.run(['compose', '--env-file', path.join(this.installation, '.env'), ...files.flatMap(file => ['-f', file]), ...args]);
  }
  config() { return JSON.parse(this.compose(['config', '--format', 'json'])); }
  container(service, allowMissing = false) {
    const ids = this.compose(['ps', '-a', '-q', service]).split(/\s+/).filter(Boolean);
    if (!ids.length && allowMissing) return null;
    if (ids.length !== 1) throw new Error(`single_container_required:${service}`);
    return JSON.parse(this.run(['inspect', ids[0]]))[0];
  }
  async retry(operation) {
    let last;
    for (let i = 0; i < 60; i++) { try { return await operation(); } catch (error) { last = error; sleep(1000); } }
    throw last;
  }
  metadata(image) {
    return JSON.parse(this.run(['run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '/app/apps/api/scripts/deployment-maintenance.mjs', 'metadata']));
  }
  matchImage(service, image) {
    const container = this.container(service);
    const expected = JSON.parse(this.run(['image', 'inspect', image]))[0].Id;
    if (container.Image !== expected || !container.State.Running) throw new Error(`deployed_image_mismatch:${service}`);
    return container;
  }
  async preflight(target, previous, changed) {
    this.previous = previous;
    const config = this.config();
    if (config.services.app) throw new Error('legacy_app_requires_explicit_migration');
    if (!config.services.api || !config.services.web || !config.services.proxy) throw new Error('split_topology_required');
    const mount = (config.services.api.volumes ?? []).find(volume => volume.target === '/data');
    if (mount?.type !== 'bind' || fs.realpathSync(mount.source) !== this.data) throw new Error('api_data_mount_mismatch');
    const environment = config.services.api.environment ?? {};
    if (environment.DATA_DIR !== '/data' || environment.DB_PATH !== '/data/db/wangke.sqlite' || environment.FILES_DIR !== '/data/files' || environment.BOOTSTRAP_SECRET_FILE !== '/data/config/bootstrap-secret') throw new Error('unsupported_release_storage_paths');
    if ((config.services.api.volumes ?? []).some(volume => volume.target !== '/data' && (!volume.read_only || volume.target.startsWith('/data/')))) throw new Error('uncovered_api_storage_mount');
    if (config.services.api.user !== `${process.getuid()}:${process.getgid()}`) throw new Error('release_host_uid_must_match_api_uid');
    if (config.services['sandbox-broker'] && (!target.images.broker || !target.images.sandbox)) throw new Error('sandbox_images_required');
    for (const name of changed) this.obtain(target.images[name].image);
    for (const name of ['api', 'web']) {
      this.run(['image', 'inspect', previous.images[name].image]);
      const container = this.matchImage(name, previous.images[name].image);
      if (name === 'api') {
        const mounted = container.Mounts.find(volume => volume.Destination === '/data');
        if (mounted?.Type !== 'bind' || fs.realpathSync(mounted.Source) !== this.data || container.Mounts.some(volume => volume.Destination.startsWith('/data/'))) throw new Error('running_api_data_mount_mismatch');
        const actualEnv = Object.fromEntries((container.Config.Env ?? []).map(value => { const equals = value.indexOf('='); return [value.slice(0, equals), value.slice(equals + 1)]; }));
        for (const key of ['DATA_DIR', 'DB_PATH', 'FILES_DIR', 'BOOTSTRAP_SECRET_FILE']) if (actualEnv[key] !== environment[key]) throw new Error('running_api_storage_environment_mismatch');
        if (container.Config.User !== config.services.api.user) throw new Error('running_api_uid_mismatch');
      }
    }
    if (config.services['sandbox-broker']) {
      if (!previous.images.broker || !previous.images.sandbox) throw new Error('previous_sandbox_baseline_missing');
      this.matchImage('sandbox-broker', previous.images.broker.image);
      this.run(['image', 'inspect', previous.images.sandbox.image]);
    }
    for (const manifest of [previous, target]) {
      const actual = this.metadata(manifest.images.api.image);
      if (!/^[a-f0-9]{64}$/.test(manifest.database.schemaHash ?? '') || actual.identity !== manifest.database.identity || actual.schemaHash !== manifest.database.schemaHash) throw new Error('image_database_metadata_mismatch');
    }
    await this.ready(previous);
  }
  obtain(image) {
    // Offline transport must still resolve the exact repository digest in the
    // daemon; a mutable tag or an unverified archive cannot substitute for it.
    return this.run(this.preloaded ? ['image', 'inspect', image] : ['pull', image]);
  }
  running() {
    const ids = this.run(['ps', '-q']).split(/\s+/).filter(Boolean);
    return ids.length ? JSON.parse(this.run(['inspect', ...ids])) : [];
  }
  async stopWriters() {
    this.compose(['stop', '-t', '65', 'api']);
    if (this.config().services['sandbox-broker']) this.compose(['stop', '-t', '20', 'sandbox-broker']);
    if (this.container('api', true)?.State.Running) throw new Error('api_still_running');
    // Only this installation's writable sandbox bind mounts may be stopped.
    // Unknown writers are blockers, never killed on somebody else's behalf.
    for (const container of this.running()) {
      const writable = container.Mounts.filter(mount => mount.RW && mount.Type === 'bind' && overlap(path.resolve(mount.Source), this.data));
      if (!writable.length) continue;
      if (container.Config.Labels?.['wangke.sandbox'] === 'true' && writable.every(mount => path.resolve(mount.Source).startsWith(path.join(this.data, 'files/projects') + path.sep))) this.run(['stop', '-t', '10', container.Id]);
      else throw new Error(`uncoordinated_data_writer:${container.Id}`);
    }
    if (this.running().some(container => container.Mounts.some(mount => mount.RW && mount.Type === 'bind' && overlap(path.resolve(mount.Source), this.data)))) throw new Error('data_writer_barrier_failed');
  }
  async snapshot(destination) {
    const result = this.run(['run', '--rm', '--network', 'none', '--user', `${process.getuid()}:${process.getgid()}`, '--mount', `type=bind,source=${this.data},target=/live`, '--mount', `type=bind,source=${destination},target=/snapshot`, '--entrypoint', 'node', this.previous.images.api.image, '/app/apps/api/scripts/deployment-maintenance.mjs', 'snapshot', '/live/db/wangke.sqlite', '/snapshot/db/wangke.sqlite']);
    return JSON.parse(result);
  }
  async verifyRestored(previous) {
    // Restore renames the bind source; force-recreate below is mandatory.
    const result = JSON.parse(this.run(['run', '--rm', '--network', 'none', '--user', `${process.getuid()}:${process.getgid()}`, '--mount', `type=bind,source=${this.data},target=/live`, '--entrypoint', 'node', previous.images.api.image, '/app/apps/api/scripts/deployment-maintenance.mjs', 'verify', '/live/db/wangke.sqlite']));
    if (result.schemaHash !== previous.database.schemaHash) throw new Error('restored_database_identity_mismatch');
  }
  async startStaged() {
    if (this.config().services['sandbox-broker']) this.compose(['up', '-d', '--no-deps', '--no-build', '--force-recreate', 'sandbox-broker']);
    this.compose(['up', '-d', '--no-deps', '--no-build', '--force-recreate', 'api']);
  }
  control(action) {
    // Secrets stay in the protected Compose override/container environment, not
    // command arguments, URLs, shell expansion or API access logs.
    return JSON.parse(this.compose(['exec', '-T', 'api', 'node', '-e', `
      fetch('http://127.0.0.1:3000/api/v1/deployment/${action}', {method:${JSON.stringify(action === 'activate' ? 'POST' : 'GET')},headers:{'x-deployment-token':process.env.API_RELEASE_TOKEN}})
      .then(async r=>{if(!r.ok)throw Error('deployment_control_'+r.status);console.log(await r.text())}).catch(e=>{console.error(e.message);process.exit(1)})
    `]));
  }
  async staged(target, transaction) {
    return this.retry(() => {
      this.matchImage('api', target.images.api.image);
      const status = this.control('status');
      if (status.releaseId !== transaction.id || status.draining || status.database.identity !== target.database.identity || status.database.schemaHash !== target.database.schemaHash) throw new Error('staged_release_identity_mismatch');
      return status;
    });
  }
  async activate(transaction) {
    const result = this.control('activate');
    if (result.releaseId !== transaction.id || result.activated !== true) throw new Error('activation_ack_mismatch');
  }
  async resumeTarget(target, transaction) {
    try { await this.staged(target, transaction); }
    catch { await this.stopWriters(); await this.startStaged(target); await this.staged(target, transaction); }
  }
  async startPrevious() { await this.startStaged(); }
  async web() { this.compose(['up', '-d', '--no-deps', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '180', 'web']); }
  async ready(manifest) {
    await this.retry(() => {
      this.matchImage('api', manifest.images.api.image);
      this.compose(['exec', '-T', 'api', 'node', '-e', "fetch('http://127.0.0.1:3000/api/v1/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]);
      const web = this.matchImage('web', manifest.images.web.image);
      if (web.State.Health?.Status !== 'healthy') throw new Error('web_not_healthy');
    });
  }
}
