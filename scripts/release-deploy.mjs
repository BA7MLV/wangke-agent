#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, manifestIdentity } from './release-plan.mjs';
import { ReleaseTransaction, imageOverride } from './lib/release-transaction.mjs';
import { DockerReleaseAdapter } from './lib/release-docker.mjs';
import { acquireLock, atomicJSON, readJSON, verifyPoint } from './lib/release-storage.mjs';

export async function main(argv) {
  let installation, preloaded = false; const compose = [], args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir') installation = argv[++i];
    else if (argv[i] === '--preloaded') preloaded = true;
    else if (['--compose-file', '-f'].includes(argv[i])) compose.push(path.resolve(argv[++i]));
    else args.push(argv[i]);
  }
  if (!installation || !compose.length) throw new Error('data_directory_and_compose_required');
  installation = fs.realpathSync(installation);
  for (const filename of ['.env', 'data']) if (fs.lstatSync(path.join(installation, filename)).isSymbolicLink()) throw new Error('symlink_installation_refused');
  const [command, input, flag] = args;
  const release = new ReleaseTransaction(installation, new DockerReleaseAdapter(installation, compose, { preloaded }));
  const unlock = acquireLock(release.root, command === 'recover');
  try {
    if (command === 'service' && ['start', 'stop', 'restart'].includes(input) && args.slice(2).every(service => ['api', 'web', 'proxy', 'sandbox-broker'].includes(service))) {
      if (fs.existsSync(release.journal) && !['complete', 'rolled-back'].includes(readJSON(release.journal).phase)) throw new Error('unfinished_release_use_recover');
      release.adapter.compose(args.slice(1)); return { phase: input };
    }
    if (command === 'recover' && args.length === 1) return await release.recover();
    if (command === 'snapshot' && args.length === 1) return await release.snapshot();
    if (command === 'adopt' && input && args.length === 2) {
      if (fs.existsSync(release.baseline)) throw new Error('baseline_already_exists');
      const manifest = validateManifest(readJSON(input));
      for (const entry of Object.values(manifest.images)) release.adapter.obtain(entry.image);
      await release.adapter.preflight(manifest, manifest, []);
      const database = JSON.parse(release.adapter.compose(['exec', '-T', 'api', 'node', '/app/apps/api/scripts/deployment-maintenance.mjs', 'verify', '/data/db/wangke.sqlite']));
      if (database.schemaHash !== manifest.database.schemaHash) throw new Error('live_database_identity_mismatch');
      const configured = release.adapter.config().services;
      const template = { services: Object.fromEntries(Object.keys(configured).map(name => [name, {}])) };
      const currentOverride = fs.existsSync(release.override) ? readJSON(release.override) : template;
      atomicJSON(release.override, imageOverride(manifest, currentOverride));
      atomicJSON(release.baseline, manifest); return manifest;
    }
    if (command === 'rollback' && args.length === 1) {
      const previous = validateManifest(readJSON(path.join(release.root, 'previous-success.json')));
      const current = validateManifest(readJSON(release.baseline));
      if (previous.database.identity !== current.database.identity || previous.database.schemaHash !== current.database.schemaHash) throw new Error('database_incompatible_use_explicit_restore_point_with_allow_data_loss');
      return await release.deploy({ ...previous, baselineCommit: current.sourceCommit, baselineDigest: manifestIdentity(current) }, 'full');
    }
    if (command === 'restore' && input && flag === '--allow-data-loss' && args.length === 3) {
      const point = fs.realpathSync(input);
      if (!point.startsWith(path.join(release.root, 'points') + path.sep)) throw new Error('restore_point_must_belong_to_installation');
      verifyPoint(point);
      const target = validateManifest(readJSON(path.join(point, 'release.json')));
      const baseline = validateManifest(readJSON(release.baseline));
      return await release.deploy({ ...target, baselineCommit: baseline.sourceCommit, baselineDigest: manifestIdentity(baseline) }, 'full', point);
    }
    if (['api', 'web', 'full'].includes(command) && input && args.length === 2) return await release.deploy(readJSON(input), command);
    throw new Error('Usage: release-deploy.mjs --data-dir DIR -f COMPOSE [--preloaded] {adopt MANIFEST|api MANIFEST|web MANIFEST|full MANIFEST|snapshot|recover|rollback|restore POINT --allow-data-loss}');
  } finally { unlock(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify({ status: result.phase ?? 'adopted', sourceCommit: result.target?.sourceCommit ?? result.sourceCommit, restorePoint: result.point, timeline: result.events }))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
