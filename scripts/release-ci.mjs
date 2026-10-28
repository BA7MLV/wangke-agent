import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { planRelease, validateManifest, services } from './release-plan.mjs';
import { assembleManifest } from './release-manifest.mjs';

const dockerfiles = { api: 'Dockerfile', web: 'infra/docker/web.Dockerfile', sandbox: 'infra/sandbox/Dockerfile', broker: 'infra/sandbox/broker.Dockerfile' };
export function buildMatrix(plan, prefix) {
  if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/.test(prefix) || prefix.includes('..') || prefix.endsWith('/')) throw new Error('invalid_registry_image_prefix');
  return { include: plan.services.map(service => {
    if (!dockerfiles[service]) throw new Error('invalid_build_service');
    return { service, dockerfile: dockerfiles[service], image: `${prefix}-${service}` };
  }) };
}
export function collectManifest(plan, baseline, results, database) {
  const builds = {};
  for (const result of results) {
    if (!services.includes(result.service) || builds[result.service]) throw new Error('duplicate_or_unknown_build_result');
    const { service, ...entry } = result;
    if (!/^[^\s@:]+(?:\:[0-9]+)?\/[^\s@:]+@sha256:[a-f0-9]{64}$/.test(entry.image ?? '')) throw new Error('invalid_build_digest');
    builds[service] = entry;
  }
  if (!database?.identity || !/^[a-f0-9]{64}$/.test(database.schemaHash ?? '')) throw new Error('database_identity_and_schema_hash_required');
  return assembleManifest(plan, baseline, builds, database);
}
export function prepareCI(repository, output, baselineJSON, prefix) {
  // Inputs/artifacts must not make the clean checkout dirty before planning.
  if (path.resolve(output).startsWith(path.resolve(repository) + path.sep)) throw new Error('ci_output_must_be_outside_checkout');
  fs.mkdirSync(output, { recursive: true });
  const baseline = baselineJSON?.trim() ? validateManifest(JSON.parse(baselineJSON)) : null;
  const baselineFile = path.join(output, 'baseline.json');
  fs.writeFileSync(baselineFile, JSON.stringify(baseline));
  const plan = planRelease(baseline ? baselineFile : undefined, repository);
  const matrix = buildMatrix(plan, prefix);
  const epoch = execFileSync('git', ['show', '-s', '--format=%ct', plan.sourceCommit], { cwd: repository, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2));
  return { plan, matrix, registry: prefix.split('/')[0], epoch };
}
function scan(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? scan(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'prepare') {
      const { plan, matrix, registry, epoch } = prepareCI(process.cwd(), process.env.RELEASE_OUTPUT, process.env.RELEASE_BASELINE_JSON, process.env.RELEASE_IMAGE_PREFIX);
      for (const [key, value] of Object.entries({ matrix: JSON.stringify(matrix), services: JSON.stringify(plan.services), registry, epoch, source: plan.sourceCommit, build: String(plan.services.length > 0) })) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    } else if (process.argv[2] === 'assemble') {
      const files = scan(process.argv[3]);
      const readOne = name => {
        const matching = files.filter(file => path.basename(file) === name);
        if (matching.length !== 1) throw new Error(`missing_or_duplicate_artifact:${name}`);
        return JSON.parse(fs.readFileSync(matching[0], 'utf8'));
      };
      const plan = readOne('plan.json'), baseline = readOne('baseline.json');
      const results = files.filter(file => /^build-(api|web|sandbox|broker)\.json$/.test(path.basename(file))).map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
      const database = plan.services.includes('api') ? readOne('database.json') : baseline?.database;
      fs.writeFileSync(process.argv[4], JSON.stringify(collectManifest(plan, baseline, results, database), null, 2) + '\n');
    } else throw new Error('Usage: release-ci.mjs prepare | assemble ARTIFACTS OUTPUT.json');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
