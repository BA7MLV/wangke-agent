#!/usr/bin/env node
/**
 * guest 侧接线（src/livelink/guest.ts）的断言：三条 op 路径 / 逐条补发 / ack 路由 /
 * 问答流组装 / 稳定 guest id / 版本显式失败。
 *
 * ## 为什么大多数断言对着 GuestCore（而不是真 socket）
 *
 * P2 的 guest 接线最容易坏的地方全在「**这一帧带没带 from / 发给谁 / 什么时候发**」上：
 * ack 是不是只认发给我的、补发是不是真的逐条、两台设备的问答流会不会串。这些在浏览器里
 * 看不出来（两台设备同时连着本来就难复现），而在**只喂数组的假 socket**上测，又正好把
 * 「帧怎么编码」「socket 什么时候不能发」一起从被测面拿掉了。所以把帧编排拆成
 * `GuestCore`（不碰 socket，出向动作由 deps 注入），入向从 `dispatch(text)` 进、出向落到
 * 一个数组 —— 于是「第 2 条 op 在第 1 条 ack 之前有没有发出」这种时序断言可以在 Node 里
 * 逐毫秒地验。
 *
 * 拆掉的代价（socket 那一层可能自己搞坏接线）由文件末尾的**集成用例**兜底：真桩中继 +
 * 真 `ws` 客户端，跑的是完整的 `LiveGuest`（同一个类，页面用的就是它），验 hello 的 id、
 * `from` 上线、ack 回来清空 outbox、以及 4400 那一路。
 *
 * ## 守的是哪几条静默失败
 *
 * 1. **op 帧不带 from**：host 查席失败 → 不 apply、不 ack。来宾这边看到的是「进度条再也不动
 *    了」，界面上没有任何异常。
 * 2. **position.set 进了 outbox**（outbox.ts 会抛，但那是第二道防线）：攒队列会让「拖到
 *    40 分钟然后关页面」把最后那条进度丢掉 —— 最常见的用法，不是边缘情形。
 * 3. **一次性把 outbox 全发出去**：「已送达」失去边界，且 host 的写队列是单链串行，
 *    后两条会排在后面慢慢补发而这边已经当成交出去了。
 * 4. **ack 不判 to**：B 的 outbox 删掉一条它从没发过的 op，A 那条永远重发到配额用尽。
 * 5. **internal 之后原地自旋**：那条写不进去的 op 一直堵在 host 的队首，后面本来能送达的
 *    op 一起卡住（症状是「时长就是记不上」，没有任何报错）。
 * 6. **问答串台**：A 的流渲染到 B 的屏幕上（不变量 7）。
 * 7. **guest id 每次连接都换**：用户在来宾端刷新一下，host 侧就多一台设备 —— 共享条上的
 *    计数只增不减（Task 5 明确要求根治的那条）。
 * 8. **版本不匹配显示成「主机已离线」**：主机在线、配对码也对，只是两页版本不同；用户照着
 *    那句话去查主机有没有开共享，一次也修不好（不变量 6 要求显式失败）。
 *
 * 运行：node scripts/test-livelink-guest-wiring.mjs
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

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.error(`  FAIL - ${name}\n        ${e.stack?.split('\n').slice(0, 4).join('\n        ')}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 打包 + 导入（理由见文件头；guest.ts 走应用里的无扩展名 import，Node 的类型剥离子句只认带扩展名的） ──
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = mkdtempSync(join(tmpdir(), 'live-guest-wiring-'));
const entry = join(OUT, 'entry.ts');
writeFileSync(
  entry,
  `export { GuestCore, LiveGuest, opFrameFor, chatReqFor, resolveGuestId, GUEST_ID_STORAGE_KEY, VERSION_MISMATCH_TEXT } from '${join(ROOT, 'src/livelink/guest.ts')}';
   export * from '${join(ROOT, 'src/livelink/protocol.ts')}';
   export { Outbox, OUTBOX_STORAGE_KEY } from '${join(ROOT, 'src/livelink/outbox.ts')}';
   export { ackFrameFor } from '${join(ROOT, 'src/livelink/host.ts')}';
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
const mod = await import(pathToFileURL(join(OUT, 'bundle.mjs')).href);
const {
  GuestCore,
  LiveGuest,
  resolveGuestId,
  GUEST_ID_STORAGE_KEY,
  VERSION_MISMATCH_TEXT,
  PROTOCOL_VERSION,
  FRAME,
  CLOSE_PROTOCOL_MISMATCH,
  Outbox,
  encodeFrame,
  welcomeFrame,
  ackFrameFor,
} = mod;

// ── 假时钟（让「节流 / 退避 / 看门狗」这类时间行为能被逐毫秒断言） ─────────────
class FakeClock {
  constructor() {
    this.t = 0;
    this.nextId = 1;
    this.timeouts = new Map();
    this.intervals = new Map();
    this.now = () => this.t;
    this.timers = {
      setTimeout: (fn, ms) => {
        const id = this.nextId++;
        this.timeouts.set(id, { fn, at: this.t + Math.max(0, ms) });
        return id;
      },
      clearTimeout: (id) => this.timeouts.delete(id),
      setInterval: (fn, ms) => {
        const id = this.nextId++;
        this.intervals.set(id, { fn, every: Math.max(1, ms), at: this.t + Math.max(1, ms) });
        return id;
      },
      clearInterval: (id) => this.intervals.delete(id),
    };
  }

  advance(ms) {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.timeouts.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      const rep = [...this.intervals.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      const at = Math.min(due ? due[1].at : Infinity, rep ? rep[1].at : Infinity);
      if (at > target) break;
      this.t = at;
      if (due && (!rep || due[1].at <= rep[1].at)) {
        const [id, x] = due;
        this.timeouts.delete(id);
        x.fn();
      } else {
        const [id, x] = rep;
        x.at = at + x.every;
        x.fn();
      }
    }
    this.t = target;
  }
}

/** 内存版 outbox 落盘（与 localStorage 同形状：整份 JSON 字符串） */
function memOutbox(backing = new Map()) {
  return {
    read: () => (backing.has('outbox') ? backing.get('outbox') : null),
    write: (s) => backing.set('outbox', s),
  };
}

/** 内存版 guest id 会话存储（与 sessionStorage 同形状） */
function memIdStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    _m: m,
  };
}

// ── 测试台：一台 GuestCore + 一个数组当 socket ──────────────────────────────
const GUEST = 'guest-a';

/** 让 core 进入「主机在席」态（welcome 是唯一的判据，hostUp 之前所有 op 都不发） */
function bringOnline(core) {
  core.dispatch(encodeFrame(welcomeFrame(core.guestId)));
}

function setup(opts = {}) {
  const clock = new FakeClock();
  const sent = [];
  const pending = [];
  const turns = [];
  const errors = [];
  const store = memOutbox(opts.backing);
  const outbox = new Outbox(store, { maxAttempts: opts.maxAttempts });
  const core = new GuestCore({
    send: (f) => sent.push(f),
    events: {
      onPendingOps: (n) => pending.push(n),
      onTurn: (t) => turns.push(t),
      onError: (m) => errors.push(m),
      onHostDown: opts.onHostDown,
      onHostUp: opts.onHostUp,
      onBinaryFrame: opts.onBinaryFrame,
    },
    guestId: opts.guestId ?? GUEST,
    outbox,
    now: clock.now,
    timers: clock.timers,
  });
  if (opts.online !== false) bringOnline(core);
  const ops = () => sent.filter((f) => f.t === FRAME.op);
  const flush = () => {
    sent.length = 0;
  };
  return { core, sent, pending, turns, errors, clock, outbox, store, ops, flush };
}

/** 一条 ack 帧（自己拼而不是用 host 的构造器：这测的是**收**帧那一侧的形状认不认得） */
const ackFrame = (to, opId, ok, reason) => ({
  v: PROTOCOL_VERSION,
  t: FRAME.ack,
  id: opId,
  opId,
  to,
  ok,
  ...(reason ? { reason } : {}),
});
const ackOk = (to, opId) => ackFrame(to, opId, 1);
const chatEv = (to, turnId, kind, extra = {}) => ({
  v: PROTOCOL_VERSION,
  t: FRAME.chatEv,
  id: turnId,
  to,
  turnId,
  kind,
  ...extra,
});

// ────────── 1. op 帧带 from ──────────

await test('op 帧带 from（= 本机 guest id）+ opId = outbox 的 clientOpId', async () => {
  const t = setup();
  t.core.addStudy('2026-03-01', 30);
  const frame = t.ops()[0];
  assert.ok(frame, 'study.add 应当立刻发一帧出去（在线时入队即补发）');
  assert.equal(frame.from, GUEST, 'host 靠 from 查席并在席才 apply；缺 from 整条被拒收且无回执');
  assert.equal(frame.t, FRAME.op);
  assert.equal(frame.op, 'study.add');
  assert.equal(frame.v, PROTOCOL_VERSION);
  assert.equal(frame.opId, t.outbox.list()[0].clientOpId, 'opId 就是 outbox 的 clientOpId（study.add 的去重键）');
  assert.equal(frame.id, frame.opId, '信封 id 与 opId 同值，好对账');
  assert.deepEqual(frame.args, { date: '2026-03-01', seconds: 30 });

  // 三种 op 都带 from（逐条回执，好让下一条真的发得出去 —— 这正是逐条补发的约束）
  t.core.dispatch(encodeFrame(ackOk(GUEST, frame.opId)));
  t.flush();
  t.core.decideCard('v1', 7, 1);
  const decide = t.ops()[0];
  assert.equal(decide.from, GUEST);
  assert.equal(decide.op, 'card.decide');
  t.core.dispatch(encodeFrame(ackOk(GUEST, decide.opId)));
  t.flush();
  t.core.setPosition('v1', 42, false);
  assert.equal(t.ops()[0].from, GUEST, '进度帧同样带 from（host 那侧不查席就拒收）');
});

// ────────── 2. 三条 op 路径 ──────────

await test('三条路径：position.set 不进 outbox；study.add / card.decide 进', async () => {
  const t = setup();
  // 进度：只发不发排队 —— 节流到点前反复调也只留一条内存里的 pending
  t.core.setPosition('v1', 10, false);
  assert.equal(t.ops().length, 1);
  assert.equal(t.outbox.pendingCount(), 0, '进度不能入队：攒队列会丢「拖到一半关页面」那最后一条（outbox.ts 的硬约束）');
  t.core.setPosition('v1', 20, false);
  t.clock.advance(1000);
  t.core.setPosition('v1', 30, false);
  assert.equal(t.ops().length, 1, '节流窗口内的调用只覆盖内存里那一条，不刷帧');
  t.clock.advance(5000);
  t.core.tick();
  const last = t.ops().at(-1);
  assert.equal(last.op, 'position.set');
  assert.deepEqual(last.args, { videoId: 'v1', position: 30, finished: false }, '发出去的是**最后**那一条（最后写入胜出）');
  assert.equal(t.outbox.pendingCount(), 0);

  // 时长 / 审核：入队
  t.core.addStudy('2026-03-02', 60);
  assert.equal(t.outbox.pendingCount(), 1, 'study.add 是累加语义，必须靠 outbox 的至少送达一次');
  t.clock.advance(1);
  t.core.decideCard('v1', 9, 2);
  assert.equal(t.outbox.pendingCount(), 2, 'card.decide 是用户显式动作，不能丢');
  assert.deepEqual(
    t.outbox.list().map((r) => r.op),
    ['study.add', 'card.decide'],
    '队列顺序 = 入队序（补发按这个序）',
  );
});

await test('进度：pagehide / flushPosition 强制补发（不等节流），离线时留着不丢', async () => {
  const t = setup();
  t.core.setPosition('v1', 10, false);
  t.core.setPosition('v1', 77, false); // 节流窗口内
  assert.equal(t.ops().length, 1);
  t.core.flushPosition(true); // 页面卸载 / 暂停时那条
  assert.equal(t.ops().length, 2);
  assert.deepEqual(t.ops().at(-1).args.position, 77);

  // 离线：pending 留在内存里，恢复后仍能补发（不是丢掉）
  t.core.hostLinkDown();
  t.core.setPosition('v1', 99, false);
  assert.equal(t.ops().length, 2, '离线不许发（host 不在席，发出去会被当来路不明拒收）');
  bringOnline(t.core);
  t.clock.advance(5000);
  t.core.tick();
  assert.deepEqual(t.ops().at(-1).args.position, 99, '恢复后（节流到点）要把内存里那条补上');
});

// ────────── 3. 逐条补发 ──────────

await test('补发逐条：第 2 条在第 1 条的 ack 之前没有发出', async () => {
  const t = setup();
  t.core.addStudy('2026-03-01', 30);
  t.clock.advance(10);
  t.core.decideCard('v1', 7, 1);
  t.clock.advance(10);
  t.core.stopTurn('turn-1');
  assert.equal(t.ops().length, 1, '入队三条只发出一帧：一次性全发会让「已送达」失去边界');
  assert.equal(t.ops()[0].op, 'study.add', '发的是队首（入队序最早那条）');

  // 各种「它以为到了」的信号都不许放行下一条
  t.clock.advance(3000);
  t.core.tick();
  assert.equal(t.ops().length, 1, '退避定时器也不能放行下一条（在途那条还没回执）');
  t.core.dispatch(encodeFrame(ackFrame('guest-other', t.ops()[0].opId, 1))); // 别人的回执
  assert.equal(t.ops().length, 1, '别人的 ack 不算数');

  t.core.dispatch(encodeFrame(ackOk(GUEST, t.ops()[0].opId)));
  assert.equal(t.ops().length, 2, '自己那条的 ack 到了才发第 2 条');
  assert.equal(t.ops()[1].op, 'card.decide');

  t.core.dispatch(encodeFrame(ackOk(GUEST, t.ops()[1].opId)));
  assert.equal(t.ops().length, 3);
  assert.equal(t.ops()[2].op, 'chat.stop', 'stopTurn 走同一条队列（幂等，断链时排队比丢掉好）');
  assert.deepEqual(t.ops()[2].args, { turnId: 'turn-1' });

  t.core.dispatch(encodeFrame(ackOk(GUEST, t.ops()[2].opId)));
  assert.equal(t.outbox.pendingCount(), 0, '三条都回执完 → 队列空');
  assert.deepEqual(t.pending, [1, 2, 3, 2, 1, 0], 'onPendingOps 逐次报数（0 时 UI 自己决定不显示）');
});

await test('逐条：队列头在途时又入队新 op → 仍然只发一条', async () => {
  const t = setup();
  t.core.addStudy('2026-03-01', 30);
  t.core.addStudy('2026-03-01', 30);
  assert.equal(t.ops().length, 1);
  t.core.dispatch(encodeFrame(ackOk(GUEST, t.ops()[0].opId)));
  assert.equal(t.ops().length, 2);
  assert.equal(t.outbox.pendingCount(), 1);
});

await test('逐条：ack 看门狗 —— 回执丢了自己原样重发（同 opId，host 侧幂等）', async () => {
  const t = setup();
  t.core.addStudy('2026-03-01', 30);
  assert.equal(t.ops().length, 1);
  t.clock.advance(14000);
  t.core.tick();
  assert.equal(t.ops().length, 1, '15s 内不该重发');
  t.clock.advance(2000);
  t.core.tick();
  assert.equal(t.ops().length, 2, '回执一直没来就原样重发（否则逐条补发永远卡在队首）');
  assert.equal(t.ops()[1].opId, t.ops()[0].opId, '重发必须是同一个 opId：换了 id 就是两条 study.add，host 会累加两次');
});

// ────────── 4/5. ack 路由与失败分类 ──────────

await test('ack 路由：to 不是我的 → 队列不清、在途不清、下一条不发', async () => {
  const t = setup();
  t.core.addStudy('2026-03-01', 30);
  t.core.decideCard('v1', 3, 1);
  assert.equal(t.outbox.pendingCount(), 2);

  t.core.dispatch(encodeFrame(ackFrame('guest-b', t.outbox.list()[0].clientOpId, 1)));
  assert.equal(t.outbox.pendingCount(), 2, '广播 ack 会让这台删掉它从没发过的 op（不变量 7）');
  assert.equal(t.ops().length, 1, '别人的 ack 也不许被当成「在途那条的回执」');

  t.core.dispatch(encodeFrame(ackFrame('*', t.outbox.list()[0].clientOpId, 1)));
  assert.equal(t.outbox.pendingCount(), 2, "'*' 同样不认：host 的 ack 一律定向（protocol.ts 的 AckFrame）");

  // 自己那条的回执：正常清空并续发
  t.core.dispatch(encodeFrame(ackOk(GUEST, t.ops()[0].opId)));
  assert.equal(t.outbox.pendingCount(), 1);
  assert.equal(t.ops().length, 2);
});

await test('ok:0 + gone（终态）→ 从队列移除，不重试；ok:0 + internal（暂态）→ 保留且 attempts+1', async () => {
  const t = setup();
  t.core.addStudy('2026-03-01', 30);
  const goneId = t.ops()[0].opId;
  t.clock.advance(10);
  t.core.decideCard('v1', 999, 1); // 那张卡已经不在了
  assert.equal(t.outbox.pendingCount(), 2);

  t.core.dispatch(encodeFrame(ackFrame(GUEST, goneId, 0, 'gone')));
  assert.equal(t.outbox.pendingCount(), 1, 'gone 重试不会有结果（卡重新生成换过 id），留着还会堵队首');
  assert.equal(t.outbox.list()[0].op, 'card.decide');
  assert.equal(t.ops().length, 2, '终态失败照常继续发下一条（不是链断了）');

  // internal：配额满 / 库被锁 —— 必须留着重试，且**不原地自旋**
  const internalId = t.ops()[1].opId;
  t.core.dispatch(encodeFrame(ackFrame(GUEST, internalId, 0, 'internal')));
  assert.equal(t.outbox.pendingCount(), 1, 'internal 是暂态：静默丢掉一条 study.add 就是静默丢用户数据');
  assert.equal(t.outbox.list()[0].attempts, 1);
  assert.equal(t.ops().length, 2, '原地重试会把那条写不进去的 op 反复推给 host，堵住它后面所有能送达的 op');

  t.clock.advance(2999);
  t.core.tick();
  assert.equal(t.ops().length, 2, '退避窗口内不重发');
  t.clock.advance(2);
  t.core.tick();
  assert.equal(t.ops().length, 3, '退避到点后重发同一帧');
  assert.equal(t.ops()[2].opId, internalId);

  // 配额用尽即丢弃：重试到死也不能一直占着队首
  const small = setup({ maxAttempts: 2 });
  small.core.addStudy('2026-03-01', 30);
  const id = small.ops()[0].opId;
  small.core.dispatch(encodeFrame(ackFrame(GUEST, id, 0, 'internal')));
  assert.equal(small.outbox.pendingCount(), 1);
  small.core.dispatch(encodeFrame(ackFrame(GUEST, id, 0, 'internal')));
  assert.equal(small.outbox.pendingCount(), 0, 'attempts 到配额就丢：再重试只是让用户干等');
});

await test('坏 ack（ok 不是 1 / reason 不认识）按失败处理，不当送达', async () => {
  const t = setup();
  t.core.addStudy('2026-03-01', 30);
  const id = t.ops()[0].opId;
  t.core.dispatch(encodeFrame(ackFrame(GUEST, id, 0, 'who-knows')));
  assert.equal(t.outbox.pendingCount(), 1, '不认识的原因按暂态（最多多重试几次），当终态就是静默丢数据');
  assert.equal(t.outbox.list()[0].attempts, 1);
});

// ────────── 6/7. 问答流 ──────────

await test('问答：chat.ev(delta)×N → chat.done 组装出内容（并带上思考 / 工具提示 / 题卡）', async () => {
  const t = setup();
  const turnId = t.core.ask('v1', '贝叶斯定理是什么？');
  const req = t.sent.find((f) => f.t === FRAME.chatReq);
  assert.equal(req.from, GUEST, 'chat.req 必须带 from：host 靠它把整轮流定向回来');
  assert.equal(req.to, '*', '来宾→主机方向恒为 *（当前只有一台主机）');
  assert.equal(req.turnId, turnId);
  assert.equal(t.turns.at(-1).state, 'streaming');

  t.core.dispatch(encodeFrame(chatEv(GUEST, turnId, 'reasoning', { text: '先想想' })));
  t.core.dispatch(encodeFrame(chatEv(GUEST, turnId, 'round', { round: 0 })));
  t.core.dispatch(encodeFrame(chatEv(GUEST, turnId, 'tool', { text: '正在检索字幕…' })));
  t.core.dispatch(encodeFrame(chatEv(GUEST, turnId, 'delta', { text: '贝叶斯' })));
  t.core.dispatch(encodeFrame(chatEv(GUEST, turnId, 'delta', { text: '定理说的是' })));
  t.core.dispatch(encodeFrame({ v: PROTOCOL_VERSION, t: FRAME.chatCard, id: turnId, to: GUEST, turnId, kind: 'quiz', payload: { data: { questions: [] } } }));

  const mid = t.turns.at(-1);
  assert.equal(mid.content, '贝叶斯定理说的是');
  assert.equal(mid.reasoning, '先想想');
  assert.equal(mid.toolHint, '', '正文一来，工具提示让位（ChatPanel 的 hint: undefined）');
  assert.equal(mid.quiz.data.questions.length, 0, '题卡随流上屏（不变量 5：不阻塞）');

  t.core.dispatch(encodeFrame({ v: PROTOCOL_VERSION, t: FRAME.chatDone, id: turnId, to: GUEST, turnId, content: '贝叶斯定理说的是用证据更新先验概率。', reasoning: '先想想', reasoningMs: 1234 }));
  const done = t.turns.at(-1);
  assert.equal(done.state, 'done');
  assert.equal(done.content, '贝叶斯定理说的是用证据更新先验概率。');
  assert.equal(done.finalContent, done.content, 'done 的 content 是权威正文（落库只在主机）');
  assert.equal(done.reasoningMs, 1234);
  assert.equal(done.question, '贝叶斯定理是什么？', '本地镜像记着用户那一问（UI 渲染气泡用）');
  assert.equal(t.core.turn(turnId).content, done.content);
});

await test('问答：to 是别人的帧一律忽略（不变量 7：两台设备的流不许互相看见）', async () => {
  const t = setup();
  const mine = t.core.ask('v1', '我的问题');
  const other = 'turn-of-guest-b';
  t.flush();
  t.core.dispatch(encodeFrame(chatEv('guest-b', other, 'delta', { text: '别人的答案' })));
  t.core.dispatch(encodeFrame(chatEv('*', other, 'delta', { text: '广播的答案' })));
  t.core.dispatch(encodeFrame({ v: PROTOCOL_VERSION, t: FRAME.chatDone, id: other, to: 'guest-b', turnId: other, content: '别人的答案' }));
  assert.equal(t.turns.length, 1, '别人的轮次连状态都不该在本机出现');
  assert.equal(t.turns[0].content, '', '别的事件不许动本机的内容');
  assert.equal(t.core.turn(other), undefined);

  // 我这一轮的帧正常收
  t.core.dispatch(encodeFrame(chatEv(GUEST, mine, 'delta', { text: '我的答案' })));
  assert.equal(t.core.turn(mine).content, '我的答案');
});

await test('问答：多图随流保留、done 权威载荷补齐，不覆盖前图', async () => {
  const t = setup();
  const turnId = t.core.ask('v1', '比较两种情况');
  const widgets = [1, 2].map((index) => ({ id: `widget-${index}`, ref: `widget-${index}`, html: `<p>图 ${index}</p>` }));
  for (const payload of widgets) t.core.dispatch(encodeFrame({ v: PROTOCOL_VERSION, t: FRAME.chatCard, id: turnId, to: GUEST, turnId, kind: 'widget', payload }));
  assert.deepEqual(t.core.turn(turnId).widgets, widgets);
  assert.deepEqual(t.core.turn(turnId).widget, widgets[1]);
  const final = [...widgets, { id: 'final', ref: 'final', html: '<p>收尾补齐</p>' }];
  t.core.dispatch(encodeFrame({ v: PROTOCOL_VERSION, t: FRAME.chatDone, id: turnId, to: GUEST, turnId, content: '比较结果', widget: final[2], widgets: final }));
  assert.deepEqual(t.core.turn(turnId).widgets, final);
  assert.deepEqual(t.core.turn(turnId).widget, final[2]);
});

await test('问答：chat.err → 该轮转 error，不影响已完成的那一轮', async () => {
  const t = setup();
  const first = t.core.ask('v1', '第一问');
  t.core.dispatch(encodeFrame(chatEv(GUEST, first, 'delta', { text: '答：' })));
  t.core.dispatch(encodeFrame({ v: PROTOCOL_VERSION, t: FRAME.chatDone, id: first, to: GUEST, turnId: first, content: '答：贝叶斯' }));

  const second = t.core.ask('v1', '第二问');
  t.core.dispatch(encodeFrame({ v: PROTOCOL_VERSION, t: FRAME.chatErr, id: second, to: GUEST, turnId: second, message: '模型网关超时' }));

  assert.equal(t.core.turn(first).state, 'done', '一台设备的一次失败不许把别的轮次（哪怕同机）标成出错');
  assert.equal(t.core.turn(first).content, '答：贝叶斯');
  const err = t.core.turn(second);
  assert.equal(err.state, 'error');
  assert.equal(err.error, '模型网关超时');
  assert.equal(t.core.turn('turn-not-mine'), undefined, '不认识的一轮：忽略（不新建状态）');
});

await test('问答：离线时提问直接判错、不排队（设计非目标：不做离线攒提问）', async () => {
  const t = setup({ online: false });
  const turnId = t.core.ask('v1', '主机不在我问一句');
  assert.equal(t.sent.filter((f) => f.t === FRAME.chatReq).length, 0, '离线不许攒提问：用户会以为已经问出去了');
  assert.equal(t.core.turn(turnId).state, 'error');
  assert.match(t.core.turn(turnId).error, /主机不在线/);
  assert.equal(t.outbox.pendingCount(), 0, '提问不进 outbox（它不是一条写 op）');
});

await test('问答：stopTurn 发 chat.stop op（带 from），停一轮后那一轮仍以 done 收尾', async () => {
  const t = setup();
  const turnId = t.core.ask('v1', '讲讲贝叶斯');
  t.core.dispatch(encodeFrame(chatEv(GUEST, turnId, 'delta', { text: '先说一句：' })));
  t.core.stopTurn(turnId);
  const stop = t.ops().at(-1);
  assert.equal(stop.op, 'chat.stop');
  assert.equal(stop.from, GUEST);
  assert.deepEqual(stop.args, { turnId });
  // host abort 后回 chat.done（保留已流出内容 + 「已停止生成」），不是 chat.err
  t.core.dispatch(encodeFrame({ v: PROTOCOL_VERSION, t: FRAME.chatDone, id: turnId, to: GUEST, turnId, content: '先说一句：（已停止生成）' }));
  assert.equal(t.core.turn(turnId).state, 'done');
});

// ────────── 8. 稳定 guest id ──────────

await test('guest id 稳定：同一份会话存储下两次取是同一个 id（Task 5 那条问题）', async () => {
  const store = memIdStore();
  const first = resolveGuestId(store);
  const second = resolveGuestId(store);
  assert.equal(second, first, '刷新/重连后必须是同一个 id，否则 host 的 guests 表只增不减（共享条上的设备数虚高）');
  assert.match(first, /^guest-[0-9a-f]{16}$/);
  assert.equal(store.getItem(GUEST_ID_STORAGE_KEY), first);

  const other = resolveGuestId(memIdStore());
  assert.notEqual(other, first, '另一个标签页 / 另一个浏览器应该是**独立**的来宾（各自一份 outbox 与问答流）');
});

await test('guest id：拿不到会话存储时退回内存内生成（连不上比多一台设备严重得多）', async () => {
  // sessionStorage 被禁（隐私模式）：连 getItem 都会抛
  const blocked = {
    getItem() {
      throw new DOMException('denied', 'SecurityError');
    },
    setItem() {
      throw new DOMException('denied', 'SecurityError');
    },
  };
  const a = resolveGuestId(blocked);
  const b = resolveGuestId(blocked);
  assert.match(a, /^guest-[0-9a-f]{16}$/, '读不到就现生成，不能抛（抛出去来宾页直接打不开）');
  assert.notEqual(a, b, '写不进去的代价：刷新后 host 侧会当另一台（已写明，比连不上可接受）');
  assert.match(resolveGuestId(null), /^guest-[0-9a-f]{16}$/, 'store 为 null（没有 sessionStorage）也要能用');
});

// ────────── 9. 版本显式失败 ──────────

await test('版本不匹配：welcome 的 hostVersion 对不上 → 显式报错，且此后不再发 op', async () => {
  const t = setup({ online: false });
  t.core.dispatch(encodeFrame({ v: PROTOCOL_VERSION, t: FRAME.welcome, id: GUEST, hostVersion: 1 }));
  assert.deepEqual(t.errors, [VERSION_MISMATCH_TEXT], '必须是那句明说，不能退化成「主机已离线」（主机是在线的，那是误导）');
  t.core.addStudy('2026-03-01', 30);
  assert.equal(t.ops().length, 0, '版本对不上就别发了：host 那边早把连接关了');
  assert.equal(t.outbox.pendingCount(), 1, '但操作仍留在 outbox 里，用户刷新后能补上');
});

await test('版本不匹配：连信封 v 都不对的 welcome 也要被认出来（宽松解只放宽版本一项）', async () => {
  const t = setup({ online: false });
  // 一个 v1 的 host 发来的 welcome：严格解码会当坏帧丢掉 —— 那就永远不会有人告诉用户真相
  t.core.dispatch(JSON.stringify({ v: 1, t: FRAME.welcome, id: GUEST }));
  assert.deepEqual(t.errors, [VERSION_MISMATCH_TEXT]);
});

// ───────────────────────── 真 socket 集成（stub 中继 + 真 ws） ─────────────────────────
// core 测不到「socket 这一层自己搞坏接线」：hello 有没有发出去、from 有没有真的上到线上、
// close(4400) 有没有变成那句明说。下面这几条跑的是完整的 LiveGuest。

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
    const text = isBinary ? null : data.toString();
    // 测试专用的一跳：host 让中继用某个 close code 关掉所有 guest 的 socket。
    // 真中继不转发 host 的 close code（protocol.ts 的 CLOSE_PROTOCOL_MISMATCH 已注明），
    // 这里补上它，好让「来宾收到 4400」这一路能被验到。
    if (role === 'host' && text) {
      let ctl2 = null;
      try {
        ctl2 = JSON.parse(text);
      } catch {
        ctl2 = null;
      }
      if (ctl2?.ctl === 2 && ctl2.t === 'close-guests') {
        for (const g of r.guests) if (g.readyState === NodeWs.OPEN) g.close(ctl2.code, ctl2.reason);
        return;
      }
    }
    const targets = role === 'host' ? [...r.guests] : r.host ? [r.host] : [];
    for (const t of targets) if (t.readyState === NodeWs.OPEN) t.send(data, { binary: isBinary });
  });
  ws.on('close', () => {
    if (role === 'host') {
      r.host = null;
      for (const g of r.guests) if (g.readyState === NodeWs.OPEN) g.send(JSON.stringify({ ctl: 1, t: FRAME.hostLinkDown, id: 'relay' }));
    } else r.guests.delete(ws);
  });
});

/** 一个假 host：收帧、记帧、按需回 ack / welcome / 关连接 */
function startFakeHost(room) {
  const ws = new NodeWs(`${RELAY}?room=${encodeURIComponent(room)}&role=host`);
  const frames = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    frames.push(JSON.parse(data.toString()));
  });
  const send = (f) => ws.send(JSON.stringify(f));
  const waitFor = async (pred, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const hit = frames.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    throw new Error(`超时等不到 ${label}；已收到 [${frames.map((f) => f.t).join(', ')}]`);
  };
  return { ws, frames, send, waitFor, close: () => ws.close() };
}

/** LiveGuest 用到的浏览器全局（页面里是现成的；Node 里只补最少的形状） */
function memWebStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
}
const sessionStores = memWebStorage();
globalThis.sessionStorage = sessionStores;
const pageHooks = new Map();
globalThis.window = {
  // 桩挂在 window 上（与生产一致）：放在 globalThis 上会让 outbox 那条 localStorage
  // 路径静默降级成「只有内存」，测试就跑不到真接线了。
  sessionStorage: sessionStores,
  localStorage: memWebStorage(),
  addEventListener: (t, fn) => pageHooks.set(t, fn),
  removeEventListener: (t) => pageHooks.delete(t),
};
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: (t, fn) => pageHooks.set(`doc:${t}`, fn),
  removeEventListener: (t) => pageHooks.delete(`doc:${t}`),
};
globalThis.WebSocket = NodeWs;

const openClients = [];
/** 起一台真 LiveGuest（共用同一份 sessionStorage：模拟「同一台设备的第二个标签页/第二次打开」） */
function startGuest(room, opts = {}) {
  const g = new LiveGuest({ relayUrl: RELAY, code: room, ...opts });
  openClients.push(g);
  return g;
}

let roomSeq = 0;
const nextRoom = () => `room-${++roomSeq}`;

// ────────── 10. 集成：hello / from 上线 / ack 清空 outbox ──────────

await test('真链路：hello 带 clientVersion；op 的 from 上了线；ack 回来后 outbox 清空', async () => {
  const room = nextRoom();
  const host = startFakeHost(room);
  await once(host.ws, 'open');
  const guest = startGuest(room);
  await guest.connect();

  const hello = await host.waitFor((f) => f.t === FRAME.hello, 'hello');
  assert.equal(hello.id, guest.guestId, 'hello 的 id 就是本机的 guest id（bye / from 必须同一个）');
  assert.equal(hello.clientVersion, PROTOCOL_VERSION, 'hello 要带 clientVersion（host 判版本不匹配的唯一依据）');
  host.send(welcomeFrame(hello.id));

  guest.addStudy('2026-03-01', 30);
  const op = await host.waitFor((f) => f.t === FRAME.op, 'op');
  assert.equal(op.from, guest.guestId, 'from 必须真的上了线：host 查不到在席就静默拒收（不 apply、不 ack）');
  assert.equal(op.op, 'study.add');
  assert.equal(guest.pendingOps(), 1);

  host.send(ackFrameFor(guest.guestId, op.opId, { ok: true }));
  const t0 = Date.now();
  while (guest.pendingOps() > 0 && Date.now() - t0 < 4000) await sleep(20);
  assert.equal(guest.pendingOps(), 0, 'ack 回来后队列要清空（否则共享条上的「N 条待补发」永远不减）');

  guest.close();
  const bye = await host.waitFor((f) => f.t === FRAME.bye, 'bye');
  assert.equal(bye.id, guest.guestId, 'bye 换个 id 发，host 侧设备数就减不下来（不报错，只是计数黏住）');
  host.close();
});

await test('真链路：同一次刷新（同一份 sessionStorage）两次连接是同一个 guest id', async () => {
  const room = nextRoom();
  const host = startFakeHost(room);
  await once(host.ws, 'open');
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const g = startGuest(room);
    await g.connect();
    await host.waitFor((f) => f.t === FRAME.hello, `第 ${i + 1} 个 hello`);
    ids.push(g.guestId);
    host.send(welcomeFrame(g.guestId));
    g.close(); // 页面卸载（bye）之后「刷新」再来一次
    await sleep(60);
  }
  const hellos = host.frames.filter((f) => f.t === FRAME.hello);
  assert.equal(hellos.length, 2, '两次连接都要发 hello');
  assert.equal(hellos[0].id, hellos[1].id, 'host 的 guests Map 按 hello id 去重：id 换了就是「多了一台设备」，计数只增不减');
  assert.equal(ids[0], ids[1], '两次实例化取的是同一份 sessionStorage（模拟同一个标签页刷新）');
  host.close();
});

await test('真链路：close(4400) → 那句明说（不是「主机已离线」）', async () => {
  const room = nextRoom();
  const host = startFakeHost(room);
  await once(host.ws, 'open');
  const errors = [];
  const closed = [];
  const guest = startGuest(room, { onError: (m) => errors.push(m), onClosed: (i) => closed.push(i) });
  await guest.connect();
  await host.waitFor((f) => f.t === FRAME.hello, 'hello');

  // 桩中继补一跳：让 host 能把「版本不匹配」那个 close code 送到 guest 的 socket 上
  // （真中继目前不透传 host 的 close code，见 protocol.ts 的 CLOSE_PROTOCOL_MISMATCH 注释；
  //  这一跳落地之前，来宾侧只能看到 host-link-down —— 但接线必须先把那句话备好）
  host.send({ ctl: 2, t: 'close-guests', code: CLOSE_PROTOCOL_MISMATCH, reason: 'version' });

  const t0 = Date.now();
  while (errors.length === 0 && Date.now() - t0 < 4000) await sleep(20);
  assert.deepEqual(errors, [VERSION_MISMATCH_TEXT], '版本不匹配必须落到那句明说：刷新才是修复动作');
  assert.match(VERSION_MISMATCH_TEXT, /刷新/, '文案要给出真正的修复动作，否则用户会去查主机有没有开共享');
  assert.equal(closed.at(-1)?.code, CLOSE_PROTOCOL_MISMATCH, 'close 事件照常发（页面仍拿它判「别重连」）');

  host.close();
});

await test('真链路：pagehide 钩子把内存里那条进度补出去（节流窗口内也发）', async () => {
  const room = nextRoom();
  const host = startFakeHost(room);
  await once(host.ws, 'open');
  const guest = startGuest(room);
  await guest.connect();
  const hello = await host.waitFor((f) => f.t === FRAME.hello, 'hello');
  host.send(welcomeFrame(hello.id));

  guest.setPosition('v1', 10, false); // 第一条立刻发（节流起点）
  await host.waitFor((f) => f.t === FRAME.op, '第一条进度');
  guest.setPosition('v1', 1234, false); // 节流窗口内：只留内存里那一条
  assert.equal(host.frames.filter((f) => f.t === FRAME.op).length, 1);

  const onPageHide = pageHooks.get('pagehide');
  assert.ok(onPageHide, 'pagehide 钩子必须挂着（页面卸载时它才是「真的要走了」的标准信号）');
  onPageHide();
  const flushed = await host.waitFor((f) => f.t === FRAME.op && f.args.position === 1234, 'pagehide 补发的进度');
  assert.equal(flushed.from, guest.guestId);
  assert.equal(guest.pendingOps(), 0, '进度永远不进 outbox（最后写入胜出语义）');

  // 切到后台同样补一条
  guest.setPosition('v1', 2400, false);
  globalThis.document.visibilityState = 'hidden';
  pageHooks.get('doc:visibilitychange')();
  await host.waitFor((f) => f.t === FRAME.op && f.args.position === 2400, 'visibilitychange 补发的进度');
  globalThis.document.visibilityState = 'visible';

  guest.close();
  host.close();
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
// 关掉所有还开着的连接再退出：留一个活着的 socket，事件循环就永远不空，脚本会「跑完却不退出」。
for (const g of openClients) g.close();
for (const g of rooms.keys()) {
  const r = rooms.get(g);
  if (r.host) r.host.close();
  for (const ws of r.guests) ws.close();
}
wss.close();
rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} 通过，${failures.length} 失败`);
process.exit(failures.length > 0 ? 1 : 0);
