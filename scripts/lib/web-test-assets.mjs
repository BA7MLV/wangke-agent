import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Standalone esbuild tests do not load Vite's aliases or its ?raw loader.
// Resolve from the Web workspace, including when npm hoists its dependencies.
export const webTestAssets = {
  name: 'web-test-assets',
  setup(build) {
    build.onResolve({ filter: /^@widget\/chart-runtime\?raw$/ }, () => {
      const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
      return { path: join(dirname(require.resolve('chart.js')), 'chart.umd.js'), namespace: 'web-raw' };
    });
    build.onLoad({ filter: /.*/, namespace: 'web-raw' }, async ({ path }) => ({
      contents: await readFile(path, 'utf8'), loader: 'text',
    }));
  },
};
