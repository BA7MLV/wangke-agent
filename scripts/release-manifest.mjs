import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { services, validateManifest, manifestIdentity } from './release-plan.mjs';

/** Build results supply immutable refs. Reuse unchanged images with their actual
 * source commit; generating this document does NOT mark a deployment successful. */
export function assembleManifest(plan, baseline, results, database) {
  if (!/^[a-f0-9]{40}$/.test(plan?.sourceCommit ?? '') || !Array.isArray(plan.services) || plan.services.some(name => !services.includes(name))) throw new Error('invalid_release_plan');
  if (baseline) validateManifest(baseline);
  if ((baseline?.sourceCommit ?? null) !== plan.baselineCommit) throw new Error('release_baseline_mismatch');
  if (plan.baselineDigest && plan.baselineDigest !== manifestIdentity(baseline)) throw new Error('release_baseline_digest_mismatch');
  const images = {};
  for (const name of services) {
    if (plan.services.includes(name)) {
      if (!results?.[name] || results[name].sourceCommit !== plan.sourceCommit) throw new Error(`missing_or_wrong_build:${name}`);
      images[name] = results[name];
    } else if (baseline?.images[name]) images[name] = baseline.images[name];
    if (!plan.services.includes(name) && results?.[name]) throw new Error(`unplanned_build:${name}`);
  }
  if (!plan.services.includes('api') && JSON.stringify(database) !== JSON.stringify(baseline?.database)) throw new Error('web_release_cannot_change_database');
  return validateManifest({ format: 1, sourceCommit: plan.sourceCommit, baselineCommit: plan.baselineCommit, baselineDigest: baseline ? manifestIdentity(baseline) : null, images, database });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // Explicit inputs avoid silently substituting the last CI build for a deployed baseline.
    const [planFile, baselineFile, resultsFile, databaseFile] = process.argv.slice(2);
    if (!planFile || !baselineFile || !resultsFile || !databaseFile) throw new Error('Usage: node scripts/release-manifest.mjs PLAN.json BASELINE.json|- BUILD-RESULTS.json DATABASE.json');
    const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
    console.log(JSON.stringify(assembleManifest(read(planFile), baselineFile === '-' ? null : read(baselineFile), read(resultsFile), read(databaseFile)), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
