import assert from 'node:assert/strict';
import path from 'node:path';
import { allowed, inspectSource, inspectDocker } from './check-boundaries.mjs';

const root = process.cwd();
const file = path.resolve('apps/api/runtime/probe.ts');
for (const source of [
  "import type { X } from '../../../src/store/settings';",
  "import type { X } from '../../../apps/web/src/store/settings';",
  "const x = import('../../../apps/web/src/api/modelClient');",
  "new URL('../../../apps/web/public/icon.svg', import.meta.url);",
  "export * from '../../../src/api/modelClient';",
  "const x = import('../../../src/api/modelClient');",
  "type X = import('../../../src/store/settings').Settings;",
  "const x = require('../../../src/api/modelClient');",
  "new URL('../../../src/skills/builtin/', import.meta.url);",
  "import.meta.glob('../../../src/**/*.ts');",
  "const x = import(somePath);",
  "cpSync('src/skills/builtin', 'dist/skills');",
  "fs.readFileSync('../../../src/config.ts');",
  "const p = new URL(flag ? '../../../src/x.ts' : './safe.ts', import.meta.url); import(p.href);",
]) assert.ok(inspectSource(file, source).length, source);
assert.ok(inspectSource(file, "import type { X } from '@web/store/settings';", {
  baseUrl: root, paths: { '@web/*': ['apps/web/src/*'] }, moduleResolution: 100,
}).length, 'path aliases must be resolved');
assert.equal(inspectSource(file, "import { chatOnce } from '@wangke/study-core/model/client';").length, 0);
for (const source of ["import fs from 'node:fs';", 'localStorage.getItem("key");', 'document.querySelector("x");', "import type { X } from '../../../apps/api/src/server';"]) {
  assert.ok(inspectSource(path.resolve('packages/study-core/src/probe.ts'), source).length, source);
}
assert.equal(allowed('contracts', 'study-core'), false);
assert.equal(allowed('study-core', 'contracts'), true);
for (const line of ['COPY . .', 'COPY src ./src', 'COPY apps/web ./apps/web', 'COPY --from=build /app/dist ./dist', 'COPY ["src", "./src"]', 'COPY ${WEB_DIR} ./web', 'COPY .env ./']) {
  assert.ok(inspectDocker(line, 'api').length, line);
}
assert.ok(inspectDocker('COPY apps/api ./apps/api', 'web').length);
assert.equal(inspectDocker('COPY apps/web/package.json ./apps/web/package.json', 'api').length, 0);
console.log('Boundary negative fixtures passed: types, import(), require, URLs, glob, aliases, nonliteral loaders and shared environment leaks.');
