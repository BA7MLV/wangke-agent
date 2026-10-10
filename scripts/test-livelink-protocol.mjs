#!/usr/bin/env node
/**
 * 实时链路协议（protocol.ts）的单元测试：文本帧编解码、二进制帧编解码、单元分片。
 * Node ≥22.18 原生类型剥离子句直接跑 .ts，无需构建。
 * 运行：node scripts/test-livelink-protocol.mjs
 *
 * 关注点不是「能不能编」，而是**链路健壮性**：远端数据不完全可信，
 * 坏帧必须被安静地跳过（返回 null）而不是杀死整条链路（gzip 载荷解压除外，
 * 那是 fflate 的契约，见下面的「坏 gzip 抛异常」——调用方自己 try/catch）。
 *
 * 作用域声明：这里只管**编解码与分片**的契约（线格式逐字节、坏帧策略、分片边界），
 * socket 行为（binaryType / 重连 / 心跳）与拉流窗口规划是上层的事，归 Task 6 的测试。
 */
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  BINARY_HEADER_BYTES,
  encodeFrame,
  decodeFrame,
  encodeBinaryFrame,
  decodeBinaryFrame,
  chunkUnit,
  joinUnit,
  encodeUnitPayload,
  decodeUnitPayload,
} from '../src/livelink/protocol.ts';
import { PART_BYTES } from '../src/sync/units.ts';

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

// ---------- 汇总 ----------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
