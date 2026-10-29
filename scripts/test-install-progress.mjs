import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-install-progress-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const dataDir = path.join(directory, 'install data');
  const log = path.join(directory, 'docker.jsonl');
  fs.mkdirSync(bin);
  // A fake executable keeps this test independent of Docker, network and real data.
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG, JSON.stringify({ args, dataDir: process.env.WANGKE_HOST_DATA_DIR, uid: process.env.WANGKE_UID, gid: process.env.WANGKE_GID }) + '\\n');
let stage = 'check';
if (args[0] === 'info') stage = 'info';
else if (args[0] === 'build') stage = 'sandbox';
else if (args.includes('build')) stage = 'build';
else if (args.includes('pull')) stage = 'pull';
else if (args.includes('up')) stage = 'wait';
else if (args.includes('exec')) stage = 'link';
if (stage === process.env.MOCK_FAIL) { console.error('mock Docker failure: ' + stage); process.exit(23); }
if (stage === 'build') console.log('mock: application build output');
if (stage === 'pull') console.log('mock: independent image pull output');
if (stage === 'sandbox') console.log('mock: sandbox build output');
if (stage === 'wait') console.log('mock: containers healthy');
if (stage === 'link') console.log('Setup URL: http://localhost:3000/#/setup');
`, { mode: 0o700 });
  return {
    dataDir,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    run: (args = [], env = {}) => new Promise((resolve, reject) => {
      const child = spawn('/bin/bash', ['install.sh', '--data-dir', dataDir, ...args], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_DOCKER_LOG: log, MOCK_FAIL: '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    }),
  };
}

test('prints completed-step percentages, seven stages, timing and live Docker logs in order', async t => {
  const f = fixture(t);
  const { code, output } = await f.run();
  assert.equal(code, 0, output);
  const starts = [...output.matchAll(/\[([1-7])\/7\] (?!完成：)(.+)…/g)];
  assert.deepEqual(starts.map(match => Number(match[1])), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal((output.match(/完成：/g) ?? []).length, 7);
  const percentages = [...output.matchAll(/\[(\d+)%\] \[\d\/7\] (完成：)?/g)];
  assert.deepEqual(percentages.filter(m => !m[2]).map(m => Number(m[1])), [0, 14, 28, 42, 57, 71, 85]);
  assert.deepEqual(percentages.filter(m => m[2]).map(m => Number(m[1])), [14, 28, 42, 57, 71, 85, 100]);
  assert.ok(output.indexOf('[100%]') > output.indexOf('Setup URL:'), '100% only follows successful setup-link retrieval');
  assert.equal((output.match(/\[100%\]/g) ?? []).length, 1);
  assert.match(output, /不代表耗时比例/);
  assert.match(output, /\[\d{2}:\d{2}:\d{2}\]/);
  assert.match(output, /耗时 \d+s/);
  assert.match(output, /安装完成（总耗时 \d+s）/);
  assert.ok(output.indexOf('准备独立服务镜像…') < output.indexOf('mock: independent image pull output'));
  assert.ok(output.indexOf('mock: independent image pull output') < output.indexOf('启动服务并等待健康检查…'));
  assert.ok(output.indexOf('mock: containers healthy') < output.indexOf('读取初始化入口…'));
  assert.match(output, /跳过沙盒镜像/);
  const calls = f.calls();
  const build = calls.find(c => c.args[0] === 'compose' && c.args.at(-1) === 'pull');
  const up = calls.find(c => c.args.includes('up'));
  assert.ok(build);
  assert.ok(!calls.some(c => c.args.includes('build')), 'default installation never builds on the server');
  assert.deepEqual(up.args.slice(up.args.indexOf('up')), ['up', '-d', '--no-build', '--wait', '--wait-timeout', '180']);
  assert.equal(build.dataDir, path.join(f.dataDir, 'data'));
  assert.equal(up.dataDir, build.dataDir);
  assert.ok(build.uid && build.gid);
  assert.ok(fs.existsSync(path.join(f.dataDir, 'bin/wangke-agent')));
  const environment = fs.readFileSync(path.join(f.dataDir, '.env'), 'utf8');
  assert.match(environment, /^WEBAUTHN_RP_NAME=DeepStudent Go$/m);
  assert.match(environment, /^DB_PATH=\/data\/db\/wangke\.sqlite$/m, 'branding keeps the existing database path');
});

test('managed installation refuses implicit replacement; script refresh does not rewrite config or invoke Docker', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dataDir, 'releases'), { recursive: true });
  const baseline = '{"success":"preserve"}\n', environment = 'WANGKE_API_IMAGE=registry.invalid/api@sha256:preserve\nSECRET=keep\n';
  fs.writeFileSync(path.join(f.dataDir, 'releases/last-success.json'), baseline);
  fs.writeFileSync(path.join(f.dataDir, '.env'), environment);
  const denied = await f.run(); assert.equal(denied.code, 2);
  const refreshed = await f.run(['--no-start']); assert.equal(refreshed.code, 0, refreshed.output);
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.readFileSync(path.join(f.dataDir, '.env'), 'utf8'), environment);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'releases/last-success.json'), 'utf8'), baseline);
  assert.ok(fs.existsSync(path.join(f.dataDir, 'bin/lib/release-transaction.mjs')));
});

test('--no-start prints only four preparation stages and clearly states what was skipped', async t => {
  const f = fixture(t);
  const { code, output } = await f.run(['--no-start']);
  assert.equal(code, 0, output);
  assert.deepEqual([...output.matchAll(/\[(\d)\/4\] (?!完成：)/g)].map(m => Number(m[1])), [1, 2, 3, 4]);
  assert.deepEqual([...output.matchAll(/\[(\d+)%\] \[\d\/4\] (?!完成：)/g)].map(m => Number(m[1])), [0, 25, 50, 75]);
  assert.match(output, /\[100%\] \[4\/4\] 完成：/);
  assert.match(output, /百分比仅表示安装准备进度/);
  assert.match(output, /已按 --no-start 跳过镜像构建、服务启动及健康检查/);
  assert.ok(!f.calls().some(c => c.args.includes('up') || c.args.includes('build') || c.args.includes('exec')));
});

test('Agent and HTTPS configuration are passed to build, startup and setup-link commands', async t => {
  const f = fixture(t);
  const { code, output } = await f.run(['--build-from-source', '--agent', '--domain', 'learn.example.com']);
  assert.equal(code, 0, output);
  assert.ok(output.indexOf('mock: sandbox build output') < output.indexOf('mock: application build output'));
  for (const call of f.calls().filter(c => c.args.some(arg => ['build', 'up', 'exec'].includes(arg)) && c.args[0] === 'compose')) {
    assert.ok(call.args.includes(path.join(root, 'compose.prod.yaml')));
    assert.ok(call.args.includes(path.join(root, 'compose.agent.yaml')));
    assert.ok(call.args.includes(path.join(root, 'compose.build.yaml')));
  }
  const env = fs.readFileSync(path.join(f.dataDir, '.env'), 'utf8');
  const token = env.match(/^SANDBOX_TOKEN=(.+)$/m)[1];
  assert.ok(!output.includes(token), 'stage logs must not expose secrets');
  assert.match(env, /^PUBLIC_ORIGIN=https:\/\/learn.example.com$/m);
});

test('rerunning keeps existing configuration and never prints its credentials', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.dataDir);
  const env = 'APP_VERSION=custom\nWANGKE_IMAGE=custom:tag\nMODEL_API_KEY=private-fixture-key\nMAX_FILE_BYTES=100\n';
  fs.writeFileSync(path.join(f.dataDir, '.env'), env);
  const { code, output } = await f.run(['--no-start']);
  assert.equal(code, 0, output);
  const updated = fs.readFileSync(path.join(f.dataDir, '.env'), 'utf8');
  assert.ok(updated.startsWith(env));
  assert.match(updated, /^WANGKE_API_IMAGE=wangke-agent-api:custom$/m);
  assert.match(updated, /^WANGKE_WEB_IMAGE=wangke-agent-web:custom$/m);
  assert.match(output, /检测到已有配置/);
  assert.ok(!output.includes('private-fixture-key'));
});

for (const [stage, step, name] of [
  ['info', 1, '检查安装参数与运行环境'],
  ['sandbox', 5, '准备独立服务镜像'],
  ['build', 5, '准备独立服务镜像'],
  ['pull', 5, '准备独立服务镜像'],
  ['wait', 6, '启动服务并等待健康检查'],
  ['link', 7, '读取初始化入口'],
]) {
  test(`failure at ${stage} reports the exact stage and never prints success`, async t => {
    const f = fixture(t);
    const args = stage === 'sandbox' ? ['--build-from-source', '--agent'] : stage === 'build' ? ['--build-from-source'] : [];
    const { code, output } = await f.run(args, { MOCK_FAIL: stage });
    assert.equal(code, stage === 'info' ? 1 : 23, output);
    assert.ok(output.includes(`安装未完成：停在 [${step}/7] ${name}`), output);
    assert.ok(output.includes(`[${Math.floor((step - 1) * 100 / 7)}%] 安装未完成`), 'failures retain the last completed-step percentage');
    assert.ok(!output.includes('[100%]'), 'failed runs never reach 100%');
    assert.ok(!output.includes('安装完成（'));
    const calls = f.calls();
    if (stage === 'build' || stage === 'sandbox') assert.ok(!calls.some(c => c.args.includes('up')));
    if (stage === 'wait') assert.ok(!calls.some(c => c.args.includes('exec')));
  });
}

test('invalid options fail in preflight without changing files or invoking Docker', async t => {
  const f = fixture(t);
  const { code, output } = await f.run(['--port', '70000']);
  assert.equal(code, 2);
  assert.match(output, /安装未完成：停在 \[1\/7\] 检查安装参数与运行环境/);
  assert.match(output, /\[0%\] 安装未完成/);
  assert.equal(fs.existsSync(f.dataDir), false);
  assert.deepEqual(f.calls(), []);
});
