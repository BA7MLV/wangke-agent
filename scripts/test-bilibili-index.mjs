// index.ts 纯逻辑单测：sanitizeFileName。remux/下载部分走 e2e。
// 用法：node scripts/test-bilibili-index.mjs

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `test-bilibili-index-${Date.now()}.mjs`);
execSync(
  `node_modules/.bin/esbuild src/bilibili/index.ts --bundle --platform=node --format=esm --packages=external --outfile=${tmp}`,
  { cwd: root, stdio: 'inherit' },
);
const { sanitizeFileName } = await import(path.join(root, 'src/bilibili/parse.ts'));

let passed = 0;
let failed = 0;
function eq(a, b, label) {
  if (a === b) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.error(`  FAIL ${label}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }
}

console.log('sanitizeFileName');
eq(sanitizeFileName('普通标题'), '普通标题', '普通标题');
eq(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j', '非法字符替换为空格并折叠');
eq(sanitizeFileName('  前后空格  '), '前后空格', '去首尾空格');
eq(sanitizeFileName('x'.repeat(200)), 'x'.repeat(80), '超长裁剪 80');
eq(sanitizeFileName('///'), 'bilibili-video', '全非法回退默认名');
eq(sanitizeFileName(''), 'bilibili-video', '空回退默认名');

fs.rmSync(tmp, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
