/**
 * guest 侧链路客户端：WebSocket 收发 + 请求/应答配对 + 单元分片重组。
 *
 * 三条铁律落在实现里（设计不变量 + 线上协议契约）：
 *
 * 1. **拉到的数据只进内存，不落库**（不变量 9）。落库会产生「iPad 上半个课程库、与
 *    Mac 数据静默分叉」的脏状态，并让人误以为 guest 是独立副本（那是云同步的场景，
 *    不是本功能）。本文件没有任何 Dexie import —— 不靠自觉，从结构上就写不了库。
 * 2. **LLM 调用永远不在本模块**。问答属 P2，且必须走 guest 自己的 Key（不变量 1）：
 *    凭据不过链路，host 只发课程数据。
 * 3. **binaryType 必须显式设 'arraybuffer'**。默认的 'blob' 会让每条二进制帧以 Blob
 *    到达，protocol.ts 的 decodeBinaryFrame 对非 ArrayBuffer 一律返 null —— 链路像
 *    死了一样（每帧都被安静丢弃）但没有任何报错。这是本文件最贵的一行，别删。
 *
 * 四个线上协议契约（host.ts 已实现，guest 侧必须严格遵守）：
 *
 * - **请求帧的 id 必须是字符串**：decodeFrame 对 `typeof id !== 'string'` 整帧判坏帧
 *   静默丢弃，video.range 的 id 传数字等于请求根本没发出去。所有 id 走 nextId()，
 *   range 的 rid 转 id 时显式 String()。
 * - **rid 命名空间分区**：host 的单元分片 rid 占 [0x80000000, 0xffffffff]（自增计数器）；
 *   guest 自生成的 video.range rid 由调用方（mse.ts）给，必须留在 [0, 0x7fffffff]。
 *   两侧共用本文件同一张「按 rid 收二进制帧」的路由表，撞车 = 视频字节错配进单元
 *   分片（或反过来）——不报错、只错数据，极难排查。
 * - **单元拉取是两段式**：unit.req 的 id 是 reqId（文本应答 unit.res / unit.err 用它
 *   匹配），二进制分片帧头里的 rid 是另一个字段。所以等待项先按 reqId 挂着，收到
 *   unit.res 后**按 rid 重新挂键**再收分片 —— 把两个键混用会让 Promise 匹配和分片
 *   收集互相打架（host.ts 的 sendUnit 注释钉过这条）。
 * - **坏 gzip 会抛异常**：decodeUnitPayload 是 protocol.ts 唯一会抛的解码出口，
 *   loadUnit 必须让它变成 Promise reject（async 函数里直接调即可）。漏在外面的后果
 *   是错误表现为 30s 超时才暴露，或异常钻进 socket 事件回调把整条链路打死。
 * - **`unit.res` 的 `len` 必须对账**：分片数齐了不等于字节数对。收齐拼接后校验
 *   `byteLength === len`，不等立刻 reject（有分片被换成别的内容、或 relay 吞了半帧）。
 *   少了这道，裁剪过的载荷要等到解压 / JSON.parse 才以另一个难懂的面目报错。
 *
 * 另外三条链路行为：
 * - **hello id 每台 guest 唯一**（host 的 guests Map 按帧 id 去重，同 id 两台 guest
 *   会塌缩成一台）：`guest-` + 8 字节随机十六进制。
 * - **坏帧静默跳过**：decodeFrame 返 null 的帧直接丢，不杀链路（protocol.ts 约定）。
 * - **中继控制帧（host-link-down/up）先判后解码**：它们由中继合成、没有 `v`，走
 *   decodeControlFrame 而非 decodeFrame（见 handle() 里那条顺序注释）。这条是**协议层
 *   的硬要求**，不是风格偏好：反过来就会静默丢掉主机上下线提示。
 */

import {
  PROTOCOL_VERSION,
  FRAME,
  encodeFrame,
  decodeFrame,
  decodeControlFrame,
  decodeBinaryFrame,
  decodeUnitPayload,
  joinUnit,
  type Frame,
} from './protocol';
import type { IndexEntry } from './payloads';

/** 索引/开视频这类单次应答的超时。15s：一次跨家中继的往返通常 <1s，15s 足够覆盖弱网。 */
const REQUEST_TIMEOUT_MS = 15000;
/** 单元拉取超时。比单次请求长：content 单元带全部字幕，host 要查库 + gzip + 分片。 */
const UNIT_TIMEOUT_MS = 30000;

export type { IndexEntry } from './payloads';

export interface VideoOpenOk {
  ok: true;
  /** OPFS 真文件大小（host 以 file.size 回，不信 videos 行上的元数据） */
  size: number;
  mime: string;
}

export interface VideoOpenErr {
  ok: false;
  /** not-found / file-deleted / unsupported-container / file-missing，host 直出，页面原样展示 */
  reason: string;
  /** unsupported-container 时带上 host 侧的真实 mime，文案里能说清「是什么容器」 */
  mime?: string;
}

export type VideoOpenResult = VideoOpenOk | VideoOpenErr;

export interface LiveGuestOptions {
  relayUrl: string;
  /** 配对码（中继的 room 名） */
  code: string;
  /** 二进制帧出口（rid 未命中任何单元现场时）：mse.ts 的 feedRange 挂这里 */
  onBinaryFrame?: (rid: number, seq: number, payload: Uint8Array) => void;
  /** host 主动停 / relay 广播：进「主机已离线」态 */
  onHostDown?: () => void;
  /** host 在宽限期内回来：恢复（host-link-up 由中继补发） */
  onHostUp?: () => void;
  /**
   * socket 关闭（含连接失败）。byUs=true 是 close() 主动关的，页面该忽略；
   * 否则按 close code 决定重连还是直接离线（见 LiveGuest 页的重连策略）。
   */
  onClosed?: (info: { byUs: boolean; code: number; reason: string }) => void;
}

/** 一次请求/应答配对：reqId → resolve/reject + 超时句柄。 */
interface PendingReq {
  resolve: (f: Frame) => void;
  reject: (e: Error) => void;
  timer: number;
}

/**
 * 单元拉取现场。**生命周期里会搬一次家**：挂在 unitWaiters（reqId 键）等 unit.res，
 * 收到后改挂 unitSites（rid 键）收二进制分片。两个键分别对应「文本应答匹配」和
 * 「二进制帧路由」，见文件头的契约第 3 条。
 */
interface UnitCtx {
  reqId: string;
  /** unit.res 之后才知道；在此之前为 null */
  rid: number | null;
  parts: Map<number, Uint8Array>;
  /** unit.res 里的分片总数（chunkUnit 恒 ≥1） */
  expect: number;
  /**
   * unit.res 里声明的**载荷总字节数**。收齐分片后必须 `byteLength === len`，
   * 不等就是有分片被换成了别的内容（或 relay 吞了半帧）—— 立刻 reject，
   * 比挂在 30s 超时上快得多，也避免把裁剪过的载荷解压成坏 JSON。
   */
  len: number;
  resolve: (bytes: Uint8Array) => void;
  reject: (e: Error) => void;
  timer: number;
  /** 超时/出错后置位：迟到的帧与迟到的应答都不再理会 */
  settled: boolean;
}

/**
 * 8 字节随机十六进制：hello id 与 reqId 的唯一性来源（host 按 hello id 去重 guest）。
 *
 * **故意不并进 utils/uuid.ts**：这里要的不是 UUID，是「短 + 够散」。hello id 每个会话进
 * 日志、进 host 的 guests Map 的键、还出现在 e2e 的帧日志里；reqId 每帧都要发一遍，
 * 16 个字符比 36 个省一半。两者要的是不同的东西，凑成一份只会让两边各拿到不合适的一半。
 * 随机源仍是 `crypto.getRandomValues`（不是 randomUUID）：这里要的只是随机数，而
 * randomUUID 在局域网 http 这种非安全上下文里是 undefined（理由见 utils/uuid.ts 文件头）。
 */
function randomSuffix(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export class LiveGuest {
  private ws: WebSocket | null = null;
  /** reqId → 索引/开视频等待项 */
  private pending = new Map<string, PendingReq>();
  /** reqId → 单元等待项（等 unit.res 阶段） */
  private unitWaiters = new Map<string, UnitCtx>();
  /** rid → 单元分片收集现场（收到 unit.res 之后） */
  private unitSites = new Map<number, UnitCtx>();
  /** reqId 自增序列，只用于让 id 在日志里可读 + 避免同毫秒撞名 */
  private seq = 1;
  /**
   * 本连接的 guest id。**hello 与 bye 必须用同一个 id**：host 的 guests Map 按帧 id
   * 去重（hello 时 set(f.id)），bye 时也按帧 id delete(f.id) —— bye 换个 id 发，
   * host 侧的「已连接设备数」永远减不下来（不报错，只是计数黏住）。
   */
  private guestId = '';
  /** close() 主动关的标记：onclose 据此决定要不要惊动页面的重连逻辑 */
  private closedByUs = false;

  constructor(private opts: LiveGuestOptions) {}

  /**
   * 建连并发言 hello。open 即 resolve（不等 welcome —— host 的 welcome 只是回执，
   * 等它会把一次弱网放大成 15s 超时）；onerror 或 open 前被关则 reject。
   */
  connect(): Promise<void> {
    this.closedByUs = false;
    return new Promise<void>((resolve, reject) => {
      const url = `${this.opts.relayUrl}?room=${encodeURIComponent(this.opts.code)}&role=guest`;
      const ws = new WebSocket(url);
      this.ws = ws;
      // 每台 guest 唯一：host 的 guests Map 按 hello 帧 id 去重，同 id 两台 guest
      // 会塌缩成一台（契约 6）
      this.guestId = `guest-${randomSuffix()}`;
      // ⚠️ 最贵的一行：默认 'blob' 会让二进制帧全部静默解码失败，见文件头铁律 3
      ws.binaryType = 'arraybuffer';
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.send({ v: PROTOCOL_VERSION, t: 'hello', id: this.guestId });
        resolve();
      };
      ws.onerror = () => {
        if (!opened) reject(new Error(`中继连接失败（${this.opts.relayUrl}）`));
      };
      ws.onmessage = (e) => this.handle(e.data);
      ws.onclose = (e) => {
        // 同实例重连时旧连接的关闭不算数（页面是每次新实例，这里是 defense in depth）
        if (this.ws !== ws) return;
        this.ws = null;
        this.failAll(new Error(`链路已断开（${e.code}${e.reason ? ` ${e.reason}` : ''}）`));
        if (!opened) reject(new Error(`连接未建立（${e.code}${e.reason ? ` ${e.reason}` : ''}）`));
        this.opts.onClosed?.({ byUs: this.closedByUs, code: e.code, reason: e.reason });
      };
    });
  }

  /** 页面卸载/切走时调：发 bye（host 的 guest 计数立刻减一）再关 socket。 */
  close(): void {
    this.closedByUs = true;
    // bye 的 id 必须与 hello 一致，否则 host 删不掉这个 guest（见 guestId 注释）
    this.send({ v: PROTOCOL_VERSION, t: 'bye', id: this.guestId || 'guest-unknown' });
    this.ws?.close();
    this.ws = null;
  }

  /** 课程索引。host 侧 orderBy('createdAt') 的顺序原样保留（payloads.ts 的约定）。 */
  async loadIndex(): Promise<IndexEntry[]> {
    const res = await this.request({ v: PROTOCOL_VERSION, t: 'index.req' });
    return Array.isArray(res.courses) ? (res.courses as IndexEntry[]) : [];
  }

  /**
   * 拉一个单元：两段式（等 unit.res → 按 rid 收集分片 → 拼接 → 解压 → JSON.parse）。
   *
   * 任何一步失败都让 Promise reject：host 的 unit.err、收不齐分片、坏 gzip、坏 JSON。
   * async 函数里同步抛出的异常自动变成 reject，正是要的形态。
   */
  async loadUnit(unit: string): Promise<unknown> {
    const bytes = await this.pullUnitBytes(unit);
    return JSON.parse(decodeUnitPayload(bytes)) as unknown;
  }

  /** 开视频：size 以 OPFS 真文件为准，mime 是 host 的 videos 行值（容器级）。 */
  async openVideo(videoId: string): Promise<VideoOpenResult> {
    const res = await this.request({ v: PROTOCOL_VERSION, t: 'video.open', videoId });
    if (res.ok === true) {
      const size = Number(res.size);
      return { ok: true, size: Number.isFinite(size) ? size : 0, mime: String(res.mime ?? '') };
    }
    return {
      ok: false,
      reason: String(res.reason ?? 'unknown'),
      mime: res.mime == null ? undefined : String(res.mime),
    };
  }

  /**
   * 要一段视频字节。**rid 由调用方（mse.ts）生成，必须 < 0x80000000** —— 高半区是
   * host 单元分片的地盘，两侧共用一张 rid 路由表，撞车不报错、只错数据。
   *
   * id 用 String(rid)：decodeFrame 要求 id 是字符串，传数字整帧被当坏帧静默丢弃。
   */
  requestRange(rid: number, videoId: string, start: number, len: number): void {
    this.send({ v: PROTOCOL_VERSION, t: 'video.range', id: String(rid), videoId, start, len });
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  private send(frame: Frame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(frame));
  }

  private nextId(): string {
    return `g${this.seq++}-${randomSuffix()}`;
  }

  /** 单次请求/应答（index.req / video.open 用）。超时 15s，见 REQUEST_TIMEOUT_MS。 */
  private request(frame: Omit<Frame, 'id'>): Promise<Frame> {
    const id = this.nextId();
    return new Promise<Frame>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`请求超时（${frame.t}）`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...frame, id } as Frame);
    });
  }

  /** 等一个单元的分片字节（不含解压/解析）：reqId 挂等待 → unit.res 改挂 rid → 收片。 */
  private pullUnitBytes(unit: string): Promise<Uint8Array> {
    const reqId = this.nextId();
    return new Promise<Uint8Array>((resolve, reject) => {
      const ctx: UnitCtx = {
        reqId,
        rid: null,
        parts: new Map(),
        expect: 0,
        len: -1,
        resolve,
        reject,
        timer: 0,
        settled: false,
      };
      this.unitWaiters.set(reqId, ctx);
      ctx.timer = window.setTimeout(() => {
        if (ctx.settled) return;
        this.forgetUnit(ctx);
        ctx.reject(new Error(`单元拉取超时（${unit}）`));
      }, UNIT_TIMEOUT_MS);
      this.send({ v: PROTOCOL_VERSION, t: 'unit.req', id: reqId, unit });
    });
  }

  /** 从两张表里摘掉一个单元现场并停表。ctx 在 unitWaiters / unitSites 之间搬过家，两处都要清。 */
  private forgetUnit(ctx: UnitCtx): void {
    window.clearTimeout(ctx.timer);
    ctx.settled = true;
    this.unitWaiters.delete(ctx.reqId);
    if (ctx.rid != null) this.unitSites.delete(ctx.rid);
  }

  /** socket 没了：所有等待项立刻失败，别让它们挂到超时才暴露（页面要立刻切态）。 */
  private failAll(err: Error): void {
    for (const p of [...this.pending.values()]) {
      window.clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const ctx of [...this.unitWaiters.values()]) this.forgetUnit(ctx);
    this.unitWaiters.clear();
    // unitSites 里的现场**也要逐个 forgetUnit**（不能只 clear 表）：它们身上挂着
    // 30s 超时定时器，clear() 只是把表倒空，定时器照旧到点，对着一个已经没人等的
    // ctx 空转 —— 与 forgetUnit 自己那句「别让它们挂到超时」正好相反。
    // forgetUnit 内部会按 ctx.rid 从 unitSites 删，所以循环后再 clear 一遍兜底。
    for (const ctx of [...this.unitSites.values()]) this.forgetUnit(ctx);
    this.unitSites.clear();
  }

  private handle(data: unknown): void {
    if (typeof data === 'string') {
      // ⚠️ 顺序不能换：**中继控制帧必须在 decodeFrame 之前判**。控制帧没有 v，
      // decodeFrame 的判据是 `f.v !== PROTOCOL_VERSION` —— 缺字段与错版本是同一条路，
      // 顺序反过来的话 host-link-down/up 会在被认出来之前先被当坏帧丢掉，症状是
      // 「主机断线后来宾收不到已离线、恢复时收不到已重连」。decodeFrameLoose 也一样
      // 收不了它（它要求 v 是整数）。见 protocol.ts decodeControlFrame 的注释。
      const ctl = decodeControlFrame(data);
      if (ctl) {
        if (ctl.t === FRAME.hostLinkDown) this.opts.onHostDown?.();
        else this.opts.onHostUp?.();
        return;
      }
      const f = decodeFrame(data);
      if (!f) return; // 坏帧静默跳过（protocol.ts 约定）
      switch (f.t) {
        case 'unit.res':
          this.onUnitRes(f);
          return;
        case 'unit.err':
          this.onUnitErr(f);
          return;
        default:
          break;
      }
      const p = this.pending.get(f.id);
      if (p) {
        this.pending.delete(f.id);
        window.clearTimeout(p.timer);
        p.resolve(f);
      }
      return;
    }
    if (data instanceof ArrayBuffer) {
      const b = decodeBinaryFrame(data);
      if (!b) return;
      // rid 路由：单元现场优先。命中就是分片，收进现场；不命中才是视频帧。
      const site = this.unitSites.get(b.rid);
      if (site) {
        this.collectUnitPart(site, b.seq, b.payload);
        return;
      }
      this.opts.onBinaryFrame?.(b.rid, b.seq, b.payload);
    }
    // 真收到 Blob 说明 binaryType 没设对（铁律 3）：静默丢，线索回 connect() 查
  }

  /** unit.res：把等待项从 reqId 表搬到 rid 表。字段不合契约就明说，别挂到 30s 超时。 */
  private onUnitRes(f: Frame): void {
    const ctx = this.unitWaiters.get(f.id);
    if (!ctx || ctx.settled) return; // 迟到/重复的 unit.res
    this.unitWaiters.delete(f.id);
    const rid = Number(f.rid);
    const parts = Number(f.parts);
    const len = Number(f.len);
    if (!Number.isInteger(rid) || rid < 0 || !Number.isInteger(parts) || parts < 1 || !Number.isInteger(len) || len < 0) {
      this.forgetUnit(ctx);
      ctx.reject(new Error(`unit.res 字段非法：rid=${String(f.rid)} parts=${String(f.parts)} len=${String(f.len)}`));
      return;
    }
    ctx.rid = rid;
    ctx.expect = parts;
    ctx.len = len;
    this.unitSites.set(rid, ctx);
  }

  /** host 找不到单元（含「没有封面」——payloads.ts 约定 not-found 就是无封面）。 */
  private onUnitErr(f: Frame): void {
    const ctx = this.unitWaiters.get(f.id);
    if (!ctx || ctx.settled) return;
    this.forgetUnit(ctx);
    ctx.reject(new Error(`unit: ${String(f.reason ?? 'error')}`));
  }

  private collectUnitPart(site: UnitCtx, seq: number, payload: Uint8Array): void {
    if (site.settled || !Number.isFinite(seq) || seq < 0) return;
    site.parts.set(Math.floor(seq), payload); // Map 天然去重：host 重发同序号不会多算一片
    if (site.parts.size < site.expect) return;
    // 收齐：按 seq 排序后拼接。插入序不是序号序（乱序到达是常态），必须显式排。
    const parts = [...site.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, u]) => u);
    this.forgetUnit(site);
    // 每片是各自 WS 消息的缓冲视图，互不重叠、也没有人回写，直接拼不用复制
    // （protocol.ts 的视图语义在这里成立的前提就是「一条消息一块独立缓冲」）。
    const bytes = joinUnit(parts);
    // 与 unit.res 声明的 len 对账：分片数齐了但字节数不对，说明有分片的内容被换了
    // （或 relay 吞了半帧）。不等就 reject —— 比 30s 超时快得多，也避免把一份
    // 裁剪过的载荷送去解压（坏 gzip 会是另一个更难懂的错误）。
    if (bytes.byteLength !== site.len) {
      site.reject(
        new Error(`单元分片长度不符：收到 ${bytes.byteLength} 字节，unit.res 声明 ${site.len}`),
      );
      return;
    }
    site.resolve(bytes);
  }
}
