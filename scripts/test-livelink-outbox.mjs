#!/usr/bin/env node
/**
 * guest 侧 outbox（src/livelink/outbox.ts）的断言：入队顺序、落盘恢复、失败分类、去重。
 *
 * Node ≥22.18 原生类型剥离子句直接跑 .ts。outbox.ts 只 import type（ops.ts 的类型），
 * 没有 Dexie / localStorage 依赖，所以在 Node 里零装配。运行：node scripts/test-livelink-outbox.mjs
 *
 * 这些断言守的不是「记录能不能写出去」（那太浅），而是四条**静默**失败：
 *   1. 终态失败被重试：not-found / gone / bad-args / unknown-op 重试多少次都不会变（课程
 *      被删、卡重新生成换了 id、参数脏、op 名不认识）。留着它不只是白试，还会堵住队首，
 *      把后面本来能送达的 op 一起卡住。
 *   2. 暂态失败被丢掉：internal 多半是配额满这类临时故障，静默丢掉一条 study.add 就是
 *      静默丢用户数据（设计不变量 4「断链不丢写」）。必须留着重试到配额用尽。
 *   3. 同一 clientOpId 入队两次：host 侧靠它去重（ops.ts 的 DedupStore 是准入条件），
 *      重复入队 + 重放 = study.add 累加两次 = 双倍时长，而热力图只是深了一格。
 *   4. 坏 localStorage 让页面打不开：待发队列是缓存不是数据，宁可丢队列。
 *
 * 另有一条**反向**断言：`position.set` 禁止入队（它必须抛错而不是默默排队）。
 * 进度是最后写入胜出语义，攒队列会让「拖到 40 分钟然后关页面」丢掉最后一条 —— 而这是
 * 最常见的用法，不是不常见的边缘情形。
 *
 * 作用域：这里只管「记录的生命周期」。帧格式归 protocol.ts，补发接线归 guest.ts，
 * host 侧落库归 test-livelink-ops.mjs。
 */
import assert from 'node:assert/strict';

const { Outbox, OUTBOX_STORAGE_KEY, createLocalStorageOutbox } = await import('../apps/web/src/livelink/outbox.ts');

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

/** 内存 storage：既是「落盘」，也能模拟写坏（initial）与写不进去（failsOnWrite） */
function memStorage(initial = null, failsOnWrite = false) {
  let data = initial;
  return {
    read: () => data,
    write: (s) => {
      if (failsOnWrite) throw new Error('QuotaExceededError');
      data = s;
    },
    /** 直接看落盘的字符串：断的是「格式」而不是「行为」时要看得见 */
    raw: () => data,
  };
}

/** 造一条合法的落盘串（绕过 API 直接写坏结构时用） */
function dump(records) {
  return JSON.stringify(records);
}

// ────────── 1. 入队顺序 ──────────

await test('入队按序返回：list() 是入队序，next() 是待发第一条', () => {
  const ob = new Outbox(memStorage());
  assert.equal(ob.pendingCount(), 0);
  assert.equal(ob.next(), undefined);

  const a = ob.enqueue('card.decide', { videoId: 'v1', cardId: 7, status: 1 });
  const b = ob.enqueue('chat.stop', { turnId: 't1' });
  const c = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 });

  assert.deepEqual(ob.list().map((r) => r.op), ['card.decide', 'chat.stop', 'study.add']);
  assert.deepEqual(ob.list().map((r) => r.clientOpId), [a.clientOpId, b.clientOpId, c.clientOpId]);
  assert.equal(ob.pendingCount(), 3);
  assert.equal(ob.next().clientOpId, a.clientOpId, '重连后必须按入队序补发，不是按哈希序');
  assert.deepEqual(ob.next().args, { videoId: 'v1', cardId: 7, status: 1 });
});

await test('新记录 attempts 从 0 起，enqueuedAt 取注入的时钟', () => {
  let t = 1_000_000;
  const ob = new Outbox(memStorage(), { now: () => t });
  const a = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 });
  t = 1_060_000; // 一分钟后
  const b = ob.enqueue('study.add', { date: '2026-10-13', seconds: 30 });
  assert.equal(a.enqueuedAt, 1_000_000);
  assert.equal(b.enqueuedAt, 1_060_000);
  assert.equal(a.attempts, 0);
  assert.equal(b.attempts, 0);
});

await test('list() 给的是副本：调用方改了它，内部队列不受影响', () => {
  const ob = new Outbox(memStorage());
  const a = ob.enqueue('chat.stop', { turnId: 't1' });
  ob.list()[0].clientOpId = 'hacked';
  ob.list().push({ clientOpId: 'x', op: 'chat.stop', args: {}, enqueuedAt: 0, attempts: 0 });
  assert.equal(ob.pendingCount(), 1);
  assert.equal(ob.list()[0].clientOpId, a.clientOpId);
});

// ────────── 2. 落盘往返 ──────────

await test('落盘往返：换一个新实例读同一份数据，记录还在（含 attempts 与 enqueuedAt）', () => {
  const store = memStorage();
  const first = new Outbox(store, { now: () => 1234 });
  const a = first.enqueue('study.add', { date: '2026-10-13', seconds: 60 });
  const b = first.enqueue('card.decide', { videoId: 'v1', cardId: 7, status: 2 });
  assert.equal(first.fail(a.clientOpId, 'internal'), 'retry'); // attempts 变成 1

  // 换实例 = 页面刷新 / 重开：队列必须还在，否则断链期间的操作静默消失（不变量 4）
  const second = new Outbox(store);
  assert.deepEqual(
    second.list().map((r) => [r.clientOpId, r.op, r.args, r.enqueuedAt, r.attempts]),
    [
      [a.clientOpId, 'study.add', { date: '2026-10-13', seconds: 60 }, 1234, 1],
      [b.clientOpId, 'card.decide', { videoId: 'v1', cardId: 7, status: 2 }, 1234, 0],
    ],
  );
  assert.equal(second.pendingCount(), 2);
  assert.equal(second.next().clientOpId, a.clientOpId);
});

await test('ack 后落盘里真的少了一条（新实例读不到）', () => {
  const store = memStorage();
  const ob = new Outbox(store);
  const a = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 });
  ob.enqueue('chat.stop', { turnId: 't1' });
  ob.ack(a.clientOpId);
  assert.deepEqual(new Outbox(store).list().map((r) => r.op), ['chat.stop']);
});

// ────────── 3. ack ──────────

await test('ack 移除对应记录，其余不动', () => {
  const ob = new Outbox(memStorage());
  const a = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 });
  const b = ob.enqueue('study.add', { date: '2026-10-13', seconds: 30 });
  ob.ack(b.clientOpId);
  assert.deepEqual(ob.list().map((r) => r.clientOpId), [a.clientOpId]);
  assert.equal(ob.pendingCount(), 1);
  assert.equal(ob.next().clientOpId, a.clientOpId);
});

await test('ack 不存在的 opId：安静处理（ack 与 fail 会因重试时序错位到达）', () => {
  const store = memStorage();
  const ob = new Outbox(store);
  const a = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 });
  ob.ack('never-existed');
  assert.equal(ob.pendingCount(), 1, '不存在的 opId 不能把队列清空');
  // 重复 ack 同一条（重连补发后 host 又回一次 ack）也不能出事
  ob.ack(a.clientOpId);
  ob.ack(a.clientOpId);
  assert.equal(ob.pendingCount(), 0);
  assert.equal(new Outbox(store).pendingCount(), 0);
});

// ────────── 4. 终态失败 ──────────

for (const reason of ['not-found', 'gone', 'bad-args', 'unknown-op']) {
  await test(`fail(${reason}) → dropped 并移除（重试也不会变）`, () => {
    const ob = new Outbox(memStorage());
    const a = ob.enqueue('card.decide', { videoId: 'v1', cardId: 7, status: 1 });
    const keep = ob.enqueue('chat.stop', { turnId: 't1' });
    assert.equal(ob.fail(a.clientOpId, reason), 'dropped');
    assert.equal(ob.pendingCount(), 1);
    assert.deepEqual(ob.list().map((r) => r.clientOpId), [keep.clientOpId]);
    // 再来一次 fail（迟到的重试回执）不能误伤已经不在的记录，也不能碰别人
    assert.equal(ob.fail(a.clientOpId, reason), 'dropped');
    assert.equal(ob.pendingCount(), 1);
  });
}

await test('终态失败落盘也要真的写下去（新实例不能把这条再发一遍）', () => {
  const store = memStorage();
  const ob = new Outbox(store);
  const a = ob.enqueue('card.decide', { videoId: 'v1', cardId: 999, status: 1 });
  ob.fail(a.clientOpId, 'gone');
  assert.equal(new Outbox(store).pendingCount(), 0);
});

// ────────── 5. 暂态失败 ──────────

await test('fail(internal) → retry，记录仍在，attempts 累加', () => {
  const ob = new Outbox(memStorage());
  const a = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 });
  ob.enqueue('chat.stop', { turnId: 't1' }); // 后一条不许被牵连

  assert.equal(ob.fail(a.clientOpId, 'internal'), 'retry');
  assert.equal(ob.pendingCount(), 2, '静默丢掉一条 study.add 就是静默丢用户数据');
  assert.equal(ob.list()[0].attempts, 1);
  assert.equal(ob.fail(a.clientOpId, 'internal'), 'retry');
  assert.equal(ob.list()[0].attempts, 2);
  assert.deepEqual(ob.list()[0].args, { date: '2026-10-13', seconds: 60 }, '重试不改参数');
  assert.equal(ob.list()[0].enqueuedAt, a.enqueuedAt, '重试不改入队时间');
});

await test('fail(internal) 的 attempts 也落盘（刷新页面不能把退避计数清零）', () => {
  const store = memStorage();
  const ob = new Outbox(store);
  const a = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 });
  ob.fail(a.clientOpId, 'internal');
  ob.fail(a.clientOpId, 'internal');
  assert.equal(new Outbox(store).list()[0].attempts, 2);
});

// ────────── 6. 重试配额 ──────────

await test('连续 internal 到 maxAttempts → 丢弃并回 dropped（默认 5 次）', () => {
  const ob = new Outbox(memStorage());
  const a = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 });
  for (let i = 1; i <= 4; i++) {
    assert.equal(ob.fail(a.clientOpId, 'internal'), 'retry', `第 ${i} 次应当还留着`);
    assert.equal(ob.pendingCount(), 1);
  }
  assert.equal(ob.fail(a.clientOpId, 'internal'), 'dropped', '第 5 次用尽配额');
  assert.equal(ob.pendingCount(), 0);
  assert.equal(ob.next(), undefined);
});

await test('maxAttempts 可注入；用尽后只丢那一条，后面的照常补发', () => {
  const store = memStorage();
  const ob = new Outbox(store, { maxAttempts: 2 });
  const a = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 });
  const b = ob.enqueue('card.decide', { videoId: 'v1', cardId: 7, status: 1 });
  assert.equal(ob.fail(a.clientOpId, 'internal'), 'retry');
  assert.equal(ob.fail(a.clientOpId, 'internal'), 'dropped');
  assert.deepEqual(ob.list().map((r) => r.clientOpId), [b.clientOpId]);
  assert.equal(new Outbox(store).list().length, 1);
});

await test('队列顺序：队首丢一条之后 next() 递到下一条（不卡死）', () => {
  const ob = new Outbox(memStorage(), { maxAttempts: 1 });
  const a = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 });
  const b = ob.enqueue('chat.stop', { turnId: 't1' });
  assert.equal(ob.fail(a.clientOpId, 'internal'), 'dropped');
  assert.equal(ob.next().clientOpId, b.clientOpId);
});

// ────────── 7. position.set 禁止入队 ──────────

await test("enqueue('position.set') 抛错，且不留下任何记录", () => {
  const store = memStorage();
  const ob = new Outbox(store);
  const keep = ob.enqueue('chat.stop', { turnId: 't1' });
  assert.throws(() => ob.enqueue('position.set', { videoId: 'v1', position: 2400, finished: false }));
  assert.equal(ob.pendingCount(), 1);
  assert.equal(ob.list()[0].clientOpId, keep.clientOpId);
  assert.equal(new Outbox(store).pendingCount(), 1, '抛错不能把半条记录写进落盘');
});

await test('显式传入 clientOpId 时同样禁止 position.set', () => {
  const ob = new Outbox(memStorage());
  assert.throws(() => ob.enqueue('position.set', { videoId: 'v1', position: 1 }, 'pos-1'));
  assert.equal(ob.pendingCount(), 0);
});

// ────────── 8. clientOpId 去重契约 ──────────

await test('自动生成的 clientOpId 唯一（host 靠它去重，撞了就是重复累加）', () => {
  const ob = new Outbox(memStorage());
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(ob.enqueue('study.add', { date: '2026-10-13', seconds: 1 }).clientOpId);
  assert.equal(ids.size, 500);
  assert.ok([...ids].every((id) => typeof id === 'string' && id.length > 0));
});

await test('显式传入 clientOpId 就按传入值用（调用方要能自己定去重键）', () => {
  const ob = new Outbox(memStorage());
  const r = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 }, 'my-own-id');
  assert.equal(r.clientOpId, 'my-own-id');
  assert.equal(ob.list()[0].clientOpId, 'my-own-id');
});

await test('同一 clientOpId 不会被入队两次（第二入队返回原记录，参数不覆盖）', () => {
  const store = memStorage();
  const ob = new Outbox(store);
  const first = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 }, 'dup-1');
  const again = ob.enqueue('study.add', { date: '2026-10-13', seconds: 999 }, 'dup-1');
  assert.equal(ob.pendingCount(), 1, '重复 opId = host 侧可能累加两次时长');
  assert.equal(again.clientOpId, first.clientOpId);
  assert.deepEqual(again.args, { date: '2026-10-13', seconds: 60 }, '已入队的记录不许被后来者改写');
  assert.equal(new Outbox(store).pendingCount(), 1);
});

// ────────── 9. 坏落盘不许弄崩页面 ──────────

await test('损坏 JSON：当作空表，不抛（宁可丢待发队列，不可让页面打不开）', () => {
  for (const junk of ['{', 'not json at all', '', '[]', 'null', '{"a":1}']) {
    const ob = new Outbox(memStorage(junk));
    assert.equal(ob.pendingCount(), 0, `输入 ${JSON.stringify(junk)} 应当被当成空表`);
    assert.deepEqual(ob.list(), []);
    assert.equal(ob.next(), undefined);
  }
});

await test('落盘里混进坏记录：逐条筛掉，合法的那几条留下', () => {
  const store = memStorage(
    dump([
      { clientOpId: 'ok-1', op: 'study.add', args: { date: '2026-10-13', seconds: 1 }, enqueuedAt: 1, attempts: 0 },
      null,
      'nope',
      { op: 'chat.stop', args: {} }, // 缺 clientOpId / enqueuedAt
      { clientOpId: 'ok-2', op: 'card.decide', args: { cardId: 3 }, enqueuedAt: 2 }, // 缺 attempts：按 0 算
    ]),
  );
  const ob = new Outbox(store);
  assert.deepEqual(ob.list().map((r) => r.clientOpId), ['ok-1', 'ok-2']);
  assert.equal(ob.list()[1].attempts, 0);
  // 坏 op 名照收：由 host 回 unknown-op，我们据此丢弃（同一路径，不在这里猜名单）
  const store2 = memStorage(dump([{ clientOpId: 'x', op: 'video.nuke', args: {}, enqueuedAt: 1, attempts: 0 }]));
  assert.equal(new Outbox(store2).fail('x', 'unknown-op'), 'dropped');
});

await test('storage.write 抛异常（配额满/隐私模式）不许炸：记录仍在内存里，只是丢了持久性', () => {
  const ob = new Outbox(memStorage(null, true));
  const a = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 });
  assert.equal(ob.pendingCount(), 1);
  assert.equal(ob.fail(a.clientOpId, 'internal'), 'retry');
  assert.equal(ob.ack(a.clientOpId), undefined);
  assert.equal(ob.pendingCount(), 0);
});

// ────────── 10. localStorage 接线 ──────────

await test('localStorage adapter 用固定的 key 存一整份 JSON（刷新后读得回来）', () => {
  const data = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => data.set(k, v),
    },
  };
  try {
    const a = createLocalStorageOutbox();
    const ob = new Outbox(a);
    const rec = ob.enqueue('study.add', { date: '2026-10-13', seconds: 60 });
    assert.ok(data.has(OUTBOX_STORAGE_KEY), `应当写在 ${OUTBOX_STORAGE_KEY} 下`);
    assert.deepEqual(JSON.parse(data.get(OUTBOX_STORAGE_KEY)), [rec]);
    assert.equal(new Outbox(createLocalStorageOutbox()).list()[0].clientOpId, rec.clientOpId);
  } finally {
    delete globalThis.window;
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
