/**
 * host 侧 IO 编排：WebSocket 客户端 + 读库/读盘 + 逐请求响应。
 *
 * 实时链路里 host 是唯一的数据源（guest 是纯内存镜像），所以这个文件的全部
 * 职责就是「guest 要什么，从本机 DB / OPFS 拿出来，按 protocol.ts 的帧格式
 * 发回去」。P1 没有写 op、没有冲突解决、没有重连状态机——复杂度全在
 * 「取数据的边界」上，四个取舍钉在文件头：
 *
 * 1. **凭据边界（不变量 1）**：本模块只读 videos / segments / subtitleTracks /
 *    covers / files，永远不碰 providers 的 apiKey 与 bilibiliCookie。不靠
 *    自觉——从头到尾没有任何 import 或查询能触到 settings 表；新增单元类型
 *    时同理，要发什么字段由 payloads.ts 的白名单决定，那里也不含凭据。
 * 2. **range 读盘并发上限 4，超限有界 FIFO 等待不丢帧**：OPFS slice 是磁盘 IO，
 *    家和云之间带宽通常先打满，真正同时在读盘的操作要有个上限（否则一次 seek
 *    之后几十个请求一起涌上来，磁盘队列反而更慢）。但**上限不是丢弃的理由** ——
 *    超过配额的请求排队等前面的读完再做。最初写的是「超限直接丢弃」，终审时被
 *    推翻：guest 一次 fill() 最多发 4 个请求（mse.ts 的 MAX_INFLIGHT=4），被丢的
 *    rid 永远不会有应答帧，而 guest 唯一的清理路径是 teardown。那个 rid 于是被
 *    planBuffered 永久算成「已覆盖」（区间在 pendingRanges 里，洞被填上）、
 *    在途水位永久少一格（窗口预算腰斩）—— 文件留一个永久的洞，播放头到那里
 *    MSE 只是卡住（waiting，没有 error、没有 UI 变化），本功能最不能容忍的
 *    静默失败形态。「下一轮重规划会补救」不成立：窗口规划只看覆盖表，被丢的
 *    区间已经在覆盖表里了，重算一百轮也不会再拉它。队列长度天然有界（guest 的
 *    MAX_INFLIGHT × 在席 guest 数），不另设上限。
 * 3. **容器白名单在 openFile 时就拒绝**：播到一半才发现播不了，比打开时明说
 *    更糟——半途而废会留下「看似在播其实黑屏」的怪状态。
 * 4. **RANGE_CHUNK = 1MB 的匹配关系**：guest 侧窗口 WINDOW_BYTES = 8MB、
 *    MAX_INFLIGHT = 4、planFetches 的 chunk 也是 1MB，即「窗口内约 8 个请求、
 *    在途字节 ≤ 4MB」。host 读盘并发与 guest 的 MAX_INFLIGHT 对齐（都是 4），
 *    即「guest 一次愿意等多少，host 就给它多少」。1MB 同时是 seek 粒度：拖进度条
 *    废掉窗口内未到的字节，浪费上限就是一个分片。
 *
 * 设计文档：docs/plans/2026-10-09-live-link.md
 */

import { db } from '../store/db';
import { getCourseFile, readCourseFileRange } from '../store/fileStore';
import {
  PROTOCOL_VERSION,
  encodeFrame,
  decodeFrame,
  encodeBinaryFrame,
  encodeUnitPayload,
  chunkUnit,
  type Frame,
} from './protocol';
import { buildIndex, buildMetaUnit, buildContentUnit, coverUnitFromBlob } from './payloads';

/**
 * range 读盘并发上限，见文件头取舍 2。
 *
 * 与 guest 的 MAX_INFLIGHT（mse.ts）= 4 对齐：guest 一次愿意等多少，host 就
 * 给它多少读盘名额。低于它没有意义（guest 多发的部分只会排队），高于它也没有
 * 意义（磁盘队列更长，吞吐不升反降）。
 */
const MAX_RANGE_INFLIGHT = 4;
/** 单帧字节数（也是再切粒度）。与 guest 的 WINDOW_BYTES=8MB / MAX_INFLIGHT=4 匹配，见取舍 4。 */
const RANGE_CHUNK = 1024 * 1024;
/**
 * 能直接过 MSE 的容器（只判容器级 mime，codecs 参数可省；真解码不了时
 * appendBuffer 会报错，由 guest 页面 error 态接住）。
 */
const DIRECT_CONTAINERS = ['video/mp4', 'video/webm'];

/**
 * 解析 guest 要的单元 id：`video:<id>:meta|content|cover`，从右侧切。
 *
 * 用 lastIndexOf 而不是 endsWith + slice(-len)：id 里万一有冒号（uuid 不会，
 * 但单元 id 来自远端帧，不完全可信）时，从右侧切保证冒号全归 id 一侧，后缀
 * 永远不会认错——认错后缀的后果是静默回一份错数据的载荷，比报错难查得多。
 * 与 sync/units.ts 的 parseUnit 同一切法：两套切法必然漂移。
 */
function parseVideoUnit(unit: string): { id: string; suffix: string } | null {
  if (!unit.startsWith('video:')) return null;
  const last = unit.lastIndexOf(':');
  if (last <= 'video:'.length - 1) return null; // 缺第二个冒号
  const id = unit.slice('video:'.length, last);
  if (id.length === 0) return null; // 'video::meta' 这类空 id 当坏单元
  return { id, suffix: unit.slice(last + 1) };
}

export interface HostEvents {
  onGuests(guests: { id: string }[]): void;
  onStatus(s: 'connecting' | 'online' | 'off'): void;
  onError(msg: string): void;
}

export class LiveHost {
  private ws: WebSocket | null = null;
  /**
   * 在席 guest：键就是 hello 帧的 id。同 id 重连会覆盖旧条目（计数不变），
   * 所以 Task 6 必须保证每台 guest 的 hello id 唯一。
   */
  private guests = new Map<string, { id: string }>();
  /** 已发放且未归还的读盘名额数（含排队等名额的请求），见 waitRangeSlot。 */
  private rangeSlots = 0;
  /** 等名额的 FIFO 队列：resolve = 轮到你了。见文件头取舍 2。 */
  private rangeQueue: (() => void)[] = [];
  private stopped = false;
  /** 单元 rid 游标，初值与理由见 rid()。 */
  private ridSeq = 0x80000000;

  constructor(
    private opts: { relayUrl: string; code: string; events: HostEvents },
  ) {}

  start(): void {
    this.stopped = false;
    this.opts.events.onStatus('connecting');
    const url = `${this.opts.relayUrl}?room=${encodeURIComponent(this.opts.code)}&role=host`;
    const ws = new WebSocket(url);
    this.ws = ws;
    // 必须显式设：默认的 'blob' 会让二进制帧以 Blob 到达，protocol.ts 的
    // decodeBinaryFrame 对非 ArrayBuffer 一律返 null——链路像死了一样但
    // 没有任何报错。P1 host 不收二进制，这行是 defense in depth（Task 6
    // 的 guest 侧同理，且它是真要收二进制的那一端）。
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.opts.events.onStatus('online');
    ws.onclose = () => {
      this.ws = null;
      this.guests.clear();
      this.opts.events.onGuests([]);
      // 只有被动断（中继挂了 / 网络抖了）才广播 off；stop() 里已经置过 off，
      // 这里再置一次会让 Task 5 的 store 无谓重渲染。
      if (!this.stopped) this.opts.events.onStatus('off');
    };
    ws.onerror = () => this.opts.events.onError('中继连接失败，检查中继地址');
    ws.onmessage = (e) => {
      // handle 是 async：读库 / 读盘都可能抛。不接这一下，一次坏请求会以
      // unhandledrejection 的面目出现——链路明明是好的，排查时最容易被带偏。
      // 只 console.warn 不升到 onError：单条消息失败不是链路事件（guest 有
      // 自己的超时），升上去会把一次健康的共享打成 error 态。
      void this.handle(e.data).catch((err) => {
        console.warn('[live-host] 消息处理失败：', err);
      });
    };
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    this.guests.clear();
    this.opts.events.onGuests([]);
    this.opts.events.onStatus('off');
  }

  private send(frame: Frame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(frame));
  }

  /**
   * 二进制帧直发。与 send 分开就为这个 readyState 守卫：单元 / range 的
   * 响应都跨 await（读库、读盘；range 还可能先在 waitRangeSlot 排一会儿队），
   * socket 完全可能在等待期间被关掉，而 WebSocket.send 在非 OPEN 状态会抛
   * InvalidStateError。
   */
  private sendBinary(rid: number, seq: number, payload: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeBinaryFrame(rid, seq, payload));
  }

  /**
   * 单元响应 rid：从高半区 0x80000000 起自增。
   *
   * 两个不用 Math.random 的理由：① host 自己的 rid 空间里也会生日碰撞——
   * 两个在途单元拿到同一 rid，guest 就会把 A 的分片拼进 B；自增从根上没
   * 有这个面。② rid 会出现在 Task 8 e2e 的帧日志里，连续序号比随机数好对。
   *
   * **与 guest 的命名空间契约（Task 6 必读）**：guest 自生成 video.range 的
   * rid，与这里的单元 rid 共用 guest 侧同一张「按 rid 收二进制帧」的路由表。
   * 撞车的后果是视频字节被错配进单元分片（或反过来）——不报错、只是数据
   * 错乱。所以 host 显式占住 [0x80000000, 0xffffffff]，guest 生成 range
   * rid 时必须留在低半区 [0, 0x7fffffff]。
   */
  private rid(): number {
    const r = this.ridSeq++;
    if (this.ridSeq > 0xffffffff) this.ridSeq = 0x80000000; // 绕回（一次会话拉 40 亿个单元才会到这）
    return r;
  }

  private async handle(data: unknown): Promise<void> {
    if (typeof data === 'string') {
      const f = decodeFrame(data);
      if (!f) return; // 坏帧跳过，不杀链路（protocol.ts 的约定）
      if (f.t === 'hello') {
        const gid = f.id;
        this.guests.set(gid, { id: gid });
        this.opts.events.onGuests([...this.guests.values()]);
        this.send({ v: PROTOCOL_VERSION, t: 'welcome', id: gid });
        return;
      }
      if (f.t === 'bye') {
        this.guests.delete(f.id);
        this.opts.events.onGuests([...this.guests.values()]);
        return;
      }
      if (f.t === 'index.req') {
        const rows = await db.videos.orderBy('createdAt').toArray();
        this.send({ v: PROTOCOL_VERSION, t: 'index.res', id: f.id, courses: buildIndex(rows) });
        return;
      }
      if (f.t === 'unit.req') {
        await this.handleUnitReq(f);
        return;
      }
      if (f.t === 'video.open') {
        await this.handleVideoOpen(f);
        return;
      }
      if (f.t === 'video.range') {
        await this.handleVideoRange(f);
        return;
      }
      return; // 不认识的类型：P1 不理（relay 帧、未来的写面 op）
    }
    // 二进制帧：P1 host 没有写面 op，guest 也没有发给 host 的二进制。
    // 不解码直接忽略——解出来的 payload 没有消费者，白耗一遍 CPU。
  }

  private async handleUnitReq(f: Frame): Promise<void> {
    const reqId = f.id;
    const rid = this.rid();
    const parsed = parseVideoUnit(String(f.unit));
    if (!parsed) {
      this.send({ v: PROTOCOL_VERSION, t: 'unit.err', id: reqId, reason: 'unsupported-unit' });
      return;
    }
    if (parsed.suffix === 'meta') {
      const row = await db.videos.get(parsed.id);
      if (!row) {
        this.send({ v: PROTOCOL_VERSION, t: 'unit.err', id: reqId, reason: 'not-found' });
        return;
      }
      this.sendUnit(reqId, rid, buildMetaUnit(row));
      return;
    }
    if (parsed.suffix === 'content') {
      // 两个查询并行：字幕段与对照轨都要、互不依赖，串行等两次纯浪费
      const [segments, tracks] = await Promise.all([
        db.segments.where('videoId').equals(parsed.id).toArray(),
        db.subtitleTracks.where('videoId').equals(parsed.id).toArray(),
      ]);
      this.sendUnit(reqId, rid, buildContentUnit(parsed.id, segments, tracks));
      return;
    }
    if (parsed.suffix === 'cover') {
      const cover = await db.covers.get(parsed.id);
      if (!cover) {
        // 「没有封面」在链路上的表达就是 not-found：guest 按拉不到 cover 单元
        // 显示占位，不靠任何状态字段（理由见 payloads.ts 文件头）
        this.send({ v: PROTOCOL_VERSION, t: 'unit.err', id: reqId, reason: 'not-found' });
        return;
      }
      this.sendUnit(reqId, rid, await coverUnitFromBlob(cover));
      return;
    }
    // vectors / frames 等 P1 不拉的单元：明说 unsupported，别让 guest 干等超时
    this.send({ v: PROTOCOL_VERSION, t: 'unit.err', id: reqId, reason: 'unsupported-unit' });
  }

  /**
   * 发一个单元：先文本头（分片数 + 总字节），再按序发二进制分片。
   *
   * **rid 与 reqId 的分工（Task 6 契约，别混）**：文本头的 `id` 是 reqId
   * （guest 匹配 Promise 用），二进制分片帧头里的 rid 是另一个字段——guest
   * 收到 unit.res 后把等待中的项按 rid 重新挂键，再按 rid 收分片。把
   * unit.res 的 id 设成 rid，guest 的 Promise 匹配和分片收集会互相打架。
   */
  private sendUnit(reqId: string, rid: number, json: string): void {
    const bytes = encodeUnitPayload(json);
    const parts = chunkUnit(bytes);
    this.send({ v: PROTOCOL_VERSION, t: 'unit.res', id: reqId, rid, parts: parts.length, len: bytes.byteLength });
    for (let i = 0; i < parts.length; i++) this.sendBinary(rid, i, parts[i]);
  }

  private async handleVideoOpen(f: Frame): Promise<void> {
    const videoId = String(f.videoId);
    const row = await db.videos.get(videoId);
    // 四级拒绝，逐级说清原因（guest 直接把 reason 显示给用户）：
    if (!row) {
      this.send({ v: PROTOCOL_VERSION, t: 'video.meta', id: f.id, ok: false, reason: 'not-found' });
      return;
    }
    if (row.fileDeleted === 1) {
      this.send({ v: PROTOCOL_VERSION, t: 'video.meta', id: f.id, ok: false, reason: 'file-deleted' });
      return;
    }
    if (!DIRECT_CONTAINERS.includes(row.mimeType)) {
      this.send({ v: PROTOCOL_VERSION, t: 'video.meta', id: f.id, ok: false, reason: 'unsupported-container', mime: row.mimeType });
      return;
    }
    const file = await getCourseFile(videoId);
    if (!file) {
      this.send({ v: PROTOCOL_VERSION, t: 'video.meta', id: f.id, ok: false, reason: 'file-missing' });
      return;
    }
    // size 以 OPFS 里的真文件为准：行上的 size 是导入时记的元数据，两者理论上会漂
    this.send({ v: PROTOCOL_VERSION, t: 'video.meta', id: f.id, ok: true, size: file.size, mime: row.mimeType });
  }

  /**
   * 领一个读盘名额：有余额立刻给，否则进 FIFO 队列等前面的读完。
   *
   * **为什么不「超限就丢」**：被丢的 rid 永远收不到应答帧，而 guest 唯一的清理
   * 路径是 teardown —— 那个区间会被永久算成已覆盖、在途水位永久少一格，文件留洞
   * 而播放只是卡住（没有任何报错）。排队最多让这一片晚到，等待期间 socket 上
   * 只是少几帧在飞，不会把缓冲堆爆（host 自己就在按 1MB 分片、串行发送）。
   * 完整推演见文件头取舍 2。
   */
  private waitRangeSlot(): Promise<void> {
    this.rangeSlots++;
    if (this.rangeSlots <= MAX_RANGE_INFLIGHT) return Promise.resolve();
    return new Promise<void>((resolve) => this.rangeQueue.push(resolve));
  }

  /** 还名额：有人排队就直接移交（名额不经手，计数不变），否则计数减一。 */
  private releaseRangeSlot(): void {
    const next = this.rangeQueue.shift();
    if (next) {
      next();
      return;
    }
    this.rangeSlots--;
  }

  private async handleVideoRange(f: Frame): Promise<void> {
    // 并发配额内的有界等待：满了就在这儿等前面的读完，一个字节都不丢（取舍 2）
    await this.waitRangeSlot();
    try {
      // 等名额期间被 stop（host 主动停了共享）：socket 已经关了，读出来也没人
      // 要。立刻归还名额，让排后面的也一起散掉，别白白读一遍 OPFS。
      if (this.stopped) return;
      const videoId = String(f.videoId);
      // rid 取自远端帧，必须 >>> 0 消毒：protocol.ts 的 setUint32 对 NaN 会
      // 静默写 0，与真实 rid 0 撞车，表现为「视频字节记到另一个请求头上」
      const rid = Number(f.id) >>> 0;
      const start = Number(f.start) || 0;
      const len = Math.min(Number(f.len) || RANGE_CHUNK, RANGE_CHUNK);
      const buf = await readCourseFileRange(videoId, start, len);
      if (!buf) {
        // 文件取不到：openFile 那关已经拒过，这一格静默即可。guest 侧有
        // 「15s 没有任何字节就重规划」的兜底（mse.ts 的 stale sweep），
        // 不会永久卡住；这里若也补一帧空响应，会与「start 压在 EOF 上」的
        // 正常回收信号混在一起，分不清是哪一种。
        return;
      }
      const payload = new Uint8Array(buf);
      if (payload.byteLength === 0) {
        // 空段也补一帧（0 字节载荷）：guest 的在途水位靠 rid 帧回收，一片都不
        // 发会让这个 rid 永久占位、规划停摆。start 压在 EOF 上时会走到这
        // （pos 是线性估算的，允许过冲；readCourseFileRange 已把 start 钳进文件）。
        this.sendBinary(rid, start, payload);
        return;
      }
      // len 入口已钳到 RANGE_CHUNK，这里至多一片；循环保留是防入口将来放宽时
      // 静默发出超大帧（relay 与浏览器都有单帧上限，超限的表现是整帧消失）。
      for (let off = 0; off < payload.byteLength; off += RANGE_CHUNK) {
        this.sendBinary(rid, start + off, payload.subarray(off, Math.min(payload.byteLength, off + RANGE_CHUNK)));
      }
    } finally {
      this.releaseRangeSlot();
    }
  }
}
