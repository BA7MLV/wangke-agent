import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareCI, buildMatrix, collectManifest } from './release-ci.mjs';
import { manifestIdentity } from './release-plan.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/release-ci-'));
const repository = path.join(temporary, 'repo'), output = path.join(temporary, 'output');
fs.mkdirSync(repository);
const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }).trim();
const entry = (name, source) => ({ image: `registry.invalid/wangke-${name}@sha256:${(name === 'api' ? 'a' : 'b').repeat(64)}`, sourceCommit: source });
try {
  git(['init']);
  const directories = ['apps/api', 'apps/web', 'packages/contracts'];
  fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify({ workspaces: directories }));
  for (const directory of directories) {
    fs.mkdirSync(path.join(repository, directory), { recursive: true });
    fs.writeFileSync(path.join(repository, directory, 'package.json'), JSON.stringify({ name: `@wangke/${directory.split('/')[1]}`, dependencies: directory.startsWith('apps/') ? { '@wangke/contracts': '0.1.0' } : {} }));
  }
  const commit = () => { git(['add', '.']); git(['commit', '-m', 'fixture']); return git(['rev-parse', 'HEAD']); };
  const oldCommit = commit();
  const baseline = { format: 1, sourceCommit: oldCommit, images: { api: entry('api', oldCommit), web: entry('web', oldCommit) }, database: { identity: 'sha256:database', schemaHash: 'c'.repeat(64) } };
  fs.writeFileSync(path.join(repository, 'apps/web/ui.ts'), '// unshipped change'); commit();
  fs.writeFileSync(path.join(repository, 'docs.md'), 'unknown input means full');
  fs.unlinkSync(path.join(repository, 'docs.md')); // no dirty test input when planning
  const prepared = prepareCI(repository, output, JSON.stringify(baseline), 'registry.invalid/owner/wangke');
  assert.deepEqual(prepared.plan.services, ['web']);
  assert.deepEqual(prepared.matrix.include.map(item => item.service), ['web']);
  assert.equal(prepared.matrix.include[0].dockerfile, 'infra/docker/web.Dockerfile');
  assert.equal(prepared.registry, 'registry.invalid');
  assert.equal(prepared.plan.baselineDigest, manifestIdentity(baseline));
  const web = { service: 'web', image: `registry.invalid/owner/wangke-web@sha256:${'d'.repeat(64)}`, sourceCommit: prepared.plan.sourceCommit };
  const result = collectManifest(prepared.plan, baseline, [web], baseline.database);
  assert.deepEqual(result.images.api, baseline.images.api, 'untouched API retains its real old source commit');
  assert.equal(result.baselineDigest, manifestIdentity(baseline));
  assert.throws(() => collectManifest(prepared.plan, baseline, [], baseline.database), /missing_or_wrong_build/);
  assert.throws(() => collectManifest(prepared.plan, baseline, [web, web], baseline.database), /duplicate/);
  assert.throws(() => collectManifest(prepared.plan, baseline, [{ ...web, image: 'registry.invalid/web:latest' }], baseline.database), /digest/);
  assert.throws(() => collectManifest(prepared.plan, baseline, [{ ...web, sourceCommit: oldCommit }], baseline.database), /wrong_build/);
  assert.throws(() => collectManifest(prepared.plan, baseline, [web], { ...baseline.database, identity: 'wrong' }), /web_release_cannot_change_database/);
  assert.throws(() => collectManifest(prepared.plan, { ...baseline, database: { ...baseline.database, identity: 'tampered-same-commit' } }, [web], baseline.database), /baseline_digest/);
  assert.throws(() => buildMatrix(prepared.plan, 'registry.invalid/owner; injected'), /prefix/);
  assert.throws(() => prepareCI(repository, path.join(repository, 'out'), '', 'registry.invalid/x'), /outside/);
  assert.deepEqual(prepareCI(repository, path.join(temporary, 'full'), '', 'registry.invalid/x').plan.services, ['api', 'web', 'sandbox', 'broker']);
  fs.writeFileSync(path.join(repository, 'packages/contracts/changed.ts'), '// shared'); commit();
  assert.deepEqual(prepareCI(repository, path.join(temporary, 'shared'), JSON.stringify(baseline), 'registry.invalid/x').plan.services, ['api', 'web']);
  const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /push: \$\{\{ inputs.publish \}\}/);
  assert.match(workflow, /cache-to: type=gha,mode=max,scope=release-/);
  assert.match(workflow, /release-artifacts/);
  assert.match(workflow, /--pattern "release-\*-\$GITHUB_RUN_ATTEMPT"/);
  assert.ok(!workflow.includes('workflow_run:') && !workflow.includes('ssh '));
  console.log('Release CI: deployed-baseline graph, selective matrix, conservative full fallback, immutable result collection, same-commit baseline tamper, missing/duplicate/wrong builds and publication gates passed');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
