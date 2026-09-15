#!/usr/bin/env node
// 资料库视频行的转写文案：进度详情和状态标签不能写同一句。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import os from 'node:os';
import { unlinkSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `test-library-job-copy-${Date.now()}.mjs`);

execSync(
  `node_modules/.bin/esbuild src/store/jobs.ts --bundle --platform=node --format=esm --outfile=${tmp}`,
  { cwd: root, stdio: 'inherit' },
);

const { libraryJobCopy } = await import(tmp);

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

function job(patch) {
  return { videoId: 'v', phase: 'extract', message: '', done: 0, total: 0, resume: false, ...patch };
}

console.log('libraryJobCopy');
test('抽取音频：详情写百分比，标签只写「转写中」', () => {
  const copy = libraryJobCopy(job({ phase: 'extract', message: '抽取音频 46%', done: 0.46, total: 1 }));
  assert.equal(copy.detail, '抽取音频 46%');
  assert.equal(copy.tag, '转写中');
  assert.notEqual(copy.tag, copy.detail);
});

test('排队：详情写排队，标签仍是「转写中」', () => {
  const copy = libraryJobCopy(job({ phase: 'queued', message: '排队中…' }));
  assert.equal(copy.detail, '转写排队中');
  assert.equal(copy.tag, '转写中');
});

test('ASR：详情写分数，标签不复述分数', () => {
  const copy = libraryJobCopy(job({ phase: 'asr', message: '转写中 3/10（并发 2）', done: 3, total: 10 }));
  assert.equal(copy.detail, '转写中 3/10');
  assert.equal(copy.tag, '转写中');
});

unlinkSync(tmp);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
