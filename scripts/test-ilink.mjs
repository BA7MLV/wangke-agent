import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IlinkPlugin, normalizeIlink, tencentUrl } from '../apps/api/src/gateway/adapters/ilink.ts';
import { parseIlinkJson, retryAfterMs, ilinkBackoffMs } from '../apps/api/src/gateway/adapters/ilink-protocol.ts';
import { DeliveryError } from '../apps/api/src/gateway/plugin.ts';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { GatewayCore } from '../apps/api/src/gateway/core.ts';
import { registerGatewayRoutes } from '../apps/api/src/gateway/routes.ts';
import Fastify from 'fastify';

const config = { botToken: 'SECRET-bot-token', botId: 'synthetic-bot' };
const peer = { messageId: '', tenant: '', peer: 'me', chat: 'me', topic: '', direct: true, human: true, text: '', context: 'SECRET-context' };
const noFile = async () => { throw new Error('unused'); };
const wireMessage = (id, text = 'hello') => `{"message_id":${id},"from_user_id":"me","message_type":1,"context_token":"SECRET-context","item_list":[{"type":1,"text_item":{"text":${JSON.stringify(text)}}}]}`;
const batch = (ids = ['9223372036854775806', '9223372036854775807'], cursor = 'next') => `{"msgs":[${ids.map(id => wireMessage(id)).join(',')}],"get_updates_buf":${JSON.stringify(cursor)}}`;
async function until(fn) {
  for (let n = 0; n < 500; n++) { if (fn()) return; await sleep(10); }
  throw new Error('ilink_test_timeout');
}
async function observe(fetcher, options = {}) {
  const controller = new AbortController(), health = [], received = [], waits = [];
  let cursor = 'old';
  const plugin = new IlinkPlugin(noFile, fetcher, {
    random: () => 0, now: () => 1000,
    sleep: async (ms, signal) => { signal.throwIfAborted(); waits.push(ms); }, ...options.timing,
  });
  await plugin.start(config, {
    signal: controller.signal, cursor: () => cursor, updateConfig() {},
    receive(messages, next) {
      options.receive?.(messages, next);
      received.push(...messages); if (next !== undefined) cursor = next;
    },
    health(state, detail) {
      health.push({ state, ...detail });
      if (options.stop?.(state, detail) ?? state === 'connected') controller.abort();
    },
  });
  return { plugin, health, received, waits, cursor };
}

test('wire uint64 IDs stay exact, adjacent IDs stay distinct, strings and quoted user content stay untouched', () => {
  const content = '文字 "message_id":9223372036854775807 \\ \n 😀';
  const result = parseIlinkJson(`{"ret":0,"longpolling_timeout_ms":35000,"msgs":[${wireMessage('9223372036854775806', content)},${wireMessage('9223372036854775807')},${wireMessage('18446744073709551615')}],"quote":{"msg_id":9007199254740993,"svr_id":18446744073709551615}}`);
  assert.deepEqual(result.msgs.map(m => normalizeIlink(m).messageId), ['9223372036854775806', '9223372036854775807', '18446744073709551615']);
  assert.equal(result.msgs[0].item_list[0].text_item.text, content);
  assert.equal(result.quote.msg_id, '9007199254740993');
  assert.equal(result.quote.svr_id, '18446744073709551615');
  assert.equal(result.ret, 0); assert.equal(result.longpolling_timeout_ms, 35000);
  assert.equal(parseIlinkJson('{"message_\\u0069d":9007199254740993}').message_id, '9007199254740993');
  assert.equal(parseIlinkJson('{"message_id":"0000123"}').message_id, '0000123');
  assert.equal(parseIlinkJson('{"message_id":9007199254740991}').message_id, '9007199254740991');
  for (const invalid of ['-1', '1.5', '1e3', '18446744073709551616']) assert.throws(() => parseIlinkJson(`{"message_id":${invalid}}`));
  assert.throws(() => parseIlinkJson('{"message_id":1,"message_id":2}'), /Duplicate key/);
  assert.throws(() => parseIlinkJson('{"message_id":01}'));
  assert.throws(() => normalizeIlink({ message_id: 9007199254740993 }), /unsafe_platform_message_id/);
});

test('realistic HTTP 200 response without ret accepts large IDs and advances cursor', async () => {
  const result = await observe(async (_url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${config.botToken}`);
    assert.equal(JSON.parse(init.body).get_updates_buf, 'old');
    return new Response(batch());
  });
  assert.deepEqual(result.received.map(m => m.messageId), ['9223372036854775806', '9223372036854775807']);
  assert.equal(result.cursor, 'next'); assert.deepEqual(result.waits, []);
});

test('empty and missing response cursors preserve durable progress', async () => {
  for (const body of ['{"ret":0,"msgs":[]}', '{"ret":0,"msgs":[],"get_updates_buf":""}']) {
    const result = await observe(async () => new Response(body));
    assert.equal(result.cursor, 'old');
  }
});

test('malformed messages/JSON and oversized responses are diagnostic failures, never ACKed', async () => {
  for (const [body, code] of [
    ['{', 'invalid_platform_response'], ['null', 'invalid_platform_response'], ['[]', 'invalid_platform_response'],
    ['{"ret":"0"}', 'invalid_platform_response'], ['{"msgs":{}}', 'invalid_platform_response'],
    ['{"msgs":[null],"get_updates_buf":"bad"}', 'invalid_platform_message'],
    ['{"msgs":[{"message_id":1,"item_list":[null]}]}', 'invalid_platform_message'],
    ['{"msgs":[{"message_id":1,"context_token":123}]}', 'invalid_platform_message'],
    ['x'.repeat(4 * 1024 * 1024 + 1), 'response_too_large'],
  ]) {
    const result = await observe(async () => new Response(body), { stop: (_state, detail) => !!detail?.error });
    assert.equal(result.health.at(-1).error.code, code);
    assert.equal(result.health.at(-1).state, 'connection_failed');
    assert.equal(result.cursor, 'old'); assert.deepEqual(result.received, []);
  }
  let cancelled = false;
  const result = await observe(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(5 * 1024 * 1024) } }), { stop: (_s, d) => !!d?.error });
  assert.equal(result.health.at(-1).error.code, 'response_too_large'); assert.equal(cancelled, true);
});

test('idle long-poll deadline starts next poll without reconnect/backoff; successful reply establishes health', async () => {
  let calls = 0;
  const result = await observe(async (_url, init) => {
    if (++calls === 1) await sleep(1000, undefined, { signal: init.signal });
    return new Response(batch());
  }, { timing: { pollTimeoutMs: 10 } });
  assert.equal(calls, 2); assert.deepEqual(result.waits, []);
  assert.deepEqual(result.health.map(x => x.state), ['connecting', 'connected']);
});

test('body timeout after HTTP headers is a transfer failure, not an idle poll', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await observe(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
    } })), { timing: { pollTimeoutMs: 10 }, stop: (_s, d) => !!d?.error });
    assert.equal(result.health.at(-1).error.code, 'request_timeout'); assert.equal(result.cursor, 'old');
  } finally { clearTimeout(keepAlive); }
});

test('network failures expose safe categories and back off with jitter; success clears failures', async () => {
  let calls = 0;
  const result = await observe(async () => {
    if (++calls < 3) throw new TypeError('SECRET-url-and-token', { cause: { code: calls === 1 ? 'ENOTFOUND' : 'CERT_HAS_EXPIRED' } });
    return new Response(batch());
  });
  assert.deepEqual(result.waits, [500, 1000]);
  assert.deepEqual(result.health.filter(x => x.error).map(x => x.error.code), ['dns_error', 'tls_error']);
  assert.equal(JSON.stringify(result.health).includes('SECRET'), false);
  assert.equal(result.health.at(-1).consecutiveFailures, 0);
  assert.equal(ilinkBackoffMs(100, 0, () => 0), 30_000);
  assert.equal(ilinkBackoffMs(100, 0, () => 1), 60_000);
});

test('429 honors seconds and HTTP-date Retry-After; invalid values cannot create a NaN retry', async () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:09 GMT', 1000), 8000);
  for (const value of [null, '', '-1', 'Infinity', 'nonsense']) assert.equal(retryAfterMs(value, 1000), 2000);
  for (const header of ['3', 'Thu, 01 Jan 1970 00:00:09 GMT', 'nonsense']) {
    let calls = 0;
    const result = await observe(async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': header } }) : new Response(batch()));
    assert.equal(result.waits[0], retryAfterMs(header, 1000));
    assert.deepEqual(result.health[1].error, { code: 'rate_limited', httpStatus: 429 });
    assert.equal(result.health[1].retryAt, 1000 + result.waits[0]);
  }
});

test('platform codes are retained but errmsg is never exposed; permanent HTTP failures stop polling', async () => {
  const failed = await observe(async () => Response.json({ ret: -1, errcode: 12345, errmsg: 'SECRET-request-body' }), { stop: (_s, d) => !!d?.error });
  assert.deepEqual(failed.health.at(-1).error, { code: 'platform_rejected', httpStatus: 200, platformCode: 12345 });
  assert.equal(JSON.stringify(failed.health).includes('SECRET'), false);
  const forbidden = await observe(async () => new Response('SECRET', { status: 403 }), { stop: () => false });
  assert.equal(forbidden.health.at(-1).state, 'connection_failed'); assert.equal(forbidden.health.at(-1).retryAt, undefined);
  assert.deepEqual(forbidden.waits, []);
});

test('-14 or HTTP401 halts poll and all later sends until re-login; expired token omitted from QR request', async () => {
  for (const response of [() => Response.json({ ret: -14 }), () => Response.json({ errcode: -14 }), () => new Response('', { status: 401 })]) {
    let calls = 0;
    const result = await observe(async url => {
      calls++;
      if (String(url).includes('get_bot_qrcode')) throw new Error('not used');
      return response();
    }, { stop: () => false });
    assert.equal(result.health.at(-1).state, 'login_required');
    assert.deepEqual(result.waits, []);
    await assert.rejects(result.plugin.send(config, peer, { text: 'hello' }, 'id', new AbortController().signal), e => e.code === 'login_required');
    assert.equal(calls, 1);
  }
  const plugin = new IlinkPlugin(noFile, async (url, init) => {
    if (String(url).includes('get_bot_qrcode')) { assert.deepEqual(JSON.parse(init.body).local_token_list, []); return Response.json({ qrcode: 'qr', qrcode_img_content: 'https://weixin.qq.com/synthetic' }); }
    return Response.json({ ret: -14 });
  });
  await assert.rejects(plugin.send(config, peer, { text: 'hello' }, 'id', new AbortController().signal));
  assert.equal((await plugin.login(config, { action: 'qr' }, new AbortController().signal)).status, 'wait');
});

test('send ambiguity is not auto-retryable; explicit 4xx failures are terminal; 429 is safely retryable', async () => {
  const signal = new AbortController().signal;
  for (const fetcher of [
    async () => { throw new Error('SECRET'); },
    async () => new Response('{'),
    async () => new Response('', { status: 503 }),
    async () => new Response(new ReadableStream({ start(c) { c.error(new Error('SECRET-body')); } })),
  ]) {
    await assert.rejects(new IlinkPlugin(noFile, fetcher).send(config, peer, { text: 'hi' }, 'fixed-id', signal), e => e instanceof DeliveryError && e.uncertain && !e.message.includes('SECRET'));
  }
  await assert.rejects(new IlinkPlugin(noFile, async () => new Response('', { status: 400 })).send(config, peer, { text: 'hi' }, 'id', signal), e => !e.uncertain && !e.retryable);
  await assert.rejects(new IlinkPlugin(noFile, async () => new Response('', { status: 429, headers: { 'retry-after': '5' } })).send(config, peer, { text: 'hi' }, 'id', signal), e => !e.uncertain && e.retryable && e.retryAfterMs === 5000);
});

test('stop cancels poll/backoff promptly and a late response never reaches receive', async () => {
  for (const phase of ['poll', 'backoff', 'late-response']) {
    const controller = new AbortController(); let called = 0, received = 0, ready;
    const started = new Promise(resolve => { ready = resolve; });
    const plugin = new IlinkPlugin(noFile, async (_url, init) => {
      called++;
      if (phase === 'backoff') throw new Error('network');
      if (phase === 'late-response') { controller.abort(); return new Response(batch()); }
      ready(); await sleep(60_000, undefined, { signal: init.signal });
      throw new Error('unreachable');
    }, { sleep: async (ms, signal) => { ready(); await sleep(ms, undefined, { signal }); } });
    const done = plugin.start(config, { signal: controller.signal, cursor: () => 'old', receive() { received++; }, updateConfig() {}, health() {} });
    if (phase !== 'late-response') { await started; controller.abort(); }
    await done;
    assert.equal(called, 1); assert.equal(received, 0);
  }
});

test('failed media upload is safely retryable before sendmessage; CDN receives no bot credentials', async () => {
  const urls = [];
  const plugin = new IlinkPlugin(async () => ({ bytes: Buffer.from('file'), name: 'study.txt', mime: 'text/plain' }), async (url, init) => {
    urls.push(String(url));
    if (String(url).endsWith('/getuploadurl')) return Response.json({ upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload' });
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers.AuthorizationType, undefined);
    assert.equal(init.redirect, 'error');
    throw new Error('SECRET-upload-response-lost');
  });
  await assert.rejects(plugin.send(config, peer, { text: '', fileId: 'file' }, 'fixed-id', new AbortController().signal), e => e.code === 'media_upload_failed' && !e.uncertain && e.retryable);
  assert.equal(urls.some(url => url.endsWith('/sendmessage')), false);
});

test('QR states and redirects follow Tencent protocol; network errors are not disguised as wait', async () => {
  const signal = new AbortController().signal;
  for (const status of ['wait', 'scaned', 'expired', 'need_verifycode', 'verify_code_blocked', 'binded_redirect']) {
    const plugin = new IlinkPlugin(noFile, async (_url, init) => {
      assert.equal(init.headers.Authorization, undefined); assert.equal(init.method, 'GET');
      return Response.json({ status });
    });
    assert.equal((await plugin.login(config, { action: 'poll', qrcode: 'qr' }, signal)).status, status);
  }
  const plugin = new IlinkPlugin(noFile, async () => Response.json({ status: 'scaned_but_redirect', redirect_host: 'alternate.ilinkai.weixin.qq.com' }));
  assert.equal((await plugin.login(config, { action: 'poll', qrcode: 'qr' }, signal)).redirectHost, 'https://alternate.ilinkai.weixin.qq.com');
  await assert.rejects(new IlinkPlugin(noFile, async () => { throw new Error('network'); }).login(config, { action: 'poll', qrcode: 'qr' }, signal), e => e.code === 'network_error');
  for (const url of ['https://ilinkai.weixin.qq.com.evil.test', 'http://ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/path', 'https://ilinkai.weixin.qq.com?token=x', 'https://user@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:8443']) assert.throws(() => tencentUrl(url));
  await assert.rejects(plugin.login(config, { action: 'poll', qrcode: 'qr', redirectHost: 'evil.test' }, signal), /untrusted_platform_url/);
});

function fixture(t, factory) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ilink-regression-'));
  const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const secrets = new CloudConfiguration(store, path.join(directory, 'config'));
  const at = new Date().toISOString();
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run('owner', 'owner', at);
  store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('agent', 'owner', 'agent', 'study', 'Study', at, at);
  const bot = new BotApplicationService(store, { enqueue() {}, cancel() {} });
  const gateway = new GatewayCore(store, secrets, bot, { ilink: factory }, path.join(directory, 'files'));
  t.after(async () => { await gateway.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, secrets, bot, gateway };
}

test('durable end-to-end: uint64 pair + message, SQL rollback/replay, stable cursor and dedupe across restart', async t => {
  let wire, requests = 0, sent = 0, recovered = false;
  const seenCursors = [];
  const { store, secrets, gateway } = fixture(t, () => new IlinkPlugin(noFile, async (url, init) => {
    if (String(url).endsWith('/sendmessage')) { sent++; return Response.json({ ret: 0 }); }
    if (String(url).endsWith('/getupdates')) {
      seenCursors.push(JSON.parse(init.body).get_updates_buf);
      if (++requests <= 3) return new Response(wire);
      await sleep(60_000, undefined, { signal: init.signal }); throw new Error('unreachable');
    }
    throw new Error('unexpected endpoint');
  }, { sleep: async () => {
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_inbox').get().n, 0);
    assert.equal(store.db.prepare('SELECT cursor FROM gateway_accounts').get().cursor, null);
    store.db.exec('DROP TRIGGER fail_ilink_commit'); recovered = true;
  } }));
  const { id } = await gateway.save('owner', { channel: 'ilink', agentId: 'agent', enabled: false, config });
  const pair = gateway.pair('owner', id);
  wire = `{"msgs":[${wireMessage('9223372036854775806', pair.command)},${wireMessage('9223372036854775807')}],"get_updates_buf":"committed"}`;
  store.db.exec("CREATE TRIGGER fail_ilink_commit BEFORE INSERT ON gateway_inbox WHEN NEW.external_id LIKE '%9223372036854775807%' BEGIN SELECT RAISE(ABORT,'synthetic failure SECRET'); END");
  await gateway.save('owner', { id, channel: 'ilink', agentId: 'agent', enabled: true });
  await until(() => requests === 4);
  assert.equal(recovered, true);
  assert.deepEqual(seenCursors, ['', '', 'committed', 'committed']);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_inbox').get().n, 2);
  assert.deepEqual(store.db.prepare('SELECT envelope FROM gateway_inbox ORDER BY id').all().map(r => JSON.parse(secrets.open(r.envelope)).messageId), ['9223372036854775806', '9223372036854775807']);
  await gateway.tick();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_bindings WHERE revoked=0').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 1);
  assert.ok(sent > 0, 'pair acknowledgment uses the real outbox and adapter');
  await gateway.close(); requests = 2; gateway.start(false);
  await until(() => requests === 4);
  await gateway.tick();
  assert.equal(seenCursors.at(-2), 'committed');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_inbox').get().n, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 1);
});

test('core fences late callbacks, exposes only whitelisted diagnostic fields, isolates bot identity', async t => {
  const contexts = [];
  let nextBot = 'different-bot';
  const { store, gateway } = fixture(t, () => ({
    manifest: new IlinkPlugin(noFile).manifest, validate() {}, async stop() {},
    async start(_c, ctx) { contexts.push(ctx); },
    async login() { return { status: 'confirmed', botToken: 'new-SECRET-token', botId: nextBot }; },
    async send() { return 'unused'; },
  }));
  const account = { channel: 'ilink', agentId: 'agent', enabled: true, config };
  const { id } = await gateway.save('owner', account); await until(() => contexts.length === 1);
  contexts[0].health('reconnecting', { error: { code: 'platform_rejected', httpStatus: 200, platformCode: -9, errmsg: 'SECRET' }, consecutiveFailures: 3, retryAt: Date.now() + 5000, token: 'SECRET' });
  let view = gateway.list('owner')[0];
  assert.deepEqual(view.connection.error, { code: 'platform_rejected', httpStatus: 200, platformCode: -9 });
  assert.equal(JSON.stringify(view.connection).includes('SECRET'), false);
  assert.deepEqual(gateway.list('other-owner'), []);
  store.db.prepare('UPDATE gateway_accounts SET cursor=? WHERE id=?').run('keep-cursor', id);
  await assert.rejects(gateway.login('owner', id, { action: 'poll', qrcode: 'qr' }), /channel_identity_changed/);
  await assert.rejects(gateway.save('owner', { ...account, id, config: { ...config, botId: 'different' } }), /channel_identity_changed/);
  nextBot = config.botId;
  await gateway.login('owner', id, { action: 'poll', qrcode: 'qr' }); await until(() => contexts.length === 2);
  assert.equal(store.db.prepare('SELECT cursor FROM gateway_accounts WHERE id=?').get(id).cursor, 'keep-cursor');
  assert.throws(() => contexts[0].receive([normalizeIlink(parseIlinkJson(wireMessage('1')))], 'stale-cursor'));
  contexts[0].health('reconnecting', { error: { code: 'dns_error' } });
  assert.equal(store.db.prepare('SELECT cursor FROM gateway_accounts WHERE id=?').get(id).cursor, 'keep-cursor');
  contexts[1].health('connected'); view = gateway.list('owner')[0];
  assert.equal(view.connection.error, undefined); assert.ok(view.connection.lastSuccessAt);
});

test('disconnecting the login HTTP client cancels upstream QR polling without disabling the account', async t => {
  let started, cancelled = false;
  const polling = new Promise(resolve => { started = resolve; });
  const { gateway } = fixture(t, () => ({
    manifest: new IlinkPlugin(noFile).manifest, validate() {}, async start() {}, async stop() {}, async send() { return ''; },
    async login(_c, _a, signal) {
      started();
      try { await sleep(60_000, undefined, { signal }); }
      finally { cancelled = signal.aborted; }
      return { status: 'wait' };
    },
  }));
  const { id } = await gateway.save('owner', { channel: 'ilink', agentId: 'agent', enabled: true, config });
  const app = Fastify();
  registerGatewayRoutes(app, gateway, () => ({ id: 'owner' }), () => true);
  await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/gateway/accounts/${id}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"poll","qrcode":"synthetic"}', signal: controller.signal,
    });
    const rejected = assert.rejects(response, e => e.name === 'AbortError');
    await polling; controller.abort(); await rejected;
    await until(() => cancelled);
    assert.equal(gateway.account('owner', id).enabled, 1);
  } finally { await app.close(); }
});
