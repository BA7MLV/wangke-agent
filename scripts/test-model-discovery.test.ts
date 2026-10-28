import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { discoverModels } from '../apps/web/src/api/modelDiscovery';
import { listModels } from '../apps/web/src/api/siliconflow';
import { MODEL_LIST_CACHE_VERSION, __resetModelListCacheForTest, modelListCacheKey, readModelList, writeModelList } from '../apps/web/src/api/modelListCache';

const connection = { baseUrl: 'https://models.test/v1/', apiKey: 'secret-account-a', protocol: 'openai-chat' as const };
const storage = new Map<string, string>();
const originalFetch = globalThis.fetch;
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
}, configurable: true });
beforeEach(() => { storage.clear(); __resetModelListCacheForTest(); });
afterEach(() => { globalThis.fetch = originalFetch; });

test('cache isolates credentials and protocol; normalizes URL without storing credentials', async () => {
  const key = await modelListCacheKey(connection);
  assert.equal(key, await modelListCacheKey({ ...connection, baseUrl: ' https://models.test/v1 ' }));
  assert.notEqual(key, await modelListCacheKey({ ...connection, apiKey: 'secret-account-b' }));
  assert.notEqual(key, await modelListCacheKey({ ...connection, protocol: 'anthropic-messages' }));
  writeModelList(key, ['private-model']);
  assert.ok(!JSON.stringify([...storage]).includes(connection.apiKey));
  const hit = readModelList(key)!;
  hit.ids.push('mutated');
  assert.deepEqual(readModelList(key)?.ids, ['private-model']);
});

test('validates, deduplicates, sorts, normalizes endpoint and supports Anthropic pagination', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal((init?.headers as Record<string, string>)['x-api-key'], connection.apiKey);
    return urls.length === 1
      ? json({ data: [{ id: 'z' }, { id: 'a' }], has_more: true, last_id: 'cursor/1' })
      : json({ data: [{ id: 'a' }, { id: 'b' }], has_more: false });
  };
  assert.deepEqual(await listModels({ ...connection, protocol: 'anthropic-messages' }), ['a', 'b', 'z']);
  assert.deepEqual(urls, ['https://models.test/v1/models', 'https://models.test/v1/models?after_id=cursor%2F1']);
});

test('cloud discovery uses session cookies and isolates account caches without provider keys', async () => {
  const cloud = { baseUrl: '/api/v1/cloud/models/p1', apiKey: '', credentials: 'include' as const, cacheScope: 'account-a' };
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.credentials, 'include');
    assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
    return json({ data: [{ id: 'cloud-model' }] });
  };
  assert.deepEqual(await listModels(cloud), ['cloud-model']);
  assert.notEqual(await modelListCacheKey(cloud), await modelListCacheKey({ ...cloud, cacheScope: 'account-b' }));
});

test('corrupt cache timestamps and non-string IDs are rejected', async () => {
  const key = await modelListCacheKey(connection);
  for (const entry of [
    { ids: ['x'], updatedAt: 'yesterday' },
    { ids: ['x'], updatedAt: Date.now() + 60_000 },
    { ids: ['x', 42], updatedAt: Date.now() },
    { ids: [''], updatedAt: Date.now() },
  ]) {
    storage.set('wangke-model-list', JSON.stringify({ version: MODEL_LIST_CACHE_VERSION, entries: { [key]: entry } }));
    __resetModelListCacheForTest();
    assert.equal(readModelList(key), null);
  }
});

test('invalid responses are not cached as empty successes; repeated pagination is rejected', async () => {
  for (const body of [{}, null, { data: {} }, { data: [null] }, { data: [{ id: 12 }] }, { data: [], has_more: 'yes' }]) {
    globalThis.fetch = async () => json(body);
    await assert.rejects(discoverModels(connection, new AbortController().signal));
    assert.equal(readModelList(await modelListCacheKey(connection)), null);
  }
  let count = 0;
  globalThis.fetch = async () => { count++; return json({ data: [{ id: 'x' }], has_more: true, last_id: 'x' }); };
  await assert.rejects(listModels(connection), /分页/);
  assert.equal(count, 2);
});

test('empty arrays are a successful result and can be cached', async () => {
  globalThis.fetch = async () => json({ models: [] });
  assert.deepEqual(await discoverModels(connection, new AbortController().signal), []);
  assert.deepEqual(readModelList(await modelListCacheKey(connection))?.ids, []);
});

test('deduplicates concurrent automatic/manual requests; cancelling one subscriber keeps the other alive', async () => {
  let calls = 0;
  let respond!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = async (_url, init) => {
    calls++;
    started();
    return new Promise<Response>((resolve, reject) => {
      respond = resolve;
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  };
  const first = new AbortController();
  const second = new AbortController();
  const a = discoverModels(connection, first.signal);
  const b = discoverModels(connection, second.signal);
  const rejected = assert.rejects(a, { name: 'AbortError' });
  await ready;
  // Wait for both fingerprint computations / subscriptions without a timing-dependent sleep.
  await new Promise<void>((resolve) => setImmediate(resolve));
  first.abort();
  respond(json({ data: [{ id: 'shared' }] }));
  await rejected;
  assert.deepEqual(await b, ['shared']);
  assert.equal(calls, 1);
});

test('last cancellation aborts transport and a late response cannot populate cache', async () => {
  let respond!: (response: Response) => void;
  let transportSignal: AbortSignal | null | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = async (_url, init) => {
    transportSignal = init?.signal;
    started();
    return new Promise<Response>((resolve) => { respond = resolve; });
  };
  const controller = new AbortController();
  const result = discoverModels(connection, controller.signal);
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await ready;
  controller.abort();
  await rejected;
  assert.equal(transportSignal?.aborted, true);
  respond(json({ data: [{ id: 'obsolete' }] }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(readModelList(await modelListCacheKey(connection)), null);
});

test('authentication is not retried; failure preserves previous cache', async () => {
  const key = await modelListCacheKey(connection);
  writeModelList(key, ['cached']);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ error: { message: 'invalid key' } }, 401); };
  await assert.rejects(discoverModels(connection, new AbortController().signal), /invalid key/);
  assert.equal(calls, 1);
  assert.deepEqual(readModelList(key)?.ids, ['cached']);
});

test('429 honors Retry-After and only retries once', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? json({ message: 'rate limited' }, 429, { 'Retry-After': '0' }) : json({ data: [{ id: 'ok' }] });
  };
  assert.deepEqual(await discoverModels(connection, new AbortController().signal), ['ok']);
  assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async () => { calls++; return json({ message: 'rate limited' }, 429, { 'Retry-After': '0' }); };
  await assert.rejects(discoverModels(connection, new AbortController().signal), /rate limited/);
  assert.equal(calls, 2);
});

test('total deadline aborts transport and releases the pending request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = async (_url, init) => {
    started();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  };
  const result = discoverModels(connection, new AbortController().signal);
  const rejected = assert.rejects(result, { name: 'TimeoutError' });
  await ready;
  t.mock.timers.tick(20_000);
  await rejected;
  t.mock.timers.reset();
  globalThis.fetch = async () => json({ data: [{ id: 'recovered' }] });
  assert.deepEqual(await discoverModels(connection, new AbortController().signal), ['recovered']);
});
