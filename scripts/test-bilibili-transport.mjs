// transport.ts：油猴桥优先、代理回退。用法：node scripts/test-bilibili-transport.mjs

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `test-bilibili-transport-${Date.now()}.mjs`);
execSync(
  `node_modules/.bin/esbuild src/bilibili/transport.ts --bundle --platform=node --format=esm --outfile=${tmp}`,
  { cwd: root, stdio: 'inherit' },
);
const t = await import(tmp);

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${label}（${JSON.stringify(a)}）`);
}

function makeProxyFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      body: null,
      json: async () => ({ code: 0, data: { ok: true } }),
      text: async () => 'proxy-text',
      blob: async () => new Blob(['proxy']),
    };
  };
}

console.log('describeTransport');
{
  const d = t.describeTransport({ proxy: '', bridge: null });
  ok(d.kind === 'none', '都没有 → none');
  ok(typeof d.hint === 'string' && d.hint.includes('油猴'), '提示提到油猴');
}
{
  const d = t.describeTransport({ proxy: 'https://p.example', bridge: null });
  eq(d.kind, 'proxy', '仅代理 → proxy');
}
{
  const d = t.describeTransport({
    proxy: 'https://p.example',
    bridge: { version: '1.0.0', fetch: async () => ({}) },
  });
  eq(d.kind, 'bridge', '桥+代理 → 优先 bridge');
}

console.log('biliRequest：无出口');
{
  let msg = '';
  try {
    await t.biliRequest({ proxy: '', bridge: null }, 'https://api.bilibili.com/x/web-interface/view?bvid=BV1');
  } catch (e) {
    msg = e.message;
  }
  ok(msg.includes('油猴') || msg.includes('脚本'), '报错提到油猴脚本');
  ok(msg.includes('代理'), '报错也提到代理回退');
}

console.log('biliRequest：仅代理');
{
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = makeProxyFetch(calls);
  try {
    const resp = await t.biliRequest(
      { proxy: 'https://proxy.example.com', cookie: 'SESSDATA=x', bridge: null },
      'https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD',
    );
    ok(resp.ok, '代理响应 ok');
    ok(calls[0].url.startsWith('https://proxy.example.com?url='), '走 ?url= 协议');
    ok(calls[0].url.includes(encodeURIComponent('bvid=BV1xx411c7mD')), '目标 URL 编码进 query');
    eq(calls[0].init.headers['X-Bili-Cookie'], 'SESSDATA=x', 'Cookie 走 X-Bili-Cookie');
  } finally {
    globalThis.fetch = orig;
  }
}

console.log('biliRequest：仅油猴桥');
{
  const calls = [];
  const bridge = {
    version: '1.0.0',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0 }),
        text: async () => 'bridge-text',
        arrayBuffer: async () => new TextEncoder().encode('bridge').buffer,
      };
    },
  };
  const orig = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('不应走 fetch'); };
  try {
    const resp = await t.biliRequest(
      { proxy: '', cookie: 'SESSDATA=y', bridge },
      'https://api.bilibili.com/x/player/playurl?bvid=BV1&cid=1',
    );
    ok(resp.ok, '桥响应 ok');
    ok(!fetchCalled, '有桥时不走 window.fetch');
    eq(calls[0].url, 'https://api.bilibili.com/x/player/playurl?bvid=BV1&cid=1', '桥拿到原始目标 URL');
    eq(calls[0].init.cookie, 'SESSDATA=y', 'Cookie 交给桥');
    eq(await resp.text(), 'bridge-text', 'text 透传');
  } finally {
    globalThis.fetch = orig;
  }
}

console.log('biliRequest：桥优先于代理');
{
  const bridgeCalls = [];
  const bridge = {
    version: '1.0.0',
    fetch: async (url, init) => {
      bridgeCalls.push({ url, init });
      return { ok: true, status: 200, text: async () => 'from-bridge', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    },
  };
  const orig = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('不应走代理'); };
  try {
    await t.biliRequest(
      { proxy: 'https://proxy.example.com', bridge },
      'https://upos-sz-mirrorcos.bilivideo.com/v.m4s',
    );
    ok(!fetchCalled, '有桥时不走代理 fetch');
    eq(bridgeCalls.length, 1, '只打一次桥');
  } finally {
    globalThis.fetch = orig;
  }
}

console.log('isBiliBridgeAvailable');
{
  delete globalThis.__wangkeBiliBridge;
  ok(t.isBiliBridgeAvailable() === false, '全局无桥 → false');
  globalThis.__wangkeBiliBridge = { version: '1.0.0', fetch: async () => ({}) };
  ok(t.isBiliBridgeAvailable() === true, '全局有桥 → true');
  delete globalThis.__wangkeBiliBridge;
}

fs.rmSync(tmp, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
