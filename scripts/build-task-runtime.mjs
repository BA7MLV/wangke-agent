import { build } from 'esbuild';

const result = await build({
  entryPoints: ['apps/api/runtime/node.ts'],
  outfile: 'dist-api/apps/api/runtime/node.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: true, metafile: true,
});
// Fail the build rather than silently reintroducing browser storage/UI into Node execution.
const forbidden = Object.keys(result.metafile.inputs).filter(file =>
  /^src\/(?:cloud\/|store\/(?:db|courseChat|settings)\.|components\/|md-editor\/)/.test(file));
if (forbidden.length) throw new Error(`Browser dependency in Node runtime: ${forbidden.join(', ')}`);
