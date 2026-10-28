// 真实浏览器 OPFS / IndexedDB 回归：node scripts/test-file-store.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const server = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use('/__file_test', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>File storage regression</title>');
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
try {
  for (const engine of [chromium, webkit]) {
      for (const mode of ['native', 'worker', 'fallback', 'no-opfs', 'quota', 'close-failure']) {
        // WebKit 的临时无痕上下文不支持 IndexedDB Blob；使用隔离的持久化配置。
        const profile = await mkdtemp(join(tmpdir(), 'file-store-'));
        const context = await engine.launchPersistentContext(profile);
        try {
          const page = await context.newPage();
          await page.goto(`${base}/__file_test`);
          const result = await page.evaluate(async (mode) => {
            const check = (value, message) => { if (!value) throw new Error(message); };
            const proto = FileSystemFileHandle.prototype;
            if (mode === 'worker' || mode === 'fallback') {
              Object.defineProperty(proto, 'createWritable', { configurable: true, value: undefined });
            }
            if (mode === 'fallback') {
              // 模拟两种 OPFS 写入接口都不支持。
              window.Worker = class {
                postMessage() { queueMicrotask(() => this.onmessage({ data: { type: 'unsupported' } })); }
                terminate() {}
              };
            }
            if (mode === 'no-opfs') {
              Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined });
            }
            if (mode === 'quota') {
              Object.defineProperty(proto, 'createWritable', { configurable: true, value: async () => {
                throw new DOMException('quota', 'QuotaExceededError');
              } });
            }
            if (mode === 'close-failure') {
              Object.defineProperty(proto, 'createWritable', { configurable: true, value: async () => ({
                write: async () => {},
                close: async () => { throw new DOMException('disk failure', 'UnknownError'); },
                abort: async () => {},
              }) });
            }
            const store = await import('/src/store/fileStore.ts');
            const { db } = await import('/src/store/db.ts');
            const bytes = new Uint8Array(9 * 1024 * 1024 + 17);
            for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
            const blob = new Blob([bytes]);
            const progress = [];
            if (mode === 'quota' || mode === 'close-failure') {
              let failure;
              try { await store.saveVideoFile('failed', blob, (p) => progress.push(p)); }
              catch (e) { failure = e; }
              check(failure, 'write should reject');
              check(!progress.includes(1), 'must not report completion before commit');
              check(await store.getVideoFile('failed') === null, 'partial file must be removed');
              if (mode === 'quota') check(failure.message.includes('空间不足'), 'actionable quota message');
              return mode;
            }
            await store.saveVideoFile('video', blob, (p) => progress.push(p));
            check(progress[0] === 0 && progress.at(-1) === 1, 'progress endpoints');
            check(progress.slice(0, -1).every(p => p < 1), 'completion only after commit');
            check(progress.every((p, i) => !i || p >= progress[i - 1]), 'monotonic progress');
            const read = new Uint8Array(await (await store.getVideoFile('video')).arrayBuffer());
            check(read.length === bytes.length && read.every((b, i) => b === bytes[i]), 'byte-for-byte round trip');
            if (mode === 'worker') {
              check(!(await db.files.get('video')), 'worker must write real OPFS, not IndexedDB');
              check(progress.length > 2, 'chunk progress');
            }
            if (mode === 'fallback' || mode === 'no-opfs') {
              check(await db.files.get('video'), 'fallback persists in IndexedDB');
            }
            await store.saveVideoFile('video', new Blob(['replacement']));
            check(await (await store.getVideoFile('video')).text() === 'replacement', 'overwrite truncates old content');
            await store.saveMaterialFile('material', new Blob([]));
            check((await store.getMaterialFile('material')).size === 0, 'empty materials supported');
            if (mode !== 'no-opfs') {
              const root = await navigator.storage.getDirectory();
              const dir = await root.getDirectoryHandle('videos', { create: true });
              await dir.getFileHandle('legacy', { create: true });
              await db.files.put({ id: 'legacy', blob: new Blob(['valid legacy data']) });
              check(await (await store.getVideoFile('legacy')).text() === 'valid legacy data', 'empty OPFS must not shadow legacy data');
              check(await db.files.get('legacy'), 'read must retain fallback data');
            }
            await store.deleteVideoFile('video');
            check(await store.getVideoFile('video') === null, 'delete both stores');
            await store.deleteMaterialFile('material');
            return mode;
          }, mode);
          assert.equal(result, mode);
          console.log(`PASS ${engine.name()} ${mode}`);
        } finally {
          await context.close();
          await rm(profile, { recursive: true, force: true });
        }
      }
  }
} finally {
  await server.close();
}
