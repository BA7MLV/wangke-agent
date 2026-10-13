#!/usr/bin/env node
/**
 * 实时链路协议（protocol.ts）的单元测试：文本帧编解码、二进制帧编解码、单元分片、
 * P2 的 v2 帧型与版本握手、中继控制帧（ctl 形状）、以及 uuid 收敛后的 id 生成。
 * Node ≥22.18 原生类型剥离子句直接跑 .ts，无需构建。
 * 运行：node scripts/test-livelink-protocol.mjs
 *
 * 关注点不是「能不能编」，而是**链路健壮性**：远端数据不完全可信，
 * 坏帧必须被安静地跳过（返回 null）而不是杀死整条链路（gzip 载荷解压除外，
 * 那是 fflate 的契约，见下面的「坏 gzip 抛异常」——调用方自己 try/catch）。
 *
 * 作用域声明：这里只管**编解码与分片**的契约（线格式逐字节、坏帧策略、分片边界、
 * 版本握手的两条解码路径 + 中继控制帧的第三条解码路径），socket 行为（binaryType /
 * 重连 / 心跳）与拉流窗口规划是上层的事，归 Task 6 的测试。第 9 组顺带钉住
 * utils/uuid.ts：写面 op 的 opId 与 outbox 的 clientOpId 都由它生成，它的降级路径
 * （非安全上下文）直接决定写面能不能用，与「坏帧不许静默」同属一类静默故障，所以放在
 * 这里而不是另开一个脚本。
 */
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_V1,
  CLOSE_PROTOCOL_MISMATCH,
  FRAME,
  BINARY_HEADER_BYTES,
  encodeFrame,
  decodeFrame,
  decodeFrameLoose,
  decodeControlFrame,
  versionCheck,
  helloFrame,
  welcomeFrame,
  versionErrFrame,
  encodeBinaryFrame,
  decodeBinaryFrame,
  chunkUnit,
  joinUnit,
  encodeUnitPayload,
  decodeUnitPayload,
} from '../src/livelink/protocol.ts';
import { PART_BYTES } from '../src/sync/units.ts';
import { uuid } from '../src/utils/uuid.ts';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL - ${name}\n    ${e.message}`);
  }
}

// ---------- 1. 文本帧往返 ----------

test('文本帧 JSON 往返', () => {
  const f = { v: PROTOCOL_VERSION, t: 'hello', id: 'a1', code: 'ROOM1' };
  assert.deepEqual(decodeFrame(encodeFrame(f)), f);
});

test('信封多带的自定义字段原样保留', () => {
  const f = { v: PROTOCOL_VERSION, t: 'offer', id: 'a1', sdp: 'BLABLA', trickle: true };
  assert.deepEqual(decodeFrame(encodeFrame(f)), f);
});

// ---------- 2. 坏帧 → null ----------

test('版本不符的帧被拒', () => {
  assert.equal(decodeFrame(JSON.stringify({ v: 99, t: 'hello', id: 'a' })), null);
});

test('坏 JSON / 数组 / 空串 → null', () => {
  assert.equal(decodeFrame('not json'), null);
  assert.equal(decodeFrame('[1,2,3]'), null);
  assert.equal(decodeFrame(''), null);
});

test('t / id 不是字符串的帧被拒', () => {
  const base = { v: PROTOCOL_VERSION };
  assert.equal(decodeFrame(JSON.stringify({ ...base, t: 1, id: 'a' })), null);
  assert.equal(decodeFrame(JSON.stringify({ ...base, id: 'a' })), null);
  assert.equal(decodeFrame(JSON.stringify({ ...base, t: 'x' })), null);
});

test('空串 t/id 显式接受（路由键是空串而非 undefined）', () => {
  // 「显式的空」与「缺失」在路由表里是两回事：后者才是需要拒的坏帧。
  const f = { v: PROTOCOL_VERSION, t: '', id: '' };
  assert.deepEqual(decodeFrame(encodeFrame(f)), f);
});

// ---------- 3. 二进制头往返 ----------

test('二进制头（rid u32 + seq f64 + payload）往返', () => {
  const buf = encodeBinaryFrame(7, 65536 * 3, new Uint8Array([1, 2, 3]));
  assert.equal(buf.byteLength, BINARY_HEADER_BYTES + 3);
  const dec = decodeBinaryFrame(buf);
  assert.equal(dec.rid, 7);
  assert.equal(dec.seq, 65536 * 3);
  assert.deepEqual([...dec.payload], [1, 2, 3]);
});

test('线格式逐字节钉住：rid u32 LE + seq f64 LE + payload', () => {
  // 往返测试对字节序不敏感（两端同时改 BE 照样绿），对面单独改了就张冠李戴。
  assert.deepEqual([...new Uint8Array(encodeBinaryFrame(0x01020304, 1, new Uint8Array([0xaa, 0xbb])))], [
    0x04, 0x03, 0x02, 0x01,                          // rid 小端
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f,  // seq = 1.0，小端 f64
    0xaa, 0xbb,
  ]);
});

test('seq 支持大偏移（f64 保证 >2^32 的视频字节偏移不丢精度）', () => {
  const big = 5 * 1024 * 1024 * 1024 + 12345; // >2^32
  const dec = decodeBinaryFrame(encodeBinaryFrame(0, big, new Uint8Array(0)));
  assert.equal(dec.seq, big);
});

// ---------- 4. 截断的二进制帧 ----------

test('不足 12 字节头的二进制帧 → null', () => {
  const buf = encodeBinaryFrame(7, 1, new Uint8Array([9, 9, 9]));
  assert.equal(decodeBinaryFrame(buf.slice(0, 11)), null);
  assert.equal(decodeBinaryFrame(new ArrayBuffer(0)), null);
});

test('非 ArrayBuffer（如默认 binaryType 的 Blob）→ null', () => {
  // WebSocket binaryType 默认 'blob'：不设成 'arraybuffer' 的话每帧都走到这里，
  // 链路像死了一样但没有任何报错 —— 这条测试就是签这门硬约束的字。
  assert.equal(decodeBinaryFrame(new Blob([new Uint8Array(16)])), null);
});

// ---------- 5. 空载荷也算 1 片 ----------

test('空载荷切出 1 个空片', () => {
  const parts = chunkUnit(new Uint8Array(0));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].length, 0);
});

test('拼接 1 个空片仍是空', () => {
  assert.deepEqual([...joinUnit(chunkUnit(new Uint8Array(0)))], []);
});

// ---------- 6. 分片阈值与拼接 ----------

test('>PART_BYTES 才切，切完拼回原样', () => {
  const big = new Uint8Array(PART_BYTES * 2 + 5).map((_, i) => i % 251);
  const parts = chunkUnit(big);
  assert.equal(parts.length, 3);
  assert.equal(parts[0].length, PART_BYTES);
  assert.equal(parts[1].length, PART_BYTES);
  assert.equal(parts[2].length, 5);
  assert.deepEqual([...joinUnit(parts)], [...big]);
});

test('恰好 PART_BYTES 不切，整片返回', () => {
  const exact = new Uint8Array(PART_BYTES).map((_, i) => i % 7);
  const parts = chunkUnit(exact);
  assert.equal(parts.length, 1);
  assert.deepEqual([...joinUnit(parts)], [...exact]);
});

test('PART_BYTES + 1 → 2 片（阈值边界）', () => {
  const src = new Uint8Array(PART_BYTES + 1).map((_, i) => i % 13);
  const parts = chunkUnit(src);
  assert.equal(parts.length, 2);
  assert.equal(parts[1].length, 1);
  assert.deepEqual([...joinUnit(parts)], [...src]);
});

test('joinUnit 不排序：按传入顺序原样拼接', () => {
  // 若将来有人给 joinUnit 加排序，这里会挂 —— 顺序正确性是上层（range 拉取 /
  // 单元重组按 seq 排队）的职责，拆到拼接层就管了两件事。
  const a = new Uint8Array([1, 2]);
  const b = new Uint8Array([3, 4, 5]);
  assert.deepEqual([...joinUnit([b, a])], [3, 4, 5, 1, 2]);
});

// ---------- 7. 载荷 gzip 编解码 ----------

test('单元载荷 gzip 往返', () => {
  const json = JSON.stringify({ hello: '实时链路', n: 123 });
  const bytes = encodeUnitPayload(json);
  assert.ok(bytes.length > 0);
  // gzip 魔数，确认真的压缩过而不是原样返回
  assert.equal(bytes[0], 0x1f);
  assert.equal(bytes[1], 0x8b);
  assert.equal(decodeUnitPayload(bytes), json);
});

test('坏 gzip 抛异常（不装进「坏帧返回 null」的承诺里）', () => {
  // 本模块唯一的抛异常出口：fflate 的契约。调用方（Task 6 的 loadUnit）必须
  // try/catch 让 Promise reject —— 漏出去的后果是错误表现为 30s 超时，
  // 或者异常钻进事件回调把整条 socket 打死。
  assert.throws(() => decodeUnitPayload(new Uint8Array([1, 2, 3, 4, 5])));
});

// ---------- 8. P2 的 v2 帧型与版本握手 ----------

test('协议版本已 bump 到 2（P1 是 1）', () => {
  // 不 bump 就等于「没做 P2」：老 guest 与新 host 会在同一个版本号下互相把对方的
  // 新帧当坏帧丢掉，症状是「点了没反应」（设计不变量 6）。
  assert.equal(PROTOCOL_VERSION_V1, 1);
  assert.equal(PROTOCOL_VERSION, 2);
});

test('P1 的帧格式逐字节不变（黄金向量：encodeFrame 不加信封、不改字段名）', () => {
  // 回归护栏：encodeFrame 一旦开始「顺手」补字段、排序、改名，这组字节就会变。
  // 这里的向量是 P1 线上真实形状（v 写死 1，不跟着 PROTOCOL_VERSION 走）。
  // 末位那条 host-link-down 是**P1 时的中继形状**（带 v），今天线上已是 ctl 形状
  // （第 10 组）：它留在黄金向量里是因为宽松解码必须仍能读懂它（万一链路上真的还有
  // 一份旧中继的输出在飞），不是断言它今天还在线上发。
  const golden = [
    '{"v":1,"t":"hello","id":"guest-0a1b2c3d4e5f6071"}',
    '{"v":1,"t":"welcome","id":"guest-0a1b2c3d4e5f6071"}',
    '{"v":1,"t":"bye","id":"guest-0a1b2c3d4e5f6071"}',
    '{"v":1,"t":"index.req","id":"g1-1a2b3c4d5e6f7081"}',
    '{"v":1,"t":"index.res","id":"g1-1a2b3c4d5e6f7081","courses":[]}',
    '{"v":1,"t":"unit.req","id":"g2-1a2b3c4d5e6f7081","unit":"video:abc:meta"}',
    '{"v":1,"t":"unit.res","id":"g2-1a2b3c4d5e6f7081","rid":2147483648,"parts":1,"len":27}',
    '{"v":1,"t":"unit.err","id":"g2-1a2b3c4d5e6f7081","reason":"not-found"}',
    '{"v":1,"t":"video.open","id":"g3-1a2b3c4d5e6f7081","videoId":"abc"}',
    '{"v":1,"t":"video.meta","id":"g3-1a2b3c4d5e6f7081","ok":true,"size":123,"mime":"video/mp4"}',
    '{"v":1,"t":"video.range","id":"42","videoId":"abc","start":1048576,"len":1048576}',
    '{"v":1,"t":"host-link-down","id":"relay"}',
  ];
  for (const line of golden) {
    assert.equal(encodeFrame(JSON.parse(line)), line);
    // 宽松解码能读回 P1 帧（握手的唯一入口，见下面那两条）
    const loose = decodeFrameLoose(line);
    assert.ok(loose, `宽松解码读不了 P1 帧：${line}`);
    assert.equal(loose.version, 1);
    assert.deepEqual(loose.frame, JSON.parse(line));
  }
});

test('P1 的二进制帧头仍是 12 字节黄金字节（bump 版本不许顺手动线格式）', () => {
  assert.equal(BINARY_HEADER_BYTES, 12);
  assert.deepEqual([...new Uint8Array(encodeBinaryFrame(0x01020304, 1, new Uint8Array([0xaa, 0xbb])))], [
    0x04, 0x03, 0x02, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f,
    0xaa, 0xbb,
  ]);
});

test('帧类型常量表覆盖 P1 读面与 P2 写面（host/guest 路由键的唯一对照表）', () => {
  assert.deepEqual(FRAME, {
    // P1 读面
    hello: 'hello',
    welcome: 'welcome',
    bye: 'bye',
    indexReq: 'index.req',
    indexRes: 'index.res',
    unitReq: 'unit.req',
    unitRes: 'unit.res',
    unitErr: 'unit.err',
    videoOpen: 'video.open',
    videoMeta: 'video.meta',
    videoRange: 'video.range',
    hostLinkDown: 'host-link-down',
    hostLinkUp: 'host-link-up',
    // P2 写面
    op: 'op',
    ack: 'ack',
    // P2 问答
    chatReq: 'chat.req',
    chatEv: 'chat.ev',
    chatCard: 'chat.card',
    chatDone: 'chat.done',
    chatErr: 'chat.err',
    // P2 版本握手
    versionErr: 'version.err',
  });
});

test('v2 新增帧 encode/decode 逐字节往返', () => {
  const frames = [
    { v: PROTOCOL_VERSION, t: 'op', id: 'o-1', opId: 'o-1', op: 'study.add', args: { date: '2026-10-13', seconds: 12.5 } },
    { v: PROTOCOL_VERSION, t: 'ack', id: 'g9-x', opId: 'o-1', ok: 1, rowId: '2026-10-13' },
    { v: PROTOCOL_VERSION, t: 'ack', id: 'g9-x', opId: 'o-2', ok: 0, reason: 'gone' },
    { v: PROTOCOL_VERSION, t: 'chat.req', id: 't1', to: '*', turnId: 'turn-1', videoId: 'abc', text: '这段讲了什么？', images: ['data:image/png;base64,AAA'] },
    { v: PROTOCOL_VERSION, t: 'chat.ev', id: 't1', to: 'guest-1', turnId: 'turn-1', kind: 'delta', text: '先看' },
    { v: PROTOCOL_VERSION, t: 'chat.ev', id: 't1', to: 'guest-1', turnId: 'turn-1', kind: 'round', round: 2 },
    { v: PROTOCOL_VERSION, t: 'chat.card', id: 't1', to: '*', turnId: 'turn-1', kind: 'quiz', payload: { question: 'A?', options: ['a', 'b'] } },
    { v: PROTOCOL_VERSION, t: 'chat.card', id: 't1', to: '*', turnId: 'turn-1', kind: 'widget', payload: { kind: 'table', rows: [] } },
    { v: PROTOCOL_VERSION, t: 'chat.done', id: 't1', to: '*', turnId: 'turn-1', content: '答案', reasoning: '先检索', reasoningMs: 1234, quiz: { question: 'A?' }, widget: null },
    { v: PROTOCOL_VERSION, t: 'chat.err', id: 't1', to: '*', turnId: 'turn-1', message: '模型超时' },
  ];
  for (const f of frames) assert.deepEqual(decodeFrame(encodeFrame(f)), f);
});

test('hello 带 clientVersion、welcome 带 hostVersion 往返', () => {
  const hello = helloFrame('guest-0a1b2c3d4e5f6071');
  assert.equal(hello.clientVersion, PROTOCOL_VERSION);
  assert.deepEqual(decodeFrame(encodeFrame(hello)), hello);
  const welcome = welcomeFrame(hello.id);
  assert.equal(welcome.hostVersion, PROTOCOL_VERSION);
  assert.deepEqual(decodeFrame(encodeFrame(welcome)), welcome);
});

test('version.err 往返（host/you 两个数字都在，来宾据此显示明说）', () => {
  const f = versionErrFrame('guest-0a1b2c3d4e5f6071', 1);
  assert.equal(f.host, PROTOCOL_VERSION);
  assert.equal(f.you, 1);
  assert.deepEqual(decodeFrame(encodeFrame(f)), f);
});

test('decodeFrame 对 v1 帧返回 null（严格语义：非握手帧一律拒收别的版本）', () => {
  // 这条是 P2 最重要的一条护栏的反面：bump 之后 v1 的 index.req / unit.res 必须
  // 被安静丢掉（不报错、不半解析），而不是「尽力而为」地塞进路由表。
  const v1 = '{"v":1,"t":"index.res","id":"g1-1a2b3c4d5e6f7081","courses":[]}';
  assert.equal(decodeFrame(v1), null);
  assert.equal(decodeFrame('{"v":3,"t":"hello","id":"a"}'), null);
});

test('decodeFrameLoose 对 v1 帧正常解析并返回 version=1（握手容忍老版本）', () => {
  // 握手如果走严格解码，老 guest 的 hello 会被静默丢弃 —— 界面永远停在「连接中」，
  // 正是设计不变量 6 明令禁止的失败形态。宽松解码就是为了让它「被认出，然后明说」。
  const loose = decodeFrameLoose('{"v":1,"t":"hello","id":"guest-1"}');
  assert.ok(loose);
  assert.equal(loose.version, 1);
  assert.equal(loose.frame.t, 'hello');
  assert.equal(loose.frame.id, 'guest-1');
  // 对面是当前版本时同样通得过（host/guest 用同一个入口，不必分叉两条路）
  assert.equal(decodeFrameLoose(encodeFrame(helloFrame('guest-1')))?.version, PROTOCOL_VERSION);
});

test('decodeFrameLoose 只放宽版本，坏 JSON / 数组 / 空串 / t·id 非字符串仍 → null', () => {
  assert.equal(decodeFrameLoose('not json'), null);
  assert.equal(decodeFrameLoose(''), null);
  assert.equal(decodeFrameLoose('[1,2,3]'), null);
  assert.equal(decodeFrameLoose('null'), null);
  assert.equal(decodeFrameLoose('123'), null);
  assert.equal(decodeFrameLoose(JSON.stringify({ v: 1, t: 1, id: 'a' })), null);
  assert.equal(decodeFrameLoose(JSON.stringify({ v: 1, id: 'a' })), null);
  assert.equal(decodeFrameLoose(JSON.stringify({ v: 1, t: 'hello' })), null);
  assert.equal(decodeFrameLoose(JSON.stringify({ t: 'hello', id: 'a' })), null);
  // 版本必须是整数：'2'、2.5、null 都不该被当成「v2 的帧」放行
  assert.equal(decodeFrameLoose(JSON.stringify({ v: '2', t: 'hello', id: 'a' })), null);
  assert.equal(decodeFrameLoose(JSON.stringify({ v: 2.5, t: 'hello', id: 'a' })), null);
  assert.equal(decodeFrameLoose(JSON.stringify({ v: null, t: 'hello', id: 'a' })), null);
});

test('versionCheck 两侧共用同一判据（不匹配时带上 host/you 两个数字）', () => {
  assert.deepEqual(versionCheck(PROTOCOL_VERSION), { ok: true });
  assert.deepEqual(versionCheck(1), { ok: false, host: PROTOCOL_VERSION, you: 1 });
  assert.deepEqual(versionCheck(99), { ok: false, host: PROTOCOL_VERSION, you: 99 });
});

// ---------- 9. uuid 收敛（utils/uuid.ts）----------

test('uuid() 是合法的 v4 形状（降级实现也得守 RFC 4122 的位模式）', () => {
  const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (let i = 0; i < 200; i++) assert.match(uuid(), RE);
});

test('没有 crypto.randomUUID 时降级仍然可用（局域网 http 的 iPad 就是这个环境）', () => {
  // 降级路径平时在 localhost 开发里永远走不到，于是「忘了判 typeof」能一直绿，
  // 到 iPad 上表现为同步抛异常：选完文件毫无反应、写面 op 一条都发不出去。
  const real = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
  try {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    assert.equal(typeof globalThis.crypto.randomUUID, 'undefined');
    assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    if (real) Object.defineProperty(globalThis.crypto, 'randomUUID', real);
    else delete globalThis.crypto.randomUUID; // randomUUID 在 Node 里挂在原型上，删掉自己这层影子即可
  }
  // 还原必须是干净的：残留的 undefined 会让**后面所有测试**都跑在降级路径上，
  // 于是原生那条分支再出问题也看不出来（浏览器里两者都在同一次调用里切换，更容易漏）
  assert.equal(typeof crypto.randomUUID, 'function');
  assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('uuid() 连着 2000 次不撞（它是 opId / 视频 id 的来源，撞了就是静默合并两条记录）', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(uuid());
  assert.equal(seen.size, 2000);
});

// ---------- 10. 中继控制帧（ctl 形状，与 app 协议版本解耦）----------

// 与 live-relay/src/index.ts 的 HOST_LINK_DOWN / HOST_LINK_UP 两个常量逐字节相同。
// 那是另一个部署物、import 不到这里的常量，所以把它的**字面量**钉死在这：改了一侧
// 忘了另一侧，两条测试各红一半且指向同一个形状差。
const RELAY_HOST_LINK_DOWN = '{"ctl":1,"t":"host-link-down","id":"relay"}';
const RELAY_HOST_LINK_UP = '{"ctl":1,"t":"host-link-up","id":"relay"}';

test('decodeControlFrame 解出中继的两个控制帧（只认 t，不带 v）', () => {
  assert.deepEqual(decodeControlFrame(RELAY_HOST_LINK_DOWN), { t: 'host-link-down' });
  assert.deepEqual(decodeControlFrame(RELAY_HOST_LINK_UP), { t: 'host-link-up' });
  // 多余字段照单全收地忽略：中继将来加字段不该让旧 app 的解码器把这帧变坏帧
  assert.deepEqual(decodeControlFrame('{"ctl":1,"t":"host-link-up","id":"relay","why":"grace"}'), {
    t: 'host-link-up',
  });
});

test('控制帧**不因缺少 v 被拒**（解耦的核心断言：与 PROTOCOL_VERSION 无关）', () => {
  // 这是本次改造的全部意义：中继发来的帧不带 v，而 decodeFrame 的判据是
  // `f.v !== PROTOCOL_VERSION` —— 没有 v 就是过不去。
  assert.ok(decodeControlFrame(RELAY_HOST_LINK_DOWN));
  // 顺带把「带一个 v 也不认」钉住：判据是形状，不是版本。多一个 v 字段不该改变结果，
  // 否则就等于把版本偷偷接了回来。
  assert.deepEqual(decodeControlFrame('{"ctl":1,"t":"host-link-down","id":"relay","v":99}'), {
    t: 'host-link-down',
  });
  assert.deepEqual(decodeControlFrame('{"ctl":1,"t":"host-link-up","id":"relay","v":1}'), {
    t: 'host-link-up',
  });
});

test('控制帧两条 app 协议解码路径都收不了（所以判定顺序不能反）', () => {
  // 反面断言：把这条钉住，将来谁把 decodeControlFrame 挪到 decodeFrame 之后，
  // 或者图省事改用 decodeFrame 收控制帧，这里立刻红。
  assert.equal(decodeFrame(RELAY_HOST_LINK_DOWN), null); // 缺 v = 版本不符
  assert.equal(decodeFrameLoose(RELAY_HOST_LINK_DOWN), null); // 宽松路径要求 v 是整数
});

test('decodeControlFrame 对 app 帧一律 null（不误判：ctl 才是入口标记）', () => {
  const appFrames = [
    encodeFrame(helloFrame('guest-1')),
    encodeFrame(welcomeFrame('guest-1')),
    encodeFrame({ v: PROTOCOL_VERSION, t: 'bye', id: 'guest-1' }),
    encodeFrame({ v: PROTOCOL_VERSION, t: 'ack', id: 'g9-x', opId: 'o-1', ok: 1 }),
    encodeFrame({ v: PROTOCOL_VERSION, t: 'chat.ev', id: 't1', to: '*', turnId: 'turn-1', kind: 'stop' }),
    encodeFrame(versionErrFrame('guest-1', 1)),
    // 带 ctl 但 t 是 app 帧型：ctl 只标形状，不代表「这帧随便什么 t 都收」
    JSON.stringify({ ctl: 1, t: 'hello', id: 'relay' }),
  ];
  for (const line of appFrames) {
    assert.equal(decodeControlFrame(line), null, `不该当控制帧收：${line}`);
  }
});

test('decodeControlFrame：ctl 非 1 / 未知 t / 坏 JSON / 数组 / 空串 → null', () => {
  assert.equal(decodeControlFrame('not json'), null);
  assert.equal(decodeControlFrame(''), null);
  assert.equal(decodeControlFrame('[1,2,3]'), null);
  assert.equal(decodeControlFrame('null'), null);
  assert.equal(decodeControlFrame('123'), null);
  assert.equal(decodeControlFrame('"host-link-down"'), null);
  // ctl 必须是数字 1：'1' / 2 / 1.5 / 缺失 全是别的形状
  assert.equal(decodeControlFrame(JSON.stringify({ ctl: '1', t: 'host-link-down', id: 'relay' })), null);
  assert.equal(decodeControlFrame(JSON.stringify({ ctl: 2, t: 'host-link-down', id: 'relay' })), null);
  assert.equal(decodeControlFrame(JSON.stringify({ ctl: 1.5, t: 'host-link-down', id: 'relay' })), null);
  assert.equal(decodeControlFrame(JSON.stringify({ ctl: true, t: 'host-link-down', id: 'relay' })), null);
  assert.equal(decodeControlFrame(JSON.stringify({ t: 'host-link-down', id: 'relay' })), null);
  // t 必须是那两个之一：空串、近似名、控制帧里塞业务名都拒
  assert.equal(decodeControlFrame(JSON.stringify({ ctl: 1, t: '', id: 'relay' })), null);
  assert.equal(decodeControlFrame(JSON.stringify({ ctl: 1, t: 'host-link-sideways', id: 'relay' })), null);
  assert.equal(decodeControlFrame(JSON.stringify({ ctl: 1, t: 1, id: 'relay' })), null);
  assert.equal(decodeControlFrame(JSON.stringify({ ctl: 1, id: 'relay' })), null);
  // id 故意不校验：返回的形状里没有 id，中继换不换 id 命名空间都不影响来宾的路由。
  assert.deepEqual(decodeControlFrame(JSON.stringify({ ctl: 1, t: 'host-link-up' })), {
    t: 'host-link-up',
  });
});

test('老中继（带 v 的 host-link-*)解不出来 —— 认形状不认版本的已知代价', () => {
  // app 已更新、中继还没重新部署的过渡窗口：来宾会收不到「主机已离线」，
  // 退化成 LiveGuest 页 3s 轮询那条兜底路径，中继一发新版即恢复。写成断言而不是
  // 悄悄兼容：兼容两种形状就得猜「带 v 的那条是哪一版的协议」，而那正是要拆掉的东西。
  for (const old of ['{"v":1,"t":"host-link-down","id":"relay"}', '{"v":2,"t":"host-link-up","id":"relay"}']) {
    assert.equal(decodeControlFrame(old), null, `不该兼容老中继形状：${old}`);
  }
});

test('版本不匹配走 4400，且不与中继那三个致命码撞号', () => {
  // 撞号的后果是文案说谎：4000/4001/4403 都带具体事实（房间回收 / 配对码不存在 /
  // 配对限流），拿来关一个版本不匹配的连接会让用户去修一个没坏的环节。
  assert.equal(CLOSE_PROTOCOL_MISMATCH, 4400);
  for (const relayCode of [4000, 4001, 4403]) {
    assert.notEqual(CLOSE_PROTOCOL_MISMATCH, relayCode);
  }
});

// ---------- 汇总 ----------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
