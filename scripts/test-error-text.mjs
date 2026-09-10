#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `test-error-text-${Date.now()}.mjs`);

execSync(
  `node_modules/.bin/esbuild src/utils/errorText.ts --bundle --platform=node --format=esm --outfile=${tmp}`,
  { cwd: root, stdio: 'inherit' },
);

const { formatCaughtError } = await import(tmp);

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL - ${name}\n    ${e.message}`);
  }
}

console.log('formatCaughtError');
test('Error 含 message 与 stack', () => {
  const err = new Error('未找到音轨');
  err.stack = 'Error: 未找到音轨\n    at extractAudio16k (audio.ts:60)';
  const text = formatCaughtError(err);
  assert.ok(text.includes('未找到音轨'));
  assert.ok(text.includes('extractAudio16k'));
});

test('非 Error 转成字符串', () => {
  assert.equal(formatCaughtError('boom'), 'boom');
  assert.equal(formatCaughtError(42), '42');
});

import { unlinkSync } from 'node:fs';
unlinkSync(tmp);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
