import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { affectedServices, validateManifest, planRelease } from './release-plan.mjs';
import { assembleManifest } from './release-manifest.mjs';
const graph = [
  { directory: 'apps/api', name: '@wangke/api', dependencies: { '@wangke/study-core': '0.1.0', '@wangke/contracts': '0.1.0' } },
  { directory: 'apps/web', name: '@wangke/web', dependencies: { '@wangke/study-core': '0.1.0', '@wangke/contracts': '0.1.0' } },
  { directory: 'packages/study-core', name: '@wangke/study-core', dependencies: { '@wangke/contracts': '0.1.0' } },
  { directory: 'packages/contracts', name: '@wangke/contracts' },
];
const selected = (...paths) => affectedServices(paths, graph).services;
assert.deepEqual(selected('apps/web/src/App.tsx'), ['web']);
assert.deepEqual(selected('apps/api/src/server.ts'), ['api']);
assert.deepEqual(selected('packages/study-core/src/prompts.ts'), ['api', 'web']);
assert.deepEqual(selected('packages/contracts/src/cloud.ts'), ['api', 'web']);
assert.deepEqual(selected('package-lock.json'), ['api', 'web', 'sandbox', 'broker']);
assert.deepEqual(selected('scripts/build-task-runtime.mjs'), ['api', 'web', 'sandbox', 'broker']);
assert.deepEqual(selected('infra/docker/web-entrypoint.sh'), ['web']);
assert.deepEqual(selected('infra/sandbox/broker.mjs'), ['broker']);
assert.deepEqual(selected('infra/sandbox/Dockerfile'), ['sandbox']);
assert.deepEqual(selected('docs/deployment.md'), []);
// No hardcoded knowledge of new shared workspaces: reverse closure is transitive.
const expanded = [...graph, { directory: 'packages/new-core', name: '@wangke/new-core' }];
expanded[2] = { ...expanded[2], dependencies: { '@wangke/new-core': '0.1.0' } };
assert.deepEqual(affectedServices(['packages/new-core/index.ts'], expanded).services, ['api', 'web']);
const entry = { image: `registry.example/wangke@sha256:${'a'.repeat(64)}`, sourceCommit: 'b'.repeat(40) };
const manifest = { format: 1, sourceCommit: 'c'.repeat(40), images: { api: entry, web: entry }, database: { identity: 'schema-sha256:test' } };
assert.equal(validateManifest(manifest), manifest);
assert.throws(() => validateManifest({ ...manifest, images: { ...manifest.images, web: { ...entry, image: 'registry.example/web:latest' } } }), /invalid_immutable_image:web/);
assert.throws(() => validateManifest({ ...manifest, database: {} }), /missing_database/);
const webPlan = { sourceCommit: 'd'.repeat(40), baselineCommit: manifest.sourceCommit, services: ['web'] };
const builtWeb = { ...entry, sourceCommit: webPlan.sourceCommit };
const release = assembleManifest(webPlan, manifest, { web: builtWeb }, manifest.database);
assert.deepEqual(release.images.api, manifest.images.api);
assert.deepEqual(release.images.web, builtWeb);
assert.throws(() => assembleManifest(webPlan, manifest, {}, manifest.database), /missing_or_wrong_build:web/);
assert.throws(() => assembleManifest(webPlan, manifest, { web: builtWeb }, { identity: 'changed' }), /web_release_cannot_change_database/);
assert.throws(() => assembleManifest({ ...webPlan, baselineCommit: 'f'.repeat(40) }, manifest, { web: builtWeb }, manifest.database), /baseline_mismatch/);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/release-plan-'));
const repository = path.join(directory, 'repo'); fs.mkdirSync(repository);
const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
try {
  git(['init']);
  fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify({ workspaces: graph.map(item => item.directory) }));
  for (const item of graph) {
    fs.mkdirSync(path.join(repository, item.directory), { recursive: true });
    fs.writeFileSync(path.join(repository, item.directory, 'package.json'), JSON.stringify(item));
  }
  const commit = () => { git(['add', '.']); git(['commit', '-m', 'fixture']); return git(['rev-parse', 'HEAD']); };
  const baselineCommit = commit();
  const baselinePath = path.join(directory, 'deployed.json');
  fs.writeFileSync(baselinePath, JSON.stringify({ ...manifest, sourceCommit: baselineCommit }));
  fs.writeFileSync(path.join(repository, 'apps/web/ui.ts'), '// update from an unshipped/failed release'); commit();
  fs.writeFileSync(path.join(repository, 'apps/api/api.ts'), '// subsequent API update'); commit();
  assert.deepEqual(planRelease(baselinePath, repository).services, ['api', 'web'], 'last deployed baseline includes previously unshipped Web changes');
  assert.deepEqual(planRelease(undefined, repository).services, ['api', 'web', 'sandbox', 'broker']);
  fs.writeFileSync(path.join(repository, 'dirty'), 'uncommitted');
  assert.throws(() => planRelease(baselinePath, repository), /release_requires_clean_committed_checkout/);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('Release selection: transitive graph, UI/API/shared/dependency/toolchain/sandbox scope, immutable manifests and dirty-checkout refusal passed');
