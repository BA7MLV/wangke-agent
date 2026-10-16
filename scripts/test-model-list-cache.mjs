#!/usr/bin/env node
/**
 * 模型列表缓存（`src/api/modelListCache.ts`）的纯逻辑测试，不需要 API key。
 *
 * 守的是四件事，每一件都对应一个具体的失败模式：
 *
 * 1. **键是归一化后的 baseUrl** —— `https://a/v1` 与 `https://a/v1/` 必须命中同一条。
 *    不归一化的话，用户在地址末尾补一个斜杠就等于换了供应商，缓存白存。
 * 2. **不拿 provider.id 当键**（脚本没法直接断言「没写 id」，但下面用「换个 id 读同一个
 *    地址仍命中」来钉住这条性质：键只由地址决定）。
 * 3. **版本不符整体作废** —— 结构变了却读到老缓存，是「能力数据凭空失效」那类静默 bug
 *    的同源问题（见 `api/modelMeta.ts` 的 v2→v3 记录）。
 * 4. **过期只标记 stale、不清空** —— 过期数据仍要能顶着用（离线时它是唯一能显示的候选）。
 *
 * 另外钉两条容易写错的细节：**空列表也要存**（「这家一个模型都没有」是有意义的结论）、
 * **缓存里不许出现 apiKey**（凭空多一份凭据副本，而这份缓存的用途只是省一次网络往返）。
 *
 * 用法：node scripts/test-model-list-cache.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// 草稿目录是 `scripts/.cache` 根（不能再往下挪一层）：入口文件里写的是 `'../../src/...'`
// 相对 import，深度一变就错位。只删自己的产物，不整目录删（那会连带删掉 e2e-all 的报告）。
const dir = join(here, '.cache');
const entry = join(dir, 'model-list-cache-entry.ts');
const outfile = join(dir, 'model-list-cache-bundle.mjs');
mkdirSync(dir, { recursive: true });

/**
 * localStorage 的最小实现（带真实读写）。
 *
 * 必须是**可读回**的：这个模块的行为有一半是「写了之后读得回来」，
 * 用 `setItem: () => {}` 那种空壳会让下面一半断言变成永远成立的空话。
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

writeFileSync(
  entry,
  `export {
  MODEL_LIST_CACHE_VERSION,
  readModelList,
  writeModelList,
  dropModelList,
  pruneModelLists,
  __resetModelListCacheForTest,
} from '../../src/api/modelListCache';
`,
);

{
  const { build } = await import('esbuild');
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
}

const {
  MODEL_LIST_CACHE_VERSION,
  readModelList,
  writeModelList,
  dropModelList,
  pruneModelLists,
  __resetModelListCacheForTest,
} = await import(`${outfile}?t=${Date.now()}`);

const CACHE_KEY = 'wangke-model-list';

let failed = 0;
const ok = (m) => console.log(`✅ ${m}`);
const fail = (m) => {
  console.error(`❌ ${m}`);
  failed++;
};
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (e) {
    fail(`${name}\n   ${e.message}`);
  }
};

/** 每个用例都从「空 localStorage + 空内存」开始，避免用例之间互相污染 */
const reset = () => {
  store.clear();
  __resetModelListCacheForTest();
};

// ── 1. 写了读得回来 ────────────────────────────────────────────────────────
reset();
check('写过的端点能读回同一份列表', () => {
  writeModelList('https://api.a.com/v1', ['m1', 'm2', 'm3']);
  const hit = readModelList('https://api.a.com/v1');
  assert.deepEqual(hit?.ids, ['m1', 'm2', 'm3']);
  assert.equal(hit?.stale, false);
});

check('没写过的端点返回 null（而不是空数组）', () => {
  assert.equal(readModelList('https://api.never.com/v1'), null);
});

// ── 2. 键归一化 ────────────────────────────────────────────────────────────
reset();
check('尾部斜杠不影响命中：https://a/v1 ≡ https://a/v1/', () => {
  writeModelList('https://api.a.com/v1', ['m1']);
  assert.deepEqual(readModelList('https://api.a.com/v1/')?.ids, ['m1']);
});

check('首尾空白不影响命中', () => {
  writeModelList('https://api.a.com/v1', ['m1']);
  assert.deepEqual(readModelList('  https://api.a.com/v1  ')?.ids, ['m1']);
});

check('键只由地址决定，与 provider.id 无关（换个 id 读同一个地址仍命中）', () => {
  // 「provider.id」是调用方的事，这个模块压根看不到它 —— 下面用两次不同调用点
  // 读同一个地址来钉住「地址是唯一身份」这条性质。
  writeModelList('https://api.a.com/v1', ['m1']);
  assert.deepEqual(readModelList('https://api.a.com/v1')?.ids, ['m1']);
  assert.deepEqual(readModelList('https://api.a.com/v1/')?.ids, ['m1']);
});

check('空 baseUrl 不写也不读（免得把一份列表存到空键上）', () => {
  reset();
  writeModelList('   ', ['m1']);
  assert.equal(readModelList(''), null);
  assert.equal(localStorage.getItem(CACHE_KEY), null);
});

// ── 3. 空列表也是一个结论 ──────────────────────────────────────────────────
reset();
check('空列表照常存下来（「这家一个模型都没有」值得记住）', () => {
  writeModelList('https://api.empty.com/v1', []);
  const hit = readModelList('https://api.empty.com/v1');
  assert.deepEqual(hit?.ids, []);
  assert.equal(hit?.stale, false);
});

// ── 4. 缓存里不许出现 apiKey ───────────────────────────────────────────────
reset();
check('缓存载荷里不含任何凭据（只存 ids 与时间戳）', () => {
  writeModelList('https://api.a.com/v1', ['m1']);
  const raw = localStorage.getItem(CACHE_KEY) ?? '';
  assert.ok(!raw.includes('sk-'), `缓存里出现了疑似 key：${raw}`);
  const parsed = JSON.parse(raw);
  const entryValue = Object.values(parsed.entries)[0];
  assert.deepEqual(Object.keys(entryValue).sort(), ['ids', 'updatedAt']);
});

// ── 5. 版本不符整体作废 ────────────────────────────────────────────────────
reset();
check('版本对不上就当没有（老结构不能被误读）', () => {
  localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ version: MODEL_LIST_CACHE_VERSION - 1, entries: { 'https://api.a.com/v1': { ids: ['old'], updatedAt: Date.now() } } }),
  );
  __resetModelListCacheForTest();
  assert.equal(readModelList('https://api.a.com/v1'), null);
});

check('结构损坏（不是 JSON）时按空缓存处理，不抛错', () => {
  localStorage.setItem(CACHE_KEY, '{ 这不是 json');
  __resetModelListCacheForTest();
  assert.equal(readModelList('https://api.a.com/v1'), null);
  // 损坏之后仍然能正常写入（否则一次坏数据会让缓存永久瘫痪）
  writeModelList('https://api.a.com/v1', ['m9']);
  assert.deepEqual(readModelList('https://api.a.com/v1')?.ids, ['m9']);
});

// ── 6. 过期只标记，不清空 ──────────────────────────────────────────────────
reset();
check('超过 TTL 标 stale=true，但 ids 照样读得出来（离线时它是唯一能显示的候选）', () => {
  const old = Date.now() - 25 * 3600 * 1000; // 25h > 24h TTL
  localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ version: MODEL_LIST_CACHE_VERSION, entries: { 'https://api.a.com/v1': { ids: ['m1'], updatedAt: old } } }),
  );
  __resetModelListCacheForTest();
  const hit = readModelList('https://api.a.com/v1');
  assert.equal(hit?.stale, true);
  assert.deepEqual(hit?.ids, ['m1']);
});

check('刚好在 TTL 内不算过期', () => {
  const fresh = Date.now() - 23 * 3600 * 1000;
  localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ version: MODEL_LIST_CACHE_VERSION, entries: { 'https://api.a.com/v1': { ids: ['m1'], updatedAt: fresh } } }),
  );
  __resetModelListCacheForTest();
  assert.equal(readModelList('https://api.a.com/v1')?.stale, false);
});

// ── 7. 删除 ────────────────────────────────────────────────────────────────
reset();
check('dropModelList 只删这一家，别家不受影响', () => {
  writeModelList('https://api.a.com/v1', ['m1']);
  writeModelList('https://api.b.com/v1', ['m2']);
  dropModelList('https://api.a.com/v1');
  assert.equal(readModelList('https://api.a.com/v1'), null);
  assert.deepEqual(readModelList('https://api.b.com/v1')?.ids, ['m2']);
});

check('删一个不存在的条目是空操作（不抛错）', () => {
  dropModelList('https://api.never.com/v1');
  assert.deepEqual(readModelList('https://api.b.com/v1')?.ids, ['m2']);
});

// ── 8. 收口 ────────────────────────────────────────────────────────────────
reset();
check('pruneModelLists 只留下在册的端点', () => {
  writeModelList('https://api.a.com/v1', ['m1']);
  writeModelList('https://api.b.com/v1', ['m2']);
  writeModelList('https://api.gone.com/v1', ['m3']);
  pruneModelLists(['https://api.a.com/v1/', 'https://api.b.com/v1']); // 带斜杠也要认
  assert.deepEqual(readModelList('https://api.a.com/v1')?.ids, ['m1']);
  assert.deepEqual(readModelList('https://api.b.com/v1')?.ids, ['m2']);
  assert.equal(readModelList('https://api.gone.com/v1'), null);
});

check('pruneModelLists 传空数组会清空所有条目', () => {
  pruneModelLists([]);
  assert.equal(readModelList('https://api.a.com/v1'), null);
  assert.equal(readModelList('https://api.b.com/v1'), null);
});

// ── 9. 内存缓存与 localStorage 一致 ────────────────────────────────────────
reset();
check('同一个会话里连续写两次，第二次覆盖第一次', () => {
  writeModelList('https://api.a.com/v1', ['m1']);
  writeModelList('https://api.a.com/v1', ['m1', 'm2']);
  assert.deepEqual(readModelList('https://api.a.com/v1')?.ids, ['m1', 'm2']);
  // 落盘的那份也要是新的（不是只有内存更新）
  const parsed = JSON.parse(localStorage.getItem(CACHE_KEY));
  assert.deepEqual(parsed.entries['https://api.a.com/v1'].ids, ['m1', 'm2']);
});

rmSync(entry, { force: true });
rmSync(outfile, { force: true });

if (failed > 0) {
  console.error(`\n${failed} 条失败`);
  process.exit(1);
}
console.log('\n全部通过');
