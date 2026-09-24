#!/usr/bin/env node
/**
 * Dexie 建表版本断言：v13 删除两张向量表。
 *
 * 「删表」是这次改动里唯一**会丢数据且改不回来**的一步：
 * schema 写错会让整个库打不开（不是某个功能坏掉，是应用直接白屏）。
 * 所以它必须有一道能在 Node 里跑的守卫，而不是靠人肉开浏览器点一遍。
 *
 * 两种情形都覆盖：
 * A. **全新安装**：v1→v13 跑完，最终 schema 里不该有这两张表。
 * B. **老库升级**（真正的风险点）：先造一个停在 v12、且两个向量表里有数据的库，
 *    再让 Dexie 打开它，断言表连同数据一起消失、且其他表不受影响。
 *
 * 运行：node scripts/test-db-schema.mjs
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { unlinkSync } from 'node:fs';

const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `test-db-schema-${Date.now()}.mjs`);

execSync(
  `node_modules/.bin/esbuild src/store/db.ts --bundle --platform=node --format=esm --outfile=${tmp}`,
  { cwd: root, stdio: 'inherit' },
);

const DB_NAME = 'wangke';
const DROPPED = ['embeddings', 'materialEmbeddings'];
/** 抽样几个必须活下来的表：一张核心表、一张 v9 的表、以及最晚建的 v12 表 */
const KEPT = ['videos', 'segments', 'materialBlocks', 'covers', 'studyDays', 'comments'];

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL - ${name}\n    ${e.message}`);
  }
}

/** 删掉同名库，保证每次从干净状态开始（fake-indexeddb 是进程内的） */
function dropDatabase(name) {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/** 造一个「停在本项目 v12」的库：包含两张要删的表，且表里有数据 */
function seedV12WithVectors() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 12);
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains('videos')) idb.createObjectStore('videos', { keyPath: 'id' });
      if (!idb.objectStoreNames.contains('segments')) {
        idb.createObjectStore('segments', { keyPath: 'id', autoIncrement: true });
      }
      if (!idb.objectStoreNames.contains('embeddings')) {
        const s = idb.createObjectStore('embeddings', { keyPath: 'id', autoIncrement: true });
        s.createIndex('videoId', 'videoId');
      }
      if (!idb.objectStoreNames.contains('materialEmbeddings')) {
        idb.createObjectStore('materialEmbeddings', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => {
      const idb = req.result;
      const tx = idb.transaction(['embeddings', 'materialEmbeddings', 'videos'], 'readwrite');
      tx.objectStore('embeddings').add({ videoId: 'v1', segmentId: 1, vector: new ArrayBuffer(8), fp: 'v1:x' });
      tx.objectStore('materialEmbeddings').add({ materialId: 'm1', blockId: 1, vector: new ArrayBuffer(8) });
      tx.objectStore('videos').put({ id: 'v1', name: '老课程', size: 1, mimeType: 'video/mp4', duration: 1, createdAt: 1, status: 'new' });
      tx.oncomplete = () => {
        idb.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 直接读原始 IDB 的 store 列表 —— 不走 Dexie，避免「Dexie 说没了」只是它自己不认 */
function rawStoreNames(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => {
      const idb = req.result;
      const names = Array.from(idb.objectStoreNames);
      idb.close();
      resolve(names);
    };
    req.onerror = () => reject(req.error);
  });
}

console.log('全新安装（v1→v13）');
await dropDatabase(DB_NAME);
await test('库能正常打开，版本号是 13', async () => {
  const { db } = await import(`${tmp}?fresh`);
  await db.open();
  assert.equal(db.verno, 13);
  await db.close();
});

await test('最终 schema 里没有两张向量表，但其他表都在', async () => {
  const stores = await rawStoreNames(DB_NAME);
  for (const t of DROPPED) assert.ok(!stores.includes(t), `不该有 ${t}`);
  for (const t of KEPT) assert.ok(stores.includes(t), `缺少 ${t}`);
});

console.log('老库升级（v12 带向量数据 → v13）');
await dropDatabase(DB_NAME);
await seedV12WithVectors();
await test('升级前：v12 库里确实有这两张表且有数据', async () => {
  const stores = await rawStoreNames(DB_NAME);
  for (const t of DROPPED) assert.ok(stores.includes(t), `预置失败：${t} 不在`);
});

await test('Dexie 打开老库后表被删掉（不抛错、不卡住）', async () => {
  const { db } = await import(`${tmp}?legacy`);
  await db.open();
  assert.equal(db.verno, 13);
  assert.ok(!db.tables.map((t) => t.name).includes('embeddings'));
  await db.close();
});

await test('底层 IDB 里两张表也真的没了', async () => {
  const stores = await rawStoreNames(DB_NAME);
  for (const t of DROPPED) assert.ok(!stores.includes(t), `${t} 应当已被删除`);
});

await test('老库里的课程数据原样保留（删表没有误伤别的表）', async () => {
  const { db } = await import(`${tmp}?verify`);
  await db.open();
  const v = await db.videos.get('v1');
  assert.equal(v?.name, '老课程');
  await db.close();
});

await test('升级后新库仍可正常读写（不是「能打开但坏了」）', async () => {
  const { db } = await import(`${tmp}?write`);
  await db.open();
  const id = await db.segments.add({ videoId: 'v1', idx: 0, start: 0, end: 1, text: '你好', status: 1 });
  const row = await db.segments.get(id);
  assert.equal(row?.text, '你好');
  await db.close();
});

unlinkSync(tmp);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
