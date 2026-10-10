/**
 * 实时链路的协议帧编解码：文本信封、二进制帧头、单元分片、载荷 gzip。
 * host / guest / Cloudflare Worker 三方共用，任何一端单方面改格式都会让对面静默解码失败。
 *
 * ## 为什么二进制帧自带 12 字节头（rid + seq），而不是「先发文本头再发裸字节」
 *
 * range 拉流允许多个请求在途，WebSocket 又**不保证消息顺序**（relay 转发、网络抖动都会
 * 重排）。「文本头 + 裸字节」这种约定在乱序到达时会张冠李戴：把 A 请求的视频字节拼到
 * B 请求的头上，表现为画面花屏但没有任何报错。把 rid / seq 和载荷绑进同一条二进制消息
 * 后，乱序只是晚到，不会错配。rid 关联请求，seq 对视频是字节偏移、对单元是分片序号。
 *
 * ## 为什么坏帧一律返回 null，不抛异常
 *
 * 远端数据不完全可信：版本升级后的旧客户端、relay 的异常输出、截断的消息，都会产生
 * 畸形帧。一条畸形帧不该杀死整条链路（拖垮一次课），所以**除 gzip 载荷解压外**，
 * 编解码层的坏帧一律返回 null。唯一例外是 decodeUnitPayload：坏 gzip 会抛异常
 * （fflate 的契约 —— 它不区分「空载荷」和「乱码」），调用方必须 try/catch。
 */

import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';
import { PART_BYTES } from '../sync/units.ts';

/** 协议版本。不匹配的帧直接拒收，免得旧客户端把新字段当成新类型旧处理。 */
export const PROTOCOL_VERSION = 1;

/** 二进制帧头长度：rid(u32 LE) + seq(f64 LE)。 */
export const BINARY_HEADER_BYTES = 12;

/** 文本帧信封：v/t/id 是必需的路由三件套，其余字段（code / sdp / candidate…）各消息类型自定。 */
export interface Frame {
  v: number;
  t: string;
  id: string;
  [k: string]: unknown;
}

/** 二进制帧解出的三元组：rid 关联请求，seq 对视频是字节偏移、对单元是分片序号。 */
export interface BinaryFrame {
  rid: number;
  seq: number;
  payload: Uint8Array;
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

/**
 * 解析文本帧；坏帧返回 null（调用方跳过），绝不在正常链路上抛异常。
 *
 * 三道校验都是「宁可拒收也不猜」：非对象/数组、版本不符、t/id 缺失都会让
 * 下游路由键变成 undefined，静默丢消息比显式丢帧难查得多。
 * 空串 t/id 显式接受（不额外拒绝）：路由键是空串而非 undefined，
 * 「显式的空」与「缺失」在路由表里是两回事，后者才是要拒的坏帧。
 */
export function decodeFrame(text: string): Frame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const f = parsed as Record<string, unknown>;
  if (f.v !== PROTOCOL_VERSION) return null;
  if (typeof f.t !== 'string' || typeof f.id !== 'string') return null;
  return f as Frame;
}

/**
 * 打包一条二进制帧：12 字节头 + 载荷。
 *
 * seq 用 f64 而不是 u32：视频字节偏移轻松超过 4GB（长课 + 重看拖动进度条），
 * u32 会绕回后写到错误位置；f64 的 53 位尾数足够精确到字节。
 *
 * rid 必须是 0..2³²-1 的整数：越界/非整数会被 setUint32 静默回绕（2**32→0、
 * NaN→0），表现是「某帧被记到另一个请求头上」而不是报错。host 侧从远端消息里
 * 取 rid 时先 `Number(x) >>> 0` 消毒再进这里。
 */
export function encodeBinaryFrame(rid: number, seq: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(BINARY_HEADER_BYTES + payload.byteLength);
  const dv = new DataView(buf);
  dv.setUint32(0, rid, true);
  dv.setFloat64(4, seq, true);
  new Uint8Array(buf, BINARY_HEADER_BYTES).set(payload);
  return buf;
}

/**
 * 解二进制帧；不足 12 字节（连头都不完整）返回 null。
 *
 * **硬约束：调用方必须把 WebSocket 的 binaryType 显式设为 'arraybuffer'**。
 * 默认的 'blob' 会让每条消息以 Blob 形式到达，这里对非 ArrayBuffer 一律返回
 * null —— 链路像死了一样（每帧都被安静丢弃）但没有任何报错，极难排查。
 *
 * payload 是底层缓冲的视图（不拷贝）：之后写这块源缓冲会改掉已解出的 payload，
 * 需要长期持有就先 slice 复制（同 chunkUnit 的视图语义）。
 */
export function decodeBinaryFrame(buf: ArrayBuffer): BinaryFrame | null {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < BINARY_HEADER_BYTES) return null;
  const dv = new DataView(buf);
  return {
    rid: dv.getUint32(0, true),
    seq: dv.getFloat64(4, true),
    payload: new Uint8Array(buf, BINARY_HEADER_BYTES),
  };
}

/**
 * 按 PART_BYTES 切载荷。
 *
 * 分片大小直接复用云同步的 PART_BYTES：256KB 这个值来自 D1 约束（单行 2MB、
 * 单条 SQL 100KB），直播链路不另起一套 —— 两套分片大小必然漂移，且改一侧
 * 会静默改另一侧，共用一个常量是能一起 Review 的前提。
 *
 * **空载荷返回 1 个空片而不是 0 片**：与 units.ts 的 partCount 约定一致 ——
 * 「存在且为空」与「不存在」在语义上完全不同（后者会触发墓碑合并）。
 *
 * subarray 返回的是视图不拷贝字节，调用方立刻发送的场景下零拷贝正是想要的；
 * 但若之后还要写这块底层缓冲，记得先复制。
 */
export function chunkUnit(payload: Uint8Array): Uint8Array[] {
  if (payload.length === 0) return [payload.subarray(0, 0)];
  const parts: Uint8Array[] = [];
  for (let off = 0; off < payload.length; off += PART_BYTES) {
    parts.push(payload.subarray(off, Math.min(off + PART_BYTES, payload.length)));
  }
  return parts;
}

/**
 * 拼接分片，**纯拼接**：调用方已按序号排好序，这里不做任何排序。
 *
 * 乱序检测与重排是上层（range 拉取 / 单元重组）的职责 —— 它们持有 seq 才有意义；
 * 拆到这一层会让 joinUnit 同时管「顺序正确性」和「字节完整性」两件事。
 */
export function joinUnit(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** 单元载荷序列化：压缩后过 WebSocket / relay，别让 1 小时字幕的 JSON 直接上链路。 */
export function encodeUnitPayload(json: string): Uint8Array {
  return gzipSync(strToU8(json));
}

/**
 * 解单元载荷：本模块**唯一会抛异常**的出口 —— 坏 gzip 直接抛（fflate 的契约，
 * 它没有「坏数据返回 null」的通道）。调用方（Task 6 的 loadUnit）必须 try/catch，
 * 让 Promise reject；漏出去的后果是错误表现为 30s 超时，或异常钻进事件回调
 * 把整条 socket 打死。
 */
export function decodeUnitPayload(bytes: Uint8Array): string {
  return strFromU8(gunzipSync(bytes));
}
