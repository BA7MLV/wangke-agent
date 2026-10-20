// node --test scripts/test-bilibili-userscript.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../userscript/wangke-bili-bridge.user.js', import.meta.url), 'utf8');
function bridge(response) {
  const context = vm.createContext({
    Blob, TextDecoder, navigator: { userAgent: 'test' }, console: { log() {} },
    document: { documentElement: { getAttribute: () => '1' } },
    window: {}, unsafeWindow: {},
    GM_xmlhttpRequest: ({ onload }) => onload({ status: 200, response, responseHeaders: '' }),
  });
  vm.runInContext(script, context);
  return context.window.__wangkeBiliBridge;
}

test('不同 realm 的 ArrayBuffer 不丢失数据', async () => {
  const bytes = new TextEncoder().encode('{"ok":true}');
  const api = bridge(bytes.buffer);
  const result = await api.fetch('https://example.test/');
  assert.equal(JSON.stringify(await result.json()), '{"ok":true}');
  assert.equal((await result.arrayBuffer()).byteLength, bytes.length);
});

test('TypedArray 只读取对应视图的字节范围', async () => {
  const api = bridge(new Uint8Array([0, 1, 2, 3]).subarray(1, 3));
  const result = await api.fetch('https://example.test/');
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [1, 2]);
});

test('不支持的响应类型抛出诊断错误，不伪装为空响应', async () => {
  await assert.rejects(bridge('not a buffer').fetch('https://example.test/'), /无法识别的二进制响应/);
});

test('安装入口与源脚本保持一致', () => {
  assert.equal(fs.readFileSync(new URL('../public/wangke-bili-bridge.user.js', import.meta.url), 'utf8'), script);
});
