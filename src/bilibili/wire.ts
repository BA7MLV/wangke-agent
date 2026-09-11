/**
 * 极简 protobuf 读写：只实现 varint 与 length-delimited 两种 wire type。
 *
 * 用途：B 站 App 的字幕接口是 gRPC（protobuf），而 DmView 的请求只有 4 个标量字段、
 * 响应里我们只要「一个重复消息 + 几个字符串」，为此引一整套 protobuf runtime 不划算。
 * 手写几十行足够，而且能在 Node 里做往返单测。
 *
 * 注意：varint 用 BigInt 累加，避免超过 2^53 的 64 位值（如 B 站字幕 id）算错；
 * 超过安全整数的值原样返回 number（精度丢失，但我们不用它 —— 用响应里的 id_str）。
 */

export type WireType = 0 | 1 | 2 | 5;

export interface ProtoField {
  /** 字段号 */
  field: number;
  wire: WireType;
  /** Varint → number；Bytes → 原始字节 */
  value: number | Uint8Array;
}

/** 编码一个 varint（支持到 64 位） */
export function encodeVarint(value: number): number[] {
  let v = BigInt(Math.trunc(value));
  if (v < 0n) throw new RangeError('varint 不支持负数');
  const out: number[] = [];
  do {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v > 0n ? byte | 0x80 : byte);
  } while (v > 0n);
  return out;
}

/** `field: varint` 字段 */
export function fieldVarint(field: number, value: number): number[] {
  return [...encodeVarint((field << 3) | 0), ...encodeVarint(value)];
}

/** `field: bytes/string` 字段 */
export function fieldBytes(field: number, value: Uint8Array): number[] {
  return [...encodeVarint((field << 3) | 2), ...encodeVarint(value.byteLength), ...value];
}

/** 把若干字段拼成一条消息 */
export function encodeMessage(parts: (number[] | Uint8Array)[]): Uint8Array {
  const flat: number[] = [];
  for (const p of parts) flat.push(...p);
  return new Uint8Array(flat);
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function readVarint(buf: Uint8Array, i: number): [number, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (i >= buf.length) throw new RangeError('protobuf 数据在 varint 中断');
    const byte = buf[i++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  const asNumber = result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : Number(result);
  return [asNumber, i];
}

/** 顺序读出所有字段；遇到不认识的 wire type（fixed32/64）会跳过对应宽度 */
export function decodeFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    const [key, afterKey] = readVarint(buf, i);
    i = afterKey;
    const field = key >>> 3;
    const wire = (key & 0x7) as WireType;
    if (wire === 0) {
      const [value, next] = readVarint(buf, i);
      i = next;
      out.push({ field, wire, value });
    } else if (wire === 2) {
      const [len, next] = readVarint(buf, i);
      i = next;
      if (i + len > buf.length) throw new RangeError('protobuf 数据在 length-delimited 字段中断');
      out.push({ field, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ field, wire, value: buf.subarray(i, i + 4) });
      i += 4;
    } else if (wire === 1) {
      out.push({ field, wire, value: buf.subarray(i, i + 8) });
      i += 8;
    } else {
      throw new RangeError(`protobuf 出现不支持的 wire type ${wire}`);
    }
  }
  return out;
}

export function getBytes(fields: ProtoField[], field: number): Uint8Array[] {
  return fields.filter((f) => f.field === field && f.wire === 2).map((f) => f.value as Uint8Array);
}

export function getBytesFirst(fields: ProtoField[], field: number): Uint8Array | undefined {
  return getBytes(fields, field)[0];
}

export function getNumber(fields: ProtoField[], field: number): number | undefined {
  const hit = fields.find((f) => f.field === field && f.wire === 0);
  return hit ? (hit.value as number) : undefined;
}

export function getString(fields: ProtoField[], field: number): string | undefined {
  const bytes = getBytesFirst(fields, field);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}
