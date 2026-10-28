import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/wangke-web-update-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, '.env'), 'WANGKE_WEB_IMAGE=fixture/web@sha256:abc\n');
  const log = path.join(directory, 'calls.jsonl');
  fs.writeFileSync(path.join(directory, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.MOCK_LOG;
const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\\n').map(JSON.parse) : [];
fs.appendFileSync(file, JSON.stringify(args) + '\\n');
if (args.includes('ps')) console.log('web-fixture');
if (args[0] === 'inspect') console.log('sha256:previous');
if (process.env.FAIL_WEB === '1' && args.includes('up') && !previous.some(x => x.includes('up'))) process.exit(23);
`, { mode: 0o700 });
  return {
    run(args, env = {}) {
      return spawnSync('/bin/bash', ['scripts/wangke-agent', '--data-dir', directory, '--compose-file', path.resolve('compose.yaml'), ...args], {
        encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MOCK_LOG: log, ...env },
      });
    },
    calls() { return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []; },
  };
}

test('Web-only update pulls and replaces only Web, with no backup, API or edge restart', t => {
  const f = fixture(t), result = f.run(['update', 'web']);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.equal(calls.filter(x => x.includes('pull')).length, 1);
  const up = calls.find(x => x.includes('up'));
  assert.deepEqual(up.slice(up.indexOf('up')), ['up', '-d', '--no-deps', '--no-build', '--wait', '--wait-timeout', '180', 'web']);
  assert.ok(!calls.some(x => x.includes('stop') || x.includes('restart') || x.includes('api') || x.includes('proxy')));
});

test('failed readiness rolls Web back to the previous immutable local image ID', t => {
  const f = fixture(t), result = f.run(['update', 'web'], { FAIL_WEB: '1' });
  assert.equal(result.status, 1);
  const ups = f.calls().filter(x => x.includes('up'));
  assert.equal(ups.length, 2);
  assert.ok(ups[1].some(x => x.includes('web-rollback.')));
  for (const up of ups) assert.equal(up.at(-1), 'web');
});

test('implicit full replacement is rejected rather than starting multiple API schedulers', t => {
  const f = fixture(t), result = f.run(['update']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /single-instance/);
  assert.deepEqual(f.calls(), []);
});

test('preloaded transport cannot silently pull a mutable legacy Web tag', t => {
  const f = fixture(t), result = f.run(['--preloaded', 'update', 'web']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /immutable release manifest/);
  assert.deepEqual(f.calls(), []);
});
