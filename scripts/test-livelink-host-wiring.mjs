#!/usr/bin/env node
/**
 * host 侧接线的断言（src/livelink/host.ts）：握手 / 版本 / op 定向回执 / 问答流。
 *
 * ## 为什么要起一个真桩中继（而不是把帧直接塞进 core）
 *
 * P2 的接线最容易坏的地方全部在「**这一帧到底发给谁**」上：ack 是不是回到了发起它的
 * 那台设备、问答流有没有串到别的屏幕、版本对不上时是不是真的关了连接。这些在浏览器里
 * 看不出来（两台设备同时连着本来就难复现），而在只喂数组的假 socket 上测，等于把
 * 「帧怎么编码」「socket 什么时候不能发」这两件事一起从被测面里拿掉了。
 *
 * 所以这里跑的是**真链路**：Node 的 `ws` 起一个进程内桩中继（照 e2e-livelink.mjs 那份，
 * 按 room 配对 / 异角色原样转发 / host 断开向 guest 广播 host-link-down），`LiveHost`
 * 用 `ws` 的客户端当真 WebSocket 连进去，来宾也是真的 socket。协议帧与真中继上逐字节
 * 一致（唯一的差异是真 DO 还管房间回收与限速，那些不改变两端交换的帧）。
 *
 * ## 为什么还要 esbuild 打包一次
 *
 * `host.ts` 走的是应用里的无扩展名 import（`'../store/db'`），Node 的类型剥离子句只认带
 * 扩展名的 specifier —— 直接 import 会在解析期就炸。打成单入口 bundle 还有第二个好处：
 * host / db / settings / qaRunner 落在**同一份**实例里（多个入口各打一份 settings 就是
 * 「改 store 改的是另一份」，那种假绿 test-qa-runner.mjs 踩过）。Dexie 跑 fake-indexeddb、
 * 模型走假网关，零网络零 key。
 *
 * ## 守的是哪几条静默失败
 *
 * 1. v1 的 hello 被**静默丢弃**：host 那边毫无反应，来宾永远停在「连接中」（不变量 6）。
 * 2. 版本不匹配时多发一帧 version.err：老来宾的 decodeFrame 严格解 v，那一帧到它手里
 *    就是坏帧 —— 给空气发消息，还让人以为「已经明说了」。
 * 3. **ack 广播出去 / 发给别的来宾**（本任务的核心断言）：两台设备同时连着时，A 的操作
 *    确认到了 B，B 的 outbox 删掉一条它从没发过的 op，而 A 那条永远重发到配额用尽。
 * 4. `from` 不查席：任何一台设备都能凭空造出写 op。
 * 5. 问答串台：A 的提问流渲染到 B 的屏幕上（不变量 7）。
 * 6. 问答并发：qaRunner 取历史靠 `sortBy(createdAt)` + `slice(0,-1)`，并发跑同一会话的
 *    两轮会读到彼此的历史（Task 4 的最高风险）。这里用假网关数「同时在飞的请求数」。
 * 7. `chat.stop` 停不掉那一轮：用户按了停止，而 host 照样把它跑完并写进主机历史。
 * 8. `study.add` 重放双倍累加（不变量 3，去重表是准入条件）。
 *
 * 运行：node scripts/test-livelink-host-wiring.mjs
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
// ws 的默认导出就是 WebSocket 类本身，WebSocketServer 是具名导出
import NodeWs, { WebSocketServer } from 'ws';

const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
// zustand/persist 在导入期就要看到 localStorage（Node 里没有），给个最小桩
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

/**
 * host 侧 close 的记录。`LiveHost` 用全局 `WebSocket`，所以把 ws 的客户端类派一个子类
 * 挂上去就能记到 host 自己 socket 上的 close code —— 4400 那个码只有这里看得到：
 * **真中继不透传 host 的 close code**（protocol.ts 的 CLOSE_PROTOCOL_MISMATCH 已注明），
 * 所以来宾那一侧只能看到 host-link-down。
 */
const hostCloses = [];
class TrackedWebSocket extends NodeWs {
  close(code, reason) {
    if (code !== undefined) hostCloses.push({ code, reason });
    return super.close(code, reason);
  }
}
globalThis.WebSocket = TrackedWebSocket;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.error(`  FAIL - ${name}\n        ${e.message}`);
  }
}

// ── 打包 + 导入（理由见文件头） ──────────────────────────────────────────────
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = mkdtempSync(join(tmpdir(), 'live-host-wiring-'));
const entry = join(OUT, 'entry.ts');
writeFileSync(
  entry,
  `export { LiveHost, HostCore, ackFrameFor, chatEvFor, chatDoneFor } from '${join(ROOT, 'src/livelink/host.ts')}';
   export * from '${join(ROOT, 'src/livelink/protocol.ts')}';
   export { db } from '${join(ROOT, 'src/store/db.ts')}';
   export { useSettings } from '${join(ROOT, 'src/store/settings.ts')}';
  `,
);
await build({
  entryPoints: [entry],
  outfile: join(OUT, 'bundle.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  loader: { '.md': 'text' },
  define: { 'process.env.NODE_ENV': '"test"' },
});
const { LiveHost, PROTOCOL_VERSION, FRAME, CLOSE_PROTOCOL_MISMATCH, helloFrame, db, useSettings } = await import(
  pathToFileURL(join(OUT, 'bundle.mjs')).href
);

// ── 假网关 ──────────────────────────────────────────────────────────────────

/** 一个 assistant SSE 轮次：正文 / 思考 / 工具调用 / finish_reason（照 test-qa-runner.mjs） */
function sse({ content = '', reasoning = '', toolCalls = [], finish = 'stop' }) {
  const chunks = [];
  const base = { id: 'c', object: 'chat.completion.chunk', model: 'test', choices: [{ index: 0, delta: {} }] };
  if (reasoning) chunks.push({ ...base, choices: [{ index: 0, delta: { reasoning_content: reasoning } }] });
  if (content) chunks.push({ ...base, choices: [{ index: 0, delta: { content } }] });
  toolCalls.forEach((tc, index) => {
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] },
        },
      ],
    });
  });
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

/**
 * 装上假网关。`serve(script)` 按调用次序取用，用尽后重复最后一个。
 *
 * `concurrency` 是「**同时在飞的请求数**」的峰值记录：问答必须全局串行（host 一次只跑
 * 一轮），这条断言就靠它 —— 并发跑同一会话的两轮会各自把对方的提问当历史末条
 * （qaRunner 的 `sortBy(createdAt)` + `slice(0,-1)`）。
 */
let inflight = 0;
let peakInflight = 0;
let holdMs = 0;
function serve(script) {
  const seen = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/chat\/completions$/, '本测试只关心对话请求');
    seen.push(JSON.parse(init.body));
    inflight++;
    peakInflight = Math.max(peakInflight, inflight);
    try {
      if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
      const chunk = script[Math.min(i, script.length - 1)];
      i++;
      return new Response(sse(chunk), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    } finally {
      inflight--;
    }
  };
  return seen;
}

/** 挂着一个永不结束的流（用来验 chat.stop）：发过一段内容后一直挂着，直到被中止。 */
function serveHanging(content) {
  const enc = new TextEncoder();
  globalThis.fetch = async (_url, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(sse({ content })));
          const fail = () => controller.error(new DOMException('The user aborted a request.', 'AbortError'));
          if (init?.signal?.aborted) fail();
          else init?.signal?.addEventListener('abort', fail);
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
}

// ── 桩中继（照 e2e-livelink.mjs 的那份，协议级同款） ──────────────────────────
const rooms = new Map();
const wss = new WebSocketServer({ port: 0 });
await once(wss, 'listening');
const RELAY = `ws://127.0.0.1:${wss.address().port}`;
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const room = url.searchParams.get('room')?.trim();
  const role = url.searchParams.get('role');
  if (!room || (role !== 'host' && role !== 'guest')) {
    ws.close(4000, 'bad params');
    return;
  }
  if (!rooms.has(room)) rooms.set(room, { host: null, guests: new Set() });
  const r = rooms.get(room);
  if (role === 'host') r.host = ws;
  else r.guests.add(ws);
  ws.on('message', (data, isBinary) => {
    // 异角色转发，同角色互不可见（真 DO 的 webSocketMessage 同款；中继不解析载荷）
    const targets = role === 'host' ? [...r.guests] : r.host ? [r.host] : [];
    for (const t of targets) if (t.readyState === NodeWs.OPEN) t.send(data, { binary: isBinary });
  });
  ws.on('close', () => {
    if (role === 'host') {
      r.host = null;
      // host 断开 → 向全体 guest 广播 host-link-down（真 DO 的 webSocketClose）
      for (const g of r.guests) {
        if (g.readyState === NodeWs.OPEN) g.send(JSON.stringify({ ctl: 1, t: FRAME.hostLinkDown, id: 'relay' }));
      }
    } else {
      r.guests.delete(ws);
    }
  });
});

// ── 工具 ────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等某帧到达；超时把已收到的帧型列出来（症状就是「什么都没来」，得能一眼看出卡在哪） */
async function waitForFrame(frames, pred, label, timeout = 8000) {
  const hit = frames.find(pred);
  if (hit) return hit;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await sleep(20);
    const found = frames.find(pred);
    if (found) return found;
  }
  throw new Error(`超时等不到：${label}；已收到 [${frames.map((f) => f.t).join(', ')}]`);
}

/** 断言一段时间内没有新帧（「不该有回执」这类否定断言用它） */
async function assertQuiet(frames, label, ms = 400) {
  const before = frames.length;
  await sleep(ms);
  assert.equal(frames.length, before, `${label}：不该有新帧，却多了 [${frames.slice(before).map((f) => f.t).join(', ')}]`);
}

/** 连一台来宾（真 socket），把收到的文本帧记在 `frames` 上 */
const openSockets = [];
async function connectGuest(room) {
  const ws = new NodeWs(`${RELAY}?room=${encodeURIComponent(room)}&role=guest`);
  openSockets.push(ws);
  ws.binaryType = 'arraybuffer';
  const frames = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    frames.push(JSON.parse(data.toString()));
  });
  await once(ws, 'open');
  return {
    ws,
    frames,
    send: (obj) => ws.send(JSON.stringify(obj)),
    close: () => ws.close(),
  };
}

/** 起一台 host（真 LiveHost + 真 socket），返回可 await 的停机函数 */
function startHost(room, extra = {}) {
  const guests = [];
  const ops = [];
  const turns = [];
  const host = new LiveHost({
    relayUrl: RELAY,
    code: room,
    events: {
      onGuests: (g) => guests.push(g.map((x) => x.id)),
      onStatus: () => {},
      onError: (m) => console.error('   [host onError]', m),
      onTurn: (info) => turns.push(info),
      onOps: (n) => ops.push(n),
    },
    ...extra,
  });
  host.start();
  return { host, guests, ops, turns, stop: () => host.stop() };
}

let roomSeq = 0;
async function link() {
  const room = `room-${++roomSeq}`;
  const h = startHost(room);
  await sleep(60); // 等 host 连上中继（否则 guest 的 hello 先到会被丢）
  return { room, ...h };
}

// ── 种子数据 + 供应商 ────────────────────────────────────────────────────────
useSettings.getState().update({
  providers: [
    {
      id: 'sf',
      name: '硅基流动',
      baseUrl: 'https://fake.test/v1',
      apiKey: 'test-key',
      serves: ['chat', 'vision', 'asr'],
      catalogId: 'siliconflow-cn',
    },
  ],
  llmModel: { providerId: 'sf', model: 'test-model' },
  visionModel: { providerId: 'sf', model: 'test-model' },
  agentRounds: 6,
});
await db.delete();
await db.open();
await db.videos.add({
  id: 'v1',
  name: '贝叶斯入门',
  size: 1,
  mimeType: 'video/mp4',
  duration: 100,
  createdAt: 1,
  status: 'transcribed',
});
await db.segments.add({ videoId: 'v1', idx: 0, start: 0, end: 30, text: '今天讲贝叶斯定理。', status: 1 });

const opFrame = (from, opId, op, args) => ({
  v: PROTOCOL_VERSION,
  t: FRAME.op,
  id: opId,
  opId,
  from,
  op,
  args,
});

// ────────── 1. v2 hello → welcome（含 hostVersion）+ 进席 ──────────

await test('v2 hello：回 welcome（带 hostVersion）且来宾进在席表', async () => {
  const { room, guests, stop } = await link();
  try {
    const a = await connectGuest(room);
    a.send(helloFrame('guest-a'));
    const welcome = await waitForFrame(a.frames, (f) => f.t === FRAME.welcome, 'welcome');
    assert.equal(welcome.id, 'guest-a');
    assert.equal(welcome.hostVersion, PROTOCOL_VERSION, 'welcome 必须带 hostVersion（来宾唯一的版本判据）');
    assert.equal(welcome.v, PROTOCOL_VERSION);
    assert.ok(guests.at(-1).includes('guest-a'), 'hello 之后来宾要进在席表（共享条上的计数）');

    // bye 把它带走（count 减回去）—— P1 的既有契约，接线时不能改丢
    a.send({ v: PROTOCOL_VERSION, t: FRAME.bye, id: 'guest-a' });
    const t0 = Date.now();
    while (guests.at(-1)?.length > 0 && Date.now() - t0 < 3000) await sleep(20);
    assert.equal(guests.at(-1).length, 0, 'bye 之后在席表要空（否则设备数只增不减）');
  } finally {
    stop();
    await sleep(30);
  }
});

// ────────── 2. v1 hello → close(4400)，且不发 version.err ──────────

await test('v1 hello：host 关连接（4400）且不发 version.err（老来宾读不到那一帧）', async () => {
  const { room, guests, stop } = await link();
  try {
    const old = await connectGuest(room);
    old.send({ v: 1, t: FRAME.hello, id: 'old-1', clientVersion: 1 });
    const t0 = Date.now();
    while (!hostCloses.length && Date.now() - t0 < 5000) await sleep(20);
    assert.ok(hostCloses.length > 0, '版本不匹配必须显式失败（不变量 6），不能静默丢弃');
    assert.equal(hostCloses.at(-1).code, CLOSE_PROTOCOL_MISMATCH, `close code 必须是 ${CLOSE_PROTOCOL_MISMATCH}`);
    assert.equal(
      old.frames.filter((f) => f.t === FRAME.versionErr).length,
      0,
      '不发 version.err：老来宾的 decodeFrame 严格解 v，那一帧到它手里只是坏帧（protocol.ts 已注明）',
    );
    assert.ok(
      !guests.at(-1)?.includes('old-1'),
      '版本不匹配的那台不能进在席表（否则共享条上的设备数会虚高）',
    );
  } finally {
    stop();
    await sleep(30);
  }
});

// ────────── 3. op → apply → ack 回同一个 to（两台来宾同时连着） ──────────

await test('op：ack 定向回给发起它的来宾（两台同时连着，A 的 ack 不能到 B）', async () => {
  const { room, stop } = await link();
  try {
    const a = await connectGuest(room);
    const b = await connectGuest(room);
    a.send(helloFrame('guest-a'));
    b.send(helloFrame('guest-b'));
    await waitForFrame(a.frames, (f) => f.t === FRAME.welcome, 'a 的 welcome');
    await waitForFrame(b.frames, (f) => f.t === FRAME.welcome, 'b 的 welcome');

    a.send(opFrame('guest-a', 'o-1', 'position.set', { videoId: 'v1', position: 42.5, finished: false }));
    const ack = await waitForFrame(a.frames, (f) => f.t === FRAME.ack, 'a 的 ack');
    assert.equal(ack.opId, 'o-1');
    assert.equal(ack.to, 'guest-a', 'ack 必须带 to = 发起者的 hello id');
    assert.equal(ack.ok, 1);
    assert.equal((await db.videos.get('v1')).lastPosition, 42.5, 'ack 说 ok 就必须真落库');
    await assertQuiet(b.frames, 'B 不该收到任何帧');
  } finally {
    stop();
    await sleep(30);
  }
});

// ────────── 4. 未知 from 的 op 被拒 ──────────

await test('op：from 不在席 → 不 apply 也不 ack（来宾自报身份，声明不算证据）', async () => {
  const { room, stop } = await link();
  try {
    const a = await connectGuest(room);
    a.send(helloFrame('guest-a'));
    await waitForFrame(a.frames, (f) => f.t === FRAME.welcome, 'welcome');

    const before = (await db.videos.get('v1')).lastPosition;
    a.send(opFrame('ghost-never-hello', 'o-ghost', 'position.set', { videoId: 'v1', position: 999 }));
    // 同一台来宾顺手也发一条正常的：用来确认链路还活着（否则「没反应」可能只是它死了）
    a.send(opFrame('guest-a', 'o-ok', 'study.add', { date: '2026-03-01', seconds: 30 }));
    const ack = await waitForFrame(a.frames, (f) => f.t === FRAME.ack && f.opId === 'o-ok', '正常 op 的 ack');
    assert.equal(ack.ok, 1);
    assert.equal(
      a.frames.filter((f) => f.t === FRAME.ack && f.opId === 'o-ghost').length,
      0,
      '来路不明的 op 不能有回执（回执是路由，身份没核过就不能往任何地方发）',
    );
    assert.equal((await db.videos.get('v1')).lastPosition, before, '被拒的 op 不许落到库里');
    assert.equal((await db.studyDays.get('2026-03-01')).seconds, 30);
  } finally {
    stop();
    await sleep(30);
  }
});

// ────────── 5. chat.req → chat.ev(delta) → chat.done ──────────

await test('chat.req：chat.ev 流事件 → chat.done，且只回给提问那台', async () => {
  const seen = serve([{ reasoning: '先想想', content: '贝叶斯定理说的是用证据更新先验概率。' }]);
  const { room, stop, turns } = await link();
  try {
    const a = await connectGuest(room);
    const b = await connectGuest(room);
    a.send(helloFrame('guest-a'));
    b.send(helloFrame('guest-b'));
    await waitForFrame(a.frames, (f) => f.t === FRAME.welcome, 'a 的 welcome');
    await waitForFrame(b.frames, (f) => f.t === FRAME.welcome, 'b 的 welcome');
    b.frames.length = 0;

    a.send({
      v: PROTOCOL_VERSION,
      t: FRAME.chatReq,
      id: 'turn-1',
      to: '*',
      from: 'guest-a',
      turnId: 'turn-1',
      videoId: 'v1',
      text: '贝叶斯定理是什么？',
    });

    const ev = await waitForFrame(a.frames, (f) => f.t === FRAME.chatEv && f.kind === 'delta', 'delta 事件');
    assert.equal(ev.to, 'guest-a', '流事件的 to 必须是提问那台');
    assert.equal(ev.turnId, 'turn-1');
    assert.equal(a.frames.some((f) => f.t === FRAME.chatEv && f.kind === 'reasoning'), true, '思考链也要流出来');
    assert.equal(a.frames.some((f) => f.t === FRAME.chatEv && f.kind === 'round'), true, '轮次开始要有事件');

    const done = await waitForFrame(a.frames, (f) => f.t === FRAME.chatDone, 'chat.done');
    assert.equal(done.to, 'guest-a');
    assert.equal(done.content, '贝叶斯定理说的是用证据更新先验概率。');
    assert.equal(done.reasoning, '先想想', '思考链随 done 回（来宾据此渲染折叠区）');
    assert.equal(typeof done.reasoningMs, 'number', '思考耗时要有');

    // 落库只在主机：一问一答两行（来宾自己一个字都不写）
    const sessionId = (await db.chatSessions.where('videoId').equals('v1').toArray()).at(-1).id;
    const rows = await db.chats.where('sessionId').equals(sessionId).sortBy('createdAt');
    assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant'], '主机库里应恰好两行');
    assert.equal(rows[0].content, '贝叶斯定理是什么？');
    assert.equal(rows[1].content, done.content);

    assert.equal(seen.length, 1, '只该发一次模型请求（问答逻辑不在接线层重复实现）');
    await assertQuiet(b.frames, 'B 不该看到 A 的问答流（不变量 7）');
    assert.ok(turns.some((t) => t.state === 'start') && turns.at(-1).state === 'done', 'onTurn 信号线要报出这一轮');
  } finally {
    stop();
    await sleep(30);
  }
});

// ────────── 6. chat.stop → 那一轮的 abort 生效 ──────────

await test('chat.stop：那一轮被 abort，done 里带「已停止生成」', async () => {
  serveHanging('先说一句：');
  const { room, stop } = await link();
  try {
    const a = await connectGuest(room);
    a.send(helloFrame('guest-a'));
    await waitForFrame(a.frames, (f) => f.t === FRAME.welcome, 'welcome');

    a.send({
      v: PROTOCOL_VERSION,
      t: FRAME.chatReq,
      id: 'turn-stop',
      to: '*',
      from: 'guest-a',
      turnId: 'turn-stop',
      videoId: 'v1',
      text: '讲讲贝叶斯',
    });
    await waitForFrame(a.frames, (f) => f.t === FRAME.chatEv && f.kind === 'delta', '第一段正文');

    // 停止走 op 面（设计 §3.2）：注册表在入队之前就填好了，所以排队的轮次也停得掉
    a.send(opFrame('guest-a', 'o-stop', 'chat.stop', { turnId: 'turn-stop' }));
    const ack = await waitForFrame(a.frames, (f) => f.t === FRAME.ack && f.opId === 'o-stop', '停止的 ack');
    assert.equal(ack.ok, 1, '停一个在跑的轮次要回 ok（失败会让用户以为停止本身出错）');

    const done = await waitForFrame(a.frames, (f) => f.t === FRAME.chatDone, '被停止后的 done');
    assert.match(done.content, /已停止生成/, '被中止的一轮要保留已流出内容并标注「已停止生成」');
    assert.match(done.content, /先说一句：/, '已经流出去的正文不许丢');
    assert.equal(a.frames.some((f) => f.t === FRAME.chatErr), false, '中止不是错误，不能报 chat.err');
  } finally {
    stop();
    await sleep(30);
  }
});

// ────────── 7. 控制帧在 host 侧不产生业务响应 ──────────

await test('中继控制帧：host 认出来但不产生任何业务响应（透传语义）', async () => {
  const { room, stop } = await link();
  try {
    const a = await connectGuest(room);
    a.send(helloFrame('guest-a'));
    await waitForFrame(a.frames, (f) => f.t === FRAME.welcome, 'welcome');
    a.frames.length = 0;

    // 真中继只把 host-link-down/up 发给 guest，不发给 host。这条断言守的是 host 的
    // **解码顺序**（控制帧必须先判，否则会以「版本不符」当坏帧丢掉）与「不误当业务帧」
    const r = rooms.get(room);
    for (const t of [FRAME.hostLinkDown, FRAME.hostLinkUp]) {
      r.host.send(JSON.stringify({ ctl: 1, t, id: 'relay' }));
    }
    await sleep(150);
    await assertQuiet(a.frames, '控制帧不许让 host 产生业务响应', 300);

    // 链路必须还活着：控制帧不该把 host 带进任何异常分支
    a.send(opFrame('guest-a', 'o-after-ctl', 'position.set', { videoId: 'v1', position: 7 }));
    const ack = await waitForFrame(a.frames, (f) => f.t === FRAME.ack && f.opId === 'o-after-ctl', '控制帧之后的 ack');
    assert.equal(ack.ok, 1);
  } finally {
    stop();
    await sleep(30);
  }
});

// ────────── 8. 同一个 opId 连发两次 study.add → 只累加一次 ──────────

await test('幂等：同一个 opId 连发两次 study.add，只累加一次（两条 ack 都要回）', async () => {
  const { room, stop } = await link();
  try {
    const a = await connectGuest(room);
    a.send(helloFrame('guest-a'));
    await waitForFrame(a.frames, (f) => f.t === FRAME.welcome, 'welcome');

    a.send(opFrame('guest-a', 'o-dup', 'study.add', { date: '2026-03-02', seconds: 30 }));
    a.send(opFrame('guest-a', 'o-dup', 'study.add', { date: '2026-03-02', seconds: 30 }));
    await waitForFrame(
      a.frames,
      (f) => f.t === FRAME.ack && f.opId === 'o-dup' && a.frames.filter((x) => x.t === FRAME.ack && x.opId === 'o-dup').length === 2,
      '第二条 ack',
    );
    assert.equal(
      (await db.studyDays.get('2026-03-02')).seconds,
      30,
      'study.add 是累加语义，重放一次就多记一段而界面上完全看不出来（不变量 3）',
    );
    assert.ok(
      a.frames.filter((f) => f.t === FRAME.ack && f.opId === 'o-dup').every((f) => f.ok === 1),
      '重放的那条也要回 ok（幂等回执），否则来宾会一直重试到配额用尽',
    );
  } finally {
    stop();
    await sleep(30);
  }
});

// ────────── 9. 问答全局串行 ──────────

await test('问答全局串行：两轮排队而不是并发（并发会读到彼此的历史）', async () => {
  const seen = serve([{ content: '答一句。' }, { content: '再答一句。' }]);
  holdMs = 300;
  peakInflight = 0;
  const { room, stop } = await link();
  try {
    const a = await connectGuest(room);
    a.send(helloFrame('guest-a'));
    await waitForFrame(a.frames, (f) => f.t === FRAME.welcome, 'welcome');

    for (const turnId of ['t1', 't2']) {
      a.send({
        v: PROTOCOL_VERSION,
        t: FRAME.chatReq,
        id: turnId,
        to: '*',
        from: 'guest-a',
        turnId,
        videoId: 'v1',
        text: `问题 ${turnId}`,
      });
    }
    await waitForFrame(a.frames, (f) => f.t === FRAME.chatDone && f.turnId === 't2', '第二轮的 done');
    assert.equal(peakInflight, 1, 'host 一次只跑一轮（qaRunner 的 slice(0,-1) 假设本轮是库里最后一条）');
    assert.equal(seen.length, 2);

    // 第二轮的历史里必须有第一轮的一问一答（串行才看得到）
    const secondMessages = seen[1].messages;
    assert.ok(
      secondMessages.some((m) => m.role === 'user' && String(m.content).includes('问题 t1')),
      '第二轮要拿到第一轮的历史 —— 并发时它读到的是自己那一问（表现为模型答非所问）',
    );
  } finally {
    holdMs = 0;
    stop();
    await sleep(30);
  }
});

// ────────── 10. 同一个 turnId 跑完之后能再问一次 ──────────

await test('轮次注册表：跑完即注销，同一个 turnId 还能再问一次', async () => {
  serve([{ content: '第一次答。' }]);
  const { room, stop } = await link();
  try {
    const a = await connectGuest(room);
    a.send(helloFrame('guest-a'));
    await waitForFrame(a.frames, (f) => f.t === FRAME.welcome, 'welcome');
    const ask = (turnId) =>
      a.send({ v: PROTOCOL_VERSION, t: FRAME.chatReq, id: turnId, to: '*', from: 'guest-a', turnId, videoId: 'v1', text: '同一个问题' });

    ask('turn-x');
    await waitForFrame(a.frames, (f) => f.t === FRAME.chatDone && f.turnId === 'turn-x', '第一次的 done');
    // 注册表里若还留着 turn-x，上面那道「同 turnId 判重复」就会把它永远挡掉 ——
    // 症状是来宾重发一次提问就再也等不到回答
    ask('turn-x');
    const second = await waitForFrame(
      a.frames,
      (f) => f.t === FRAME.chatDone && f.turnId === 'turn-x' && a.frames.filter((x) => x.t === FRAME.chatDone).length >= 2,
      '第二次的 done',
    );
    assert.ok(second, '同一个 turnId 要能再跑一轮（turns 表出队即注销）');
  } finally {
    stop();
    await sleep(30);
  }
});

// ────────── 11. 不认识的帧型安静跳过 ──────────

await test('未知帧型：安静跳过，链路继续正常应答', async () => {
  const { room, stop } = await link();
  try {
    const a = await connectGuest(room);
    a.send(helloFrame('guest-a'));
    await waitForFrame(a.frames, (f) => f.t === FRAME.welcome, 'welcome');
    a.frames.length = 0;

    // 坏 JSON、版本不符的 hello 之外的帧、未知 t：都不该产生任何业务响应，也别把链路带崩
    const r = rooms.get(room);
    r.host.send('{"v":2,"t":"totally.unknown","id":"x"}');
    r.host.send('{ 这不是 JSON }');
    r.host.send(JSON.stringify({ v: 2, t: FRAME.op, id: 'no-from', opId: 'o-x', op: 'study.add', args: {} }));
    await sleep(150);
    await assertQuiet(a.frames, '未知/坏帧不许产生业务响应', 300);

    a.send(opFrame('guest-a', 'o-alive', 'position.set', { videoId: 'v1', position: 3 }));
    const ack = await waitForFrame(a.frames, (f) => f.t === FRAME.ack && f.opId === 'o-alive', '之后的 ack');
    assert.equal(ack.ok, 1, '链路必须还活着');
    // 缺 from 的 op 同样被拒（from 是必填的路由字段）
    assert.equal((await db.videos.get('v1')).lastPosition, 3, '只有那条合法 op 落了库');
  } finally {
    stop();
    await sleep(30);
  }
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
// 关掉所有还开着的 socket 再退出：留一个活着的连接，事件循环就永远不空，脚本会「跑完却
// 不退出」（e2e-all 按退出码判成败，那种挂法会变成一条永远转圈的用例）。
for (const ws of openSockets) ws.close();
wss.close();
rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} 通过，${failures.length} 失败`);
process.exit(failures.length > 0 ? 1 : 0);