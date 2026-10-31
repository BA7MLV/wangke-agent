import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { WebSearchConfiguration } from '../apps/api/src/web-search/config.ts';
import { WebSearchService } from '../apps/api/src/web-search/service.ts';
import { fetchPage, publicAddress, publicUrl } from '../apps/api/src/web-search/fetch.ts';
import { normalizeSources, boundedText } from '../apps/api/src/web-search/providers.ts';
import { ToolTraceLedger } from '../apps/web/src/utils/toolTrace.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-web-search-'));
const store = new DatabaseStore(path.join(dir, 'app.sqlite'));
const cloud = new CloudConfiguration(store, path.join(dir, 'config'));
const configuration = new WebSearchConfiguration(store, cloud);
const owner = crypto.randomUUID(), other = crypto.randomUUID(), at = new Date().toISOString();
let runner;
try {
  for (const id of [owner, other]) store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, 'Test', at);
  assert.equal(configuration.get(owner).enabled, false);
  let config = configuration.save(owner, { ...configuration.get(owner), enabled: true, fetchEnabled: true, providerId: 't', providers: [
    { id: 't', kind: 'tavily', name: 'Tavily', enabled: true, apiKey: 'secret-test-key' },
    { id: 'b', kind: 'brave', name: 'Brave', enabled: true, apiKey: 'secret-brave' },
    { id: 's', kind: 'searxng', name: 'Self hosted', enabled: true, baseUrl: 'http://localhost:8888' },
  ] });
  assert.ok(!JSON.stringify(config).includes('secret-test-key'));
  assert.ok(!store.db.prepare('SELECT value FROM web_search_config WHERE owner_id=?').get(owner).value.includes('secret-test-key'));
  assert.equal(configuration.get(other).providers.length, 0);
  const stale = config;
  config = configuration.save(owner, { ...config, fallback: true });
  assert.equal(configuration.get(owner, true).providers[0].apiKey, 'secret-test-key');
  assert.throws(() => configuration.save(owner, stale), /web_config_conflict/);

  const requests = [];
  const service = new WebSearchService(configuration, async (url, init) => {
    requests.push({ url, init });
    if (url.includes('tavily')) return new Response('', { status: 429 });
    return Response.json({ type: 'search', web: { results: [
      { title: '<b>Useful result</b>', url: 'https://example.org/article#one', description: '<script>bad()</script>Verified excerpt' },
      { title: 'Duplicate', url: 'https://example.org/article#two', description: 'duplicate' },
      { title: 'Unsafe', url: 'javascript:alert(1)', description: 'unsafe' },
    ] } });
  });
  assert.deepEqual(service.definitions(owner, true).map(t => t.function.name), ['websearch', 'webfetch']);
  assert.equal(service.definitions(owner, false).length, 0);
  const result = await service.call(owner, 'websearch', { query: 'test query' }, new AbortController().signal, () => true);
  assert.equal(result.provider, 'Brave'); assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].title, 'Useful result'); assert.equal(result.sources[0].snippet, 'Verified excerpt');
  assert.equal(JSON.parse(requests[0].init.body).search_depth, 'basic');
  assert.equal(requests[0].init.headers.authorization, 'Bearer secret-test-key');
  assert.equal(requests[1].init.headers['X-Subscription-Token'], 'secret-brave');
  assert.equal(requests[0].init.redirect, 'error');
  await assert.rejects(service.call(owner, 'websearch', { query: 'test' }, new AbortController().signal, () => false), /web_network_denied/);
  await assert.rejects(service.call(owner, 'websearch', { query: 'test', limit: 100 }, new AbortController().signal, () => true), /web_invalid_arguments/);
  let count = 0;
  const auth = new WebSearchService(configuration, async () => { count++; return new Response('secret upstream', { status: 401 }); });
  await assert.rejects(auth.call(owner, 'websearch', { query: 'test' }, new AbortController().signal, () => true), /web_auth_failed/); assert.equal(count, 1);
  const empty = new WebSearchService(configuration, async () => { count++; return Response.json({ results: [] }); });
  count = 0; assert.equal((await empty.call(owner, 'websearch', { query: 'test' }, new AbortController().signal, () => true)).sources.length, 0); assert.equal(count, 1);
  config = configuration.save(owner, { ...configuration.get(owner), providerId: 's' });
  const self = new WebSearchService(configuration, async url => { assert.equal(new URL(url).pathname, '/search'); assert.equal(new URL(url).searchParams.get('format'), 'json'); return Response.json({ results: [] }); });
  await self.call(owner, 'websearch', { query: '中文 query' }, new AbortController().signal, () => true);
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const bounded = new WebSearchService(configuration, async () => { await barrier; return Response.json({ results: [] }); });
  const active = Array.from({ length: 4 }, () => bounded.call(owner, 'websearch', { query: 'parallel' }, new AbortController().signal, () => true));
  await assert.rejects(bounded.call(owner, 'websearch', { query: 'overflow' }, new AbortController().signal, () => true), /web_busy/);
  release(); await Promise.all(active);
  await bounded.call(owner, 'websearch', { query: 'slot released' }, new AbortController().signal, () => true);
  config = configuration.save(owner, { ...configuration.get(owner), providers: configuration.get(owner).providers.map(p => p.id === 's' ? { ...p, apiKey: 'endpoint-secret' } : p) });
  config = configuration.save(owner, { ...config, providers: config.providers.map(p => p.id === 's' ? { ...p, baseUrl: 'http://localhost:8889' } : p) });
  assert.equal(configuration.get(owner, true).providers.find(p => p.id === 's').apiKey, '', 'changing an endpoint clears its old credential');

  const controller = new AbortController();
  const pending = new WebSearchService(configuration, async (_url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); }));
  const operation = pending.call(owner, 'websearch', { query: 'cancel' }, controller.signal, () => true);
  controller.abort(); await assert.rejects(operation, /abort/i);
  let allowed = true;
  const revoked = new WebSearchService(configuration, async () => { allowed = false; return Response.json({ results: [] }); });
  await assert.rejects(revoked.call(owner, 'websearch', { query: 'revoke' }, new AbortController().signal, () => allowed), /web_config_conflict/);

  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1', '100.64.0.1', '0.0.0.0']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  for (const url of ['http://127.1', 'http://2130706433', 'http://[::1]', 'http://a:secret@example.org', 'file:///etc/passwd', 'http://example.org:8080']) assert.throws(() => publicUrl(url));
  await assert.rejects(fetchPage('https://example.org', new AbortController().signal, async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest' } })), /web_address_denied/);
  const page = await fetchPage('https://example.org', new AbortController().signal, async () => new Response('<html><head><title>Article</title></head><body><article><h1>Article</h1><p>A useful public document.</p></article><script>secretScript()</script></body></html>', { headers: { 'content-type': 'text/html' } }));
  assert.equal(page.title, 'Article'); assert.ok(page.content.includes('useful public document')); assert.ok(!page.content.includes('secretScript'));
  await assert.rejects(fetchPage('https://example.org', new AbortController().signal, async () => new Response('binary', { headers: { 'content-type': 'application/octet-stream' } })), /web_unsupported_content/);
  await assert.rejects(boundedText(new Response('x'.repeat(11)), 10), /web_response_too_large/);
  const ledger = new ToolTraceLedger(); ledger.start('a', 'websearch', '{"query":"test"}'); ledger.finish('a', JSON.stringify(result));
  assert.equal(ledger.calls[0].webSearch.sources[0].url, 'https://example.org/article');
  assert.equal(normalizeSources([{ url: 'https://user:password@example.org', title: 'bad' }], 6).length, 0);

  // The real Bot loop advertises, executes, persists and delivers sources before its answer.
  cloud.save(owner, { ...cloud.get(owner), providers: [{ id: 'mock', name: 'Mock', baseUrl: 'https://model.example', apiKey: 'key', protocol: 'openai-chat', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'mock', model: 'mock' } });
  const bot = new BotApplicationService(store, { enqueue() {} });
  const thread = bot.create(owner, 'bot', 'Search'); bot.send(owner, thread.id, { clientNonce: crypto.randomUUID(), content: 'Search for current information' });
  runner = new BotRunner(store, { configuration: cloud, webSearch: new WebSearchService(configuration, async () => Response.json({ results: [{ title: 'Source', url: 'https://example.org/article', content: 'Useful evidence' }] })), fetch: async (_url, init) => {
    const body = JSON.parse(init.body), found = body.messages.some(m => m.role === 'tool');
    assert.ok(body.tools.some(t => t.function.name === 'websearch'));
    return Response.json({ choices: [{ message: found ? { content: 'Answer with source https://example.org/article' } : { tool_calls: [{ id: 'web', type: 'function', function: { name: 'websearch', arguments: '{"query":"current information"}' } }] } }] });
  } });
  runner.start();
  for (let i = 0; i < 200 && store.db.prepare('SELECT status FROM runs WHERE thread_id=?').get(thread.id).status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  await runner.close();
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE thread_id=?').get(thread.id).status, 'completed');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id=? AND kind='web_sources'").get(thread.id).n, 1);
  console.log('Web search: encrypted settings, isolation, revisions, adapters, fallback, cancellation, limits, public-page protection, durable sources and Bot loop passed');
} finally { await runner?.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
