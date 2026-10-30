import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { agentHttpInit } from '../apps/api/src/agent/http.ts';
import { modelRequestPolicy } from '../apps/api/src/agent/model-policy.ts';
import { ModelClient } from '../apps/api/src/agent/model-client.ts';
import { ToolRegistry } from '../apps/api/src/agent/tools/registry.ts';
import { executeSandbox, shellTimeoutSeconds, shellToolTimeoutMs } from '../apps/api/src/agent/sandbox.ts';
import { sandboxArgs, commandTimeoutSeconds } from '../infra/sandbox/arguments.mjs';

const attribution = { owner: 'test', purpose: 'bot', provider: 'test', model: 'test' };
function client(fetcher) {
  const attempts = [], settled = [];
  const ledger = { reserve(_a, attempt) { attempts.push(attempt); return attempt; }, settle(id, status) { settled.push({ id, status }); return false; }, checkAdmission() {} };
  return { model: new ModelClient(ledger, fetcher), attempts, settled };
}
const request = (c, options, signal) => c.model.request('https://model.invalid', { signal }, attribution, 10, options);
// AbortSignal deadlines are unref'ed; keep the process alive for hanging-fetch tests.
async function withClock(operation) {
  const timer = setInterval(() => {}, 1000);
  try { await operation(); } finally { clearInterval(timer); }
}

test('model configuration links attempt timeout, retry count and total deadline', () => {
  assert.deepEqual(modelRequestPolicy({}, {}), { timeoutMs: 120000, attempts: 3, chainMs: 420000 });
  assert.deepEqual(modelRequestPolicy({}, { MODEL_TIMEOUT_MS: '600000', MODEL_MAX_RETRIES: '0' }), { timeoutMs: 600000, attempts: 1, chainMs: 660000 });
  assert.equal(modelRequestPolicy({}, { MODEL_TIMEOUT_MS: '300000' }).chainMs, 960000);
  assert.equal(modelRequestPolicy({}, { MODEL_CHAIN_TIMEOUT_MS: '10000' }).chainMs, 10000);
  assert.deepEqual(modelRequestPolicy({}, { MODEL_TIMEOUT_MS: 'Infinity', MODEL_MAX_RETRIES: '-1', MODEL_CHAIN_TIMEOUT_MS: '' }), modelRequestPolicy({}, {}));
  assert.throws(() => modelRequestPolicy({ attempts: 0 }, {}), /invalid_model_request_policy/);
});

test('retry transient HTTP failures, but not authentication or billing failures', async () => {
  for (const status of [408, 409, 429, 500, 503]) {
    let count = 0;
    const c = client(async () => ++count < 3 ? Response.json({}, { status, headers: { 'retry-after': '0' } }) : Response.json({ ok: true }));
    assert.deepEqual(await request(c, { attempts: 3 }), { ok: true });
    assert.deepEqual(c.attempts, [1, 2, 3]);
  }
  for (const status of [400, 401, 402, 403]) {
    const c = client(async () => Response.json({}, { status }));
    await assert.rejects(request(c, { attempts: 3 }));
    assert.deepEqual(c.attempts, [1]);
  }
  const quota = client(async () => Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }));
  await assert.rejects(request(quota), /model_quota_exhausted/);
  assert.deepEqual(quota.attempts, [1]);
  const exhausted = client(async () => Response.json({}, { status: 503, headers: { 'retry-after': '0' } }));
  await assert.rejects(request(exhausted, { attempts: 3 }), /model_request_failed/);
  assert.deepEqual(exhausted.attempts, [1, 2, 3]);
});

test('timeout covers the full response, retries twice, and settles every attempt', async () => withClock(async () => {
  const c = client(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })));
  await assert.rejects(request(c, { attempts: 3, timeoutMs: 15, chainMs: 5000 }), /model_request_failed/);
  assert.deepEqual(c.attempts, [1, 2, 3]);
  assert.equal(c.settled.length, 3);
  const noRetries = client(() => new Promise(() => {}));
  await assert.rejects(request(noRetries, { attempts: 1, timeoutMs: 15 }), /model_request_failed/);
  assert.deepEqual(noRetries.attempts, [1]);
}));

test('chain deadline cancels in-flight requests and Retry-After waits', async () => withClock(async () => {
  const hanging = client(() => new Promise(() => {}));
  await assert.rejects(request(hanging, { attempts: 3, timeoutMs: 5000, chainMs: 25 }), { name: 'TimeoutError' });
  assert.deepEqual(hanging.attempts, [1]);
  const waiting = client(async () => Response.json({}, { status: 429, headers: { 'retry-after': '60' } }));
  await assert.rejects(request(waiting, { attempts: 3, chainMs: 25 }), { name: 'TimeoutError' });
  assert.deepEqual(waiting.attempts, [1]);
  const abort = new AbortController();
  const cancelled = client(() => { abort.abort(); return new Promise(() => {}); });
  await assert.rejects(request(cancelled, { attempts: 3 }, abort.signal), { name: 'AbortError' });
  assert.deepEqual(cancelled.attempts, [1]);
}));

test('shell deadlines are validated independently at the API and broker', () => {
  const scope = { threadId: '11111111-1111-1111-1111-111111111111', executionId: '22222222-2222-2222-2222-222222222222', command: 'echo test' };
  for (const timeoutSeconds of [undefined, 1, 120, 600]) {
    assert.equal(shellTimeoutSeconds(timeoutSeconds), commandTimeoutSeconds(timeoutSeconds));
    const args = sandboxArgs({ ...scope, timeoutSeconds });
    assert.equal(args[args.indexOf('--signal=KILL') + 1], String(timeoutSeconds ?? 120));
    assert.ok(shellToolTimeoutMs({ timeoutSeconds }) > (timeoutSeconds ?? 120) * 1000 + 30000);
  }
  for (const value of [null, 0, -1, 601, 1.5, '600', Infinity]) {
    assert.throws(() => shellTimeoutSeconds(value), /invalid_shell_timeout/);
    assert.throws(() => sandboxArgs({ ...scope, timeoutSeconds: value }), /invalid_shell_timeout/);
  }
});

test('all owner system files are read-only unless the command requests a writable mount', () => {
  const owner = '33333333-3333-3333-3333-333333333333';
  const args = sandboxArgs({ owner, threadId: '11111111-1111-1111-1111-111111111111', executionId: '22222222-2222-2222-2222-222222222222', command: 'pwd' }, undefined, '/host/data/files/system-files');
  const mounts = args.flatMap((value, index) => value === '--mount' ? [args[index + 1]] : []);
  assert.ok(mounts.some(mount => mount.includes('/host/data/files/system-files/') && mount.endsWith('/system,target=/system,readonly')));
  assert.ok(!mounts.some(mount => mount.includes('target=/system/skills')));
  const writable = sandboxArgs({ owner, threadId: '11111111-1111-1111-1111-111111111111', executionId: '22222222-2222-2222-2222-222222222222', command: 'pwd', systemWrite: true }, undefined, '/host/data/files/system-files');
  assert.ok(writable.some(mount => mount.endsWith('/system,target=/system')));
  for (const systemWrite of [null, 1, 'true']) assert.throws(() => sandboxArgs({ owner, threadId: '11111111-1111-1111-1111-111111111111', executionId: '22222222-2222-2222-2222-222222222222', command: 'pwd', systemWrite }, undefined, '/host/data/files/system-files'), /invalid_system_write/);
  assert.throws(() => sandboxArgs({ owner, threadId: '11111111-1111-1111-1111-111111111111', executionId: '22222222-2222-2222-2222-222222222222', command: 'pwd', systemWrite: true }), /system_mount_not_configured/);
  assert.throws(() => sandboxArgs({ owner, threadId: '11111111-1111-1111-1111-111111111111', executionId: '22222222-2222-2222-2222-222222222222', filePath: 'result.zip', systemWrite: true }, undefined, '/host/data/files/system-files'), /invalid_system_write/);
  assert.throws(() => sandboxArgs({ owner: 'not-an-owner', threadId: '11111111-1111-1111-1111-111111111111', executionId: '22222222-2222-2222-2222-222222222222', command: 'pwd' }, undefined, '/host/data/files/system-files'), /system_mount_not_configured/);
});

test('shell HTTP timeout follows the requested command deadline and cancellation', async () => {
  const originalFetch = globalThis.fetch, originalTimeout = AbortSignal.timeout;
  const oldUrl = process.env.SANDBOX_URL, oldToken = process.env.SANDBOX_TOKEN;
  const deadlines = [];
  try {
    process.env.SANDBOX_URL = 'http://sandbox.invalid'; process.env.SANDBOX_TOKEN = 'test';
    AbortSignal.timeout = ms => { deadlines.push(ms); return new AbortController().signal; };
    const controller = new AbortController(); let fetchSignal;
    globalThis.fetch = async (_url, init) => {
      fetchSignal = init.signal;
      assert.equal(JSON.parse(init.body).timeoutSeconds, 600);
      return Response.json({ stdout: 'done', stderr: '', exitCode: 0 });
    };
    await executeSandbox({ command: 'echo done', timeoutSeconds: 600 }, controller.signal);
    assert.deepEqual(deadlines, [630000]);
    controller.abort(); assert.ok(fetchSignal.aborted);
  } finally {
    globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout;
    if (oldUrl === undefined) delete process.env.SANDBOX_URL; else process.env.SANDBOX_URL = oldUrl;
    if (oldToken === undefined) delete process.env.SANDBOX_TOKEN; else process.env.SANDBOX_TOKEN = oldToken;
  }
});

test('tool deadlines resolve from validated arguments and still interrupt work', async () => withClock(async () => {
  const registry = new ToolRegistry();
  registry.register({ type: 'function', function: { name: 'timed', parameters: { type: 'object', properties: { ms: { type: 'integer', minimum: 1 } }, required: ['ms'], additionalProperties: false } } }, 'uncertain', args => args.ms);
  const context = { signal: new AbortController().signal, checkActive() {} };
  let executed = false;
  const invalid = await registry.execute('timed', { ms: -1 }, context, async () => { executed = true; });
  assert.equal(invalid.error.code, 'invalid_arguments'); assert.equal(executed, false);
  let signal;
  const result = await registry.execute('timed', { ms: 15 }, context, scoped => { signal = scoped.signal; return new Promise(() => {}); });
  assert.equal(result.error.code, 'tool_timeout'); assert.ok(signal.aborted);
}));

test('long requests use a scoped dispatcher instead of the global transport deadline', async () => {
  const previous = getGlobalDispatcher();
  const short = new Agent({ headersTimeout: 10, bodyTimeout: 10 })
    .compose(dispatch => (options, handler) => dispatch({ ...options, headersTimeout: 10, bodyTimeout: 10 }, handler));
  // Undici 7 uses a coarse parser timer even for tiny header deadlines.
  const server = http.createServer((_req, res) => setTimeout(() => { res.end('{"ok":true}'); }, 1500));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    setGlobalDispatcher(short);
    await assert.rejects(fetch(url));
    const result = await fetch(url, agentHttpInit({ signal: AbortSignal.timeout(5000) }));
    assert.deepEqual(await result.json(), { ok: true });
    const c = client(fetch);
    assert.deepEqual(await c.model.request(url, {}, attribution, 10, { attempts: 1, timeoutMs: 5000 }), { ok: true });
  } finally {
    setGlobalDispatcher(previous);
    await short.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
