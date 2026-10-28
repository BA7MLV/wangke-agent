#!/usr/bin/env node
/**
 * host 侧写 op（src/livelink/ops.ts）的断言：apply 的幂等语义 + 队列的串行语义。
 *
 * Node ≥22.18 原生类型剥离子句直接跑 .ts；Dexie 在 Node 下靠 fake-indexeddb 驱动
 * （与 test-migration.mjs 同一套办法）。运行：node scripts/test-livelink-ops.mjs
 *
 * 这些断言守的不是「字段有没有写对」（那太浅），而是四条**静默**失败：
 *   1. study.add 重放双倍：它是累加语义（`seconds += delta`），重放一次就多记一段
 *      学习时长，而界面上完全看不出异常——热力图只是深了一格。去重表是准入条件，
 *      不是优化（设计文档 §不变量 3）。
 *   2. card.decide 打到别的行：卡片重新生成是 delete + bulkAdd 换新自增 id，
 *      老 cardId 要么查不到，要么**指向别门课的行**。不校验 videoId 就等于无条件
 *      相信远端给了对的 id，代价是把另一门课刚生成的卡静默改成「丢弃」。
 *   3. position.set 的 not-found：guest 拖的是一条 host 库里已经没有的课程进度条
 *      （host 刚删了课 / guest 的镜像过期）。认不出来就回 ok，Mac 上的进度条就永远
 *      停在旧值，而 ack 说一切正常。
 *   4. 队列不串行：两条 op 同时读改写同一天（一条本地 flush、一条来宾 op）就是 lost
 *      update，丢的那几秒谁也查不出来。并发上限 1 不是性能取舍，是正确性要求。
 *
 * 作用域：这里只管「op → DB 行」与「队列的顺序/失败传播」。帧格式归 protocol.ts
 * 的测试，socket 往返归 e2e-livelink.mjs。
 */
import assert from 'node:assert/strict';

const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

// db 与 ops 必须来自同一份源码（同一份 db 单例），否则测试会假绿
const { db } = await import('../apps/web/src/store/db.ts');
const { applyPosition, applyStudyAdd, applyCardDecide, applyChatStop, createLruDedup, OpQueue } =
  await import('../apps/web/src/livelink/ops.ts');

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

/** 造一条视频行（只需要 applyPosition 会碰的字段） */
async function seedVideo(id) {
  await db.videos.add({ id, name: `课${id}`, size: 1, mimeType: 'video/mp4', duration: 100, createdAt: 1, status: 'new' });
}

await db.delete();
await db.open();

// ────────── 1. position.set：赋值语义天然幂等；行不存在要明说 ──────────

await test('position.set 写入正确字段，未播完不碰 finished，重放不累加', async () => {
  await seedVideo('p1');
  assert.deepEqual(await applyPosition('p1', 42.5, false), { ok: true, rowId: 'p1' });
  let row = await db.videos.get('p1');
  assert.equal(row.lastPosition, 42.5);
  assert.equal(row.finished, undefined, '未播完的 op 不该顺手写 finished');

  // 重放同一条：赋值不是累加，值不变，且仍然回 ok（ack 必须幂等）
  assert.equal((await applyPosition('p1', 42.5, false)).ok, true);
  assert.equal((await db.videos.get('p1')).lastPosition, 42.5);

  // finished=true 才写标记，且写 1 而不是 true（DB 口径，见 VideoRow 的注释）
  await applyPosition('p1', 100, true);
  row = await db.videos.get('p1');
  assert.equal(row.finished, 1);
  assert.equal(row.lastPosition, 100);

  // 反向不回退：未播完的 op 不该把 finished 清掉（与 Player 的 setTime 同形）
  await applyPosition('p1', 50, false);
  assert.equal((await db.videos.get('p1')).finished, 1);
});

await test('position.set：行不存在 → not-found（不能回 ok，否则进度静默不更新）', async () => {
  assert.deepEqual(await applyPosition('no-such-video', 10, false), { ok: false, reason: 'not-found' });
  assert.equal((await db.videos.get('no-such-video')), undefined, 'not-found 不能凭空造出一行');
});

await test('position.set：坏参数拒收（NaN 进度会把主页进度条永久画成 NaN）', async () => {
  await seedVideo('p2');
  assert.deepEqual(await applyPosition('p2', NaN, false), { ok: false, reason: 'bad-args' });
  assert.deepEqual(await applyPosition('p2', -1, false), { ok: false, reason: 'bad-args' });
  assert.deepEqual(await applyPosition('', 1, false), { ok: false, reason: 'bad-args' });
  assert.equal((await db.videos.get('p2')).lastPosition, undefined);
});

// ────────── 2. study.add：去重是准入条件（本 Task 的核心断言） ──────────

await test('study.add：同一 opId 连发三次只累加一次', async () => {
  const dedup = createLruDedup();
  for (let i = 0; i < 3; i++) {
    const r = await applyStudyAdd('2026-10-13', 60, 'op-1', dedup);
    assert.equal(r.ok, true);
    assert.equal(r.rowId, '2026-10-13', 'rowId 回主键，便于 ack 里看出动的是哪天');
  }
  assert.equal((await db.studyDays.get('2026-10-13')).seconds, 60, '重放必然双倍 —— 去重表不是优化');
});

await test('study.add：不同 opId 各累加（去重不能误伤正常写入）', async () => {
  const dedup = createLruDedup();
  // 累加到已有行上（本地 flush 已经记过的今天）
  await db.studyDays.put({ date: '2026-10-14', seconds: 600, updatedAt: 1 });
  await applyStudyAdd('2026-10-14', 60, 'x1', dedup);
  await applyStudyAdd('2026-10-14', 30.44, 'x2', dedup);
  const row = await db.studyDays.get('2026-10-14');
  assert.equal(row.seconds, 690.4, '精度与 studyTime.flush 同口径（round1 到 0.1s）');
  assert.ok(row.updatedAt >= 1);

  // 新的一天走 put 分支
  await applyStudyAdd('2026-10-15', 15, 'y1', dedup);
  assert.equal((await db.studyDays.get('2026-10-15')).seconds, 15);
});

await test('study.add：坏参数拒收（脏日期键 / NaN 秒数会造出一行永远修不回来的账）', async () => {
  const dedup = createLruDedup();
  assert.deepEqual(await applyStudyAdd('10-13', 60, 'b1', dedup), { ok: false, reason: 'bad-args' });
  assert.deepEqual(await applyStudyAdd('2026-10-16', NaN, 'b2', dedup), { ok: false, reason: 'bad-args' });
  assert.deepEqual(await applyStudyAdd('2026-10-16', -5, 'b3', dedup), { ok: false, reason: 'bad-args' });
  assert.equal(await db.studyDays.get('10-13'), undefined);
  assert.equal(await db.studyDays.get('2026-10-16'), undefined);
  // 被拒的 op 不占去重名额（它没写库，重试还得能过）
  assert.equal(dedup.has('b1'), false);
});

// ────────── 3. card.decide：赋值幂等 + gone 分支 ──────────

await test('card.decide 写入 status 且可改判（赋值语义，重放不产生第二种结果）', async () => {
  const id = await db.cards.add({ videoId: 'c-video', q: 'q', a: 'a', time: 10, status: 0, createdAt: 1 });
  assert.deepEqual(await applyCardDecide('c-video', id, 1), { ok: true, rowId: id });
  assert.equal((await db.cards.get(id)).status, 1);
  await applyCardDecide('c-video', id, 2);
  assert.equal((await db.cards.get(id)).status, 2);
  await applyCardDecide('c-video', id, 0); // 撤销（SwipeDeck 的撤回）
  assert.equal((await db.cards.get(id)).status, 0);
});

await test('card.decide：cardId 不存在 → gone（重新生成换过 id，重试也不会回来）', async () => {
  const id = await db.cards.add({ videoId: 'c-video', q: 'q', a: 'a', time: 10, status: 0, createdAt: 1 });
  assert.deepEqual(await applyCardDecide('c-video', id + 9999, 1), { ok: false, reason: 'gone' });
});

await test('card.decide：cardId 属于别的课程 → gone，且不许写（错配的 op 会误伤别门课）', async () => {
  const other = await db.cards.add({ videoId: 'other-video', q: 'q', a: 'a', time: 10, status: 0, createdAt: 1 });
  assert.deepEqual(await applyCardDecide('c-video', other, 2), { ok: false, reason: 'gone' });
  assert.equal((await db.cards.get(other)).status, 0, '行存在不等于该写：videoId 必须对得上');
});

await test('card.decide：坏参数拒收（cardId 非整数时 db.cards.get 会抛 DataError）', async () => {
  const id = await db.cards.add({ videoId: 'c-video', q: 'q', a: 'a', time: 10, status: 0, createdAt: 1 });
  assert.deepEqual(await applyCardDecide('c-video', NaN, 1), { ok: false, reason: 'bad-args' });
  assert.deepEqual(await applyCardDecide('c-video', 1.5, 1), { ok: false, reason: 'bad-args' });
  assert.deepEqual(await applyCardDecide('c-video', id, 7), { ok: false, reason: 'bad-args' });
});

// ────────── 4. chat.stop：幂等 ──────────

await test('chat.stop 调 abort；没有 controller（轮次已结束）也算幂等成功', async () => {
  const ac = new AbortController();
  assert.deepEqual(await applyChatStop('turn-1', ac), { ok: true, rowId: 'turn-1' });
  assert.equal(ac.signal.aborted, true);

  // 重放同一条 stop：abort 两次无副作用，仍然回 ok
  assert.equal((await applyChatStop('turn-1', ac)).ok, true);

  // 找不到 controller 也回 ok：「停一个已经停下的轮次」是成功，不是失败
  assert.deepEqual(await applyChatStop('turn-missing'), { ok: true, rowId: 'turn-missing' });
});

await test('chat.stop 经队列：按 turnId 找到 controller 才 abort', async () => {
  const ac = new AbortController();
  const asked = [];
  const q = new OpQueue({ turnAbort: (turnId) => { asked.push(turnId); return turnId === 'turn-2' ? ac : undefined; } });
  assert.deepEqual(
    await q.enqueue({ clientOpId: 'c1', name: 'chat.stop', args: { turnId: 'turn-1' } }),
    { ok: true, rowId: 'turn-1' },
  );
  assert.equal(ac.signal.aborted, false);
  await q.enqueue({ clientOpId: 'c2', name: 'chat.stop', args: { turnId: 'turn-2' } });
  assert.deepEqual(asked, ['turn-1', 'turn-2']);
  assert.equal(ac.signal.aborted, true);
});

// ────────── 5. LRU 去重表 ──────────

await test('LRU 超限淘汰最旧的：加 513 条（limit 512）后最早的那条 has() 为 false', () => {
  const dedup = createLruDedup(512);
  for (let i = 0; i < 513; i++) dedup.add(`op-${i}`);
  assert.equal(dedup.has('op-0'), false, '最早的 op-0 应当被淘汰');
  assert.equal(dedup.has('op-1'), true);
  assert.equal(dedup.has('op-512'), true);
});

await test('LRU 按「最近一次写入」排热度：重复 add 的 opId 不会先被淘汰', () => {
  const dedup = createLruDedup(2);
  dedup.add('a');
  dedup.add('b');
  dedup.add('a'); // 重新加 a：它应当被提到最新
  dedup.add('c'); // 超限，淘汰最旧的 b
  assert.equal(dedup.has('b'), false);
  assert.equal(dedup.has('a'), true);
  assert.equal(dedup.has('c'), true);
});

// ────────── 6. 队列串行 ──────────

await test('队列串行：3 条并发入队的执行顺序 = 入队顺序，且任意时刻只有一条在跑', async () => {
  // 影子方法插一个 await 点：不这么做就只能断言「顺序碰巧对了」，断不出「其实并发跑了」
  const order = [];
  let inflight = 0;
  let maxInflight = 0;
  const realUpdate = db.videos.update.bind(db.videos);
  db.videos.update = async (key, changes) => {
    order.push(key);
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    try {
      await new Promise((r) => setTimeout(r, 5));
      return await realUpdate(key, changes);
    } finally {
      inflight--;
    }
  };
  try {
    for (const id of ['q1', 'q2', 'q3']) await seedVideo(id);
    const q = new OpQueue();
    const acks = [];
    q.onAck = (opId, r) => acks.push([opId, r.ok]);

    const running = ['q1', 'q2', 'q3'].map((videoId, i) =>
      q.enqueue({ clientOpId: `op-${i}`, name: 'position.set', args: { videoId, position: i + 1, finished: false } }),
    );
    assert.equal(q.depth, 3, '入队即排队（此刻还没开始跑）');
    assert.equal(q.busy, true);

    const results = await Promise.all(running);
    assert.deepEqual(order, ['q1', 'q2', 'q3'], '执行顺序必须等于入队顺序');
    assert.equal(maxInflight, 1, '并发上限是 1：两条 op 同时读改写同一天就是 lost update');
    assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
    assert.deepEqual(acks, [['op-0', true], ['op-1', true], ['op-2', true]]);
    assert.equal(q.depth, 0);
    assert.equal(q.busy, false);
  } finally {
    delete db.videos.update; // 还原成原型上的方法
  }
});

await test('队列里某条 apply 抛错：自己回 internal，后续 op 照常执行（一条坏 op 不许毒死整条链）', async () => {
  // 这一条会打一行 console.warn —— 它正是「失败只记日志」的证据，不是意外
  const realUpdate = db.videos.update.bind(db.videos);
  db.videos.update = async (key, changes) => {
    if (key === 'v-boom') throw new Error('配额爆了');
    return realUpdate(key, changes);
  };
  try {
    await seedVideo('v-ok');
    const q = new OpQueue();
    const acks = [];
    q.onAck = (opId, r) => acks.push([opId, r.ok, r.reason ?? null]);
    const results = await Promise.all([
      q.enqueue({ clientOpId: 'a', name: 'position.set', args: { videoId: 'v-boom', position: 1, finished: false } }),
      q.enqueue({ clientOpId: 'b', name: 'position.set', args: { videoId: 'v-ok', position: 2, finished: false } }),
      q.enqueue({ clientOpId: 'c', name: 'chat.stop', args: { turnId: 'turn-x' } }),
    ]);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].reason, 'internal');
    assert.equal(results[1].ok, true);
    assert.equal((await db.videos.get('v-ok')).lastPosition, 2, '后面的 op 真的落库了');
    assert.deepEqual(acks, [['a', false, 'internal'], ['b', true, null], ['c', true, null]]);
    assert.equal(q.busy, false);
  } finally {
    delete db.videos.update;
  }
});

await test('未知 op 名回 unknown-op，不许把整条链带走', async () => {
  const q = new OpQueue();
  assert.deepEqual(await q.enqueue({ clientOpId: 'x', name: 'video.nuke', args: {} }), { ok: false, reason: 'unknown-op' });
  await seedVideo('v-after');
  assert.equal((await q.enqueue({ clientOpId: 'y', name: 'position.set', args: { videoId: 'v-after', position: 3 } })).ok, true);
});

// study.add 走队列时用的是注入的去重表（默认自带一张 LRU）
await test('study.add 经队列：连发同一 clientOpId 三条，库里只累加一次', async () => {
  const dedup = createLruDedup();
  const q = new OpQueue({ dedup });
  const op = { clientOpId: 'q-op-1', name: 'study.add', args: { date: '2026-10-20', seconds: 25 } };
  await Promise.all([q.enqueue(op), q.enqueue(op), q.enqueue(op)]);
  assert.equal((await db.studyDays.get('2026-10-20')).seconds, 25);
});

await db.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
