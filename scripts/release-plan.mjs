import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
export const services = ['api', 'web', 'sandbox', 'broker'];
export function manifestIdentity(manifest) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(manifest))).digest('hex');
}

/** Derive dependents from actual workspace declarations, not a list of shared paths. */
export function affectedServices(changed, manifests) {
  const affected = new Set(), reasons = [];
  const workspace = new Set();
  let full = false;
  for (const filename of changed) {
    const entry = manifests.find(item => filename.startsWith(`${item.directory}/`));
    if (entry) { workspace.add(entry.name); continue; }
    if (filename === 'Dockerfile') { affected.add('api'); continue; }
    if (filename === 'infra/docker/web.Dockerfile' || filename === 'infra/docker/web-entrypoint.sh' || filename === 'infra/docker/Caddyfile.web') { affected.add('web'); continue; }
    if (filename === 'infra/sandbox/Dockerfile') { affected.add('sandbox'); continue; }
    if (['infra/sandbox/broker.Dockerfile', 'infra/sandbox/broker.mjs', 'infra/sandbox/arguments.mjs'].includes(filename)) { affected.add('broker'); continue; }
    if (/^(?:docs\/|README(?:\.|$)|LICENSE(?:\.|$))/.test(filename)) continue;
    // Root lockfile, toolchain, build scripts, edge configuration and unknown
    // inputs are deliberately conservative. Never guess that a dependency is harmless.
    full = true; reasons.push(`unscoped input: ${filename}`);
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const item of manifests) {
      if (workspace.has(item.name)) continue;
      const dependencies = Object.keys({ ...item.dependencies, ...item.devDependencies, ...item.optionalDependencies, ...item.peerDependencies });
      if (dependencies.some(name => workspace.has(name))) { workspace.add(item.name); expanded = true; }
    }
  }
  for (const service of ['api', 'web']) if (workspace.has(`@wangke/${service}`)) affected.add(service);
  return { services: full ? [...services] : services.filter(name => affected.has(name)), workspaces: [...workspace].sort(), reasons };
}

export function validateManifest(manifest) {
  if (manifest?.format !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '')) throw new Error('invalid_release_manifest');
  for (const service of services) {
    const entry = manifest.images?.[service];
    // Optional sandbox/broker may be absent, but must never become mutable tags.
    if (!entry && ['sandbox', 'broker'].includes(service)) continue;
    if (!entry || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(entry.image ?? '') || !/^[a-f0-9]{40}$/.test(entry.sourceCommit ?? '')) throw new Error(`invalid_immutable_image:${service}`);
  }
  if (typeof manifest.database?.identity !== 'string' || !manifest.database.identity) throw new Error('missing_database_migration_identity');
  return manifest;
}

/** Baseline is a last-successfully-DEPLOYED manifest, never last CI build/HEAD^. */
export function planRelease(baselinePath, repository = root) {
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const sourceCommit = git(['rev-parse', 'HEAD']);
  if (git(['status', '--porcelain'])) throw new Error('release_requires_clean_committed_checkout');
  const manifests = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')).workspaces.map(directory => ({ directory, ...JSON.parse(fs.readFileSync(path.join(repository, directory, 'package.json'), 'utf8')) }));
  if (!baselinePath) return { sourceCommit, baselineCommit: null, services: [...services], reasons: ['No successful deployment baseline; full build required.'] };
  const baseline = validateManifest(JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
  try { git(['merge-base', '--is-ancestor', baseline.sourceCommit, sourceCommit]); }
   catch { return { sourceCommit, baselineCommit: baseline.sourceCommit, baselineDigest: manifestIdentity(baseline), services: [...services], reasons: ['Baseline unavailable or not an ancestor; full build required.'] }; }
  const changed = git(['diff', '--name-only', '--no-renames', `${baseline.sourceCommit}..${sourceCommit}`]).split('\n').filter(Boolean);
  return { sourceCommit, baselineCommit: baseline.sourceCommit, baselineDigest: manifestIdentity(baseline), ...affectedServices(changed, manifests) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(planRelease(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
