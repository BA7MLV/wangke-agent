#!/usr/bin/env node
/**
 * ORT / Cloudflare 部署约束：VAD 只能加载 public/ort 里实际存在、
 * 且不超过 Pages 25MiB 上限的 wasm。默认 onnxruntime-web 会请求 jsep 变体。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `test-ort-config-${Date.now()}.mjs`);

execSync(
  `node_modules/.bin/esbuild src/media/ortConfig.ts --bundle --platform=node --format=esm --outfile=${tmp}`,
  { cwd: root, stdio: 'inherit' },
);

const { configureOrt, ORT_WASM_PATHS } = await import(tmp);

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

const CF_MAX = 25 * 1024 * 1024;

console.log('ORT wasm paths');
test('mjs/wasm 指向非 jsep 文件名', () => {
  assert.equal(ORT_WASM_PATHS.mjs, '/ort/ort-wasm-simd-threaded.mjs');
  assert.equal(ORT_WASM_PATHS.wasm, '/ort/ort-wasm-simd-threaded.wasm');
});

test('public/ort 存在对应文件', () => {
  const dir = path.join(root, 'public/ort');
  for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
    const p = path.join(dir, name);
    assert.equal(fs.existsSync(p), true, `missing ${name}`);
  }
});

test('托管 wasm 不超过 Cloudflare Pages 单文件上限', () => {
  const wasm = path.join(root, 'public/ort/ort-wasm-simd-threaded.wasm');
  assert.ok(fs.statSync(wasm).size < CF_MAX);
});

test('public/ort 不含超限的 jsep wasm', () => {
  const jsep = path.join(root, 'public/ort/ort-wasm-simd-threaded.jsep.wasm');
  assert.equal(fs.existsSync(jsep), false);
});

test('configureOrt 写入 wasmPaths，未隔离时单线程', () => {
  const ort = { env: { wasm: {} } };
  configureOrt(ort, { crossOriginIsolated: false });
  assert.deepEqual(ort.env.wasm.wasmPaths, ORT_WASM_PATHS);
  assert.equal(ort.env.wasm.numThreads, 1);
});

test('隔离环境下仍强制非 jsep 路径且不强制单线程', () => {
  const ort = { env: { wasm: {} } };
  configureOrt(ort, { crossOriginIsolated: true });
  assert.deepEqual(ort.env.wasm.wasmPaths, ORT_WASM_PATHS);
  assert.equal(ort.env.wasm.numThreads, undefined);
});

test('vite 把 onnxruntime-web 精确别名到非 jsep 的 wasm 构建', () => {
  const cfg = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
  assert.match(cfg, /find:\s*\/\^onnxruntime-web\(\?:\\\/wasm\)\?\$\//);
  assert.match(cfg, /ort\.wasm\.min\.mjs/);
  assert.match(cfg, /Cross-Origin-Embedder-Policy/);
});

const headersPath = path.join(root, 'public/_headers');
test('Cloudflare Pages 下发 COOP/COEP', () => {
  const text = fs.readFileSync(headersPath, 'utf8');
  assert.match(text, /Cross-Origin-Opener-Policy:\s*same-origin/);
  assert.match(text, /Cross-Origin-Embedder-Policy:\s*(require-corp|credentialless)/);
});

fs.rmSync(tmp, { force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
