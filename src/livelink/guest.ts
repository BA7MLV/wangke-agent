/**
 * guest 侧链路客户端：**帧编排（GuestCore，无 socket）+ WebSocket 壳（LiveGuest）**。
 *
 * ## 为什么拆成两层
 *
 * 与 host.ts 的 `HostCore` / `LiveHost` 同构，理由也一样：P2 接线最容易坏的地方全在
 * 「**这一帧带没带 from / 发给谁 / 什么时候发**」上，而那种断言必须有真 socket 才跑得起来
 * （那就得 dev server + Playwright + 真浏览器），于是它们只能靠 e2e 全链路守。
 * 拆开之后「帧编排层只认三个动作：发一帧、收一条消息、报一个事件」，出向动作由 deps 注入，
 * 入向消息从 `dispatch(data)` 进 —— 于是它能在 Node 里对着一个数组跑完
 * （scripts/test-livelink-guest-wiring.mjs 就是这么测的；Task 5 对 host 侧用的是
 * 「真桩中继 + 真 ws」，这里两种都留：core 单测守协议细节，集成测试守真实 socket 接线）。
 *
 * **socket 那一层不做任何帧判断**：再判一遍就是两张路由表，改一处忘一处是必然的，
 * 而症状是某类帧静默不工作。
 *
 * ## P1 的三条铁律（四条线上契约），一个都没动
 *
 * 1. **拉到的数据只进内存，不落库**（不变量 9）。本文件没有任何 Dexie import —— 不靠自觉，
 *    从结构上就写不了库。（outbox 是 localStorage，但它存的是「打算让 host 写什么」，
 *    不是课程数据本身，与这条不变量不是一回事，见 outbox.ts 文件头。）
 * 2. **LLM 调用永远不在本模块**。问答走 host 的 qaRunner，guest 只发 chat.req、
 *    收流事件（不变量 1：凭据不过链路，host 只发课程数据）。
 * 3. **binaryType 必须显式设 'arraybuffer'**。默认的 'blob' 会让每条二进制帧以 Blob
 *    到达，protocol.ts 的 decodeBinaryFrame 对非 ArrayBuffer 一律返 null —— 链路像
 *    死了一样（每帧都被安静丢弃）但没有任何报错。这是 shell 那一层最贵的一行，别删。
 * 4. 四个线上协议契约（host.ts 已实现，guest 侧必须严格遵守）：
 *    - **请求帧的 id 必须是字符串**：decodeFrame 对 `typeof id !== 'string'` 整帧判坏帧
 *      静默丢弃，video.range 的 id 传数字等于请求根本没发出去。
 *    - **rid 命名空间分区**：host 的单元分片 rid 占 [0x80000000, 0xffffffff]；
 *      guest 自生成的 video.range rid 必须留在 [0, 0x7fffffff]。撞车不报错、只错数据。
 *    - **单元拉取是两段式**：unit.res 的 id 是 reqId（匹配 Promise），二进制分片帧头里
 *      的 rid 是另一个字段，收到 unit.res 后**按 rid 重新挂键**再收分片。
 *    - **坏 gzip 会抛异常**：decodeUnitPayload 是 protocol.ts 唯一会抛的解码出口，
 *      loadUnit 必须让它变成 Promise reject。
 *
 * 另外三条链路行为：
 * - **坏帧静默跳过**：decodeFrame 返 null 的帧直接丢，不杀链路（protocol.ts 约定）。
 * - **中继控制帧（host-link-down/up）先判后解码**：它们由中继合成、没有 `v`，走
 *   decodeControlFrame 而非 decodeFrame（见 onText 里那条顺序注释）。这条是**协议层的
 *   硬要求**，不是风格偏好。
 * - **`unit.res` 的 `len` 必须对账**：分片数齐了不等于字节数对（理由见 collectUnitPart）。
 *
 * ## P2 接线：三条 op 路径（**别把它们统一**）
 *
 * | op | 路径 | 理由 |
 * |---|---|---|
 * | `position.set` | 不入 outbox：内存里留一条 pending，5s 节流，pagehide/visibilitychange 时尽力发一次 | 进度是**最后写入胜出**语义，攒队列会让「拖到 40 分钟然后关页面」把 41:30 那条一起丢掉，而那是最常见的用法（outbox.ts 文件头已把这条写成硬约束：enqueue 遇到它直接抛错） |
 * | `study.add` | 入 outbox | 累加语义，重放会双倍 —— 靠 host 侧 clientOpId 去重（不变量 3）+ guest 侧 outbox 的至少送达一次 |
 * | `card.decide` | 入 outbox | 滑动审核是用户显式动作，不能丢 |
 *
 * `chat.stop`（ask 的 stopTurn）也走 outbox：它幂等（abort 两次无副作用）且是显式用户动作，
 * 与 card.decide 同理 —— 断链时排队比丢掉好，而 host 侧 applyChatStop 找不到轮次也回 ok。
 *
 * ## P2 接线：补发**逐条**（顺序是硬要求）
 *
 * `next()` → 发一帧 → 等它自己的 ack/fail → 再 `next()`。一次性全发会让「已确认送达」
 * 这件事失去边界（outbox.ts next() 的注释钉过这条），而且 host 的写队列是**单链串行**：
 * 连发三条时后面两条会排在后面慢慢补发，来宾这边却已经把它们当成交出去了。
 * 在途那一帧由 `inFlight` 记着，ack 丢了要**原样重发**（同 opId，host 侧幂等，见看门狗）。
 *
 * ## P2 接线：稳定 guest id（Task 5 明确要求）
 *
 * hello id 存 **sessionStorage**：刷新 / 重连复用同一个 → host 的 guests Map 覆盖同一条目
 * 而不是新增一条，共享条上的「N 台设备」才说实话。**为什么不是 localStorage**：
 * 换浏览器、另开一个标签页都应该是**独立的来宾**（各自一份 outbox、各自一条问答流），
 * 而 sessionStorage 的生命周期正好就是「这个标签页的这个会话」。
 * 拿不到 sessionStorage（隐私模式下访问 sessionStorage 本身就会抛）就退回内存里生成：
 * 代价是这类设备每次刷新在 host 侧多一台 —— 换来的是不因为一个不可用的存储而连不上。
 *
 * ## P2 接线：版本不匹配必须**显式**失败（不变量 6）
 *
 * 两条路都通向同一句话（`VERSION_MISMATCH_TEXT`）：welcome 的 `hostVersion` 对不上、
 * 或收到 `CLOSE_PROTOCOL_MISMATCH`。⚠️ 这句话**绝不能**退化成「主机已离线」：那是个误导
 * —— 主机在线、链接配对码也对，只是两页版本不同，用户会去查主机有没有开共享，
 * 而那个动作对版本差一点用都没有。真正的修复动作只有一个：刷新来宾页。
 */

import {
  PROTOCOL_VERSION,
  FRAME,
  encodeFrame,
  decodeFrame,
  decodeFrameLoose,
  decodeControlFrame,
  decodeBinaryFrame,
  decodeUnitPayload,
  joinUnit,
  helloFrame,
  CLOSE_PROTOCOL_MISMATCH,
  type Frame,
  type ChatEvKind,
} from './protocol';
import { Outbox, createLocalStorageOutbox, type OutboxStorage } from './outbox';
import type { ApplyReason, OpName } from './ops';
import type { IndexEntry } from './payloads';

/** 索引/开视频这类单次应答的超时。15s：一次跨家中继的往返通常 <1s，15s 足够覆盖弱网。 */
const REQUEST_TIMEOUT_MS = 15000;
/** 单元拉取超时。比单次请求长：content 单元带全部字幕，host 要查库 + gzip + 分片。 */
const UNIT_TIMEOUT_MS = 30000;

/**
 * 补发节拍：退避定时器的周期，**也是** internal 失败后的重试等待时间（同一个数，不是巧合
 * —— 下面那套只有「下一个 tick 再 flush」一种机制，所以 tick 周期就是退避窗口）。
 *
 * 3s 的来由：internal 失败多半是临时的（配额满、库被另一个标签页短暂锁住），秒级重试就能
 * 追上；而**原地立即重试同一个帧**是有害的：host 的写队列是单链串行，那条写不进去的 op 会
 * 一直堵在队首（后面本来能送达的 op 一起卡住），同时链路空转。所以收到 internal 只置一个
 * 「不到这个时刻不许 flush」的闸门，下一次 tick 到点再发。
 */
const RETRY_TICK_MS = 3000;

/**
 * 在途 op 的 ack 看门狗。超时**原样重发同一帧**（同 opId）——host 侧按 opId 去重 + 按
 * pending 计数补回执，重放是幂等的（ops.ts / host.ts 的 sendAck）。
 *
 * 为什么需要：ack 有一小段路是可以悄悄没的（socket 半死、中继吞帧、host 重启），而逐条补发
 * 的代价是**没有它就一直卡住队首** —— 界面上的表现是「N 条操作待补发」永远不减，用户既不知道
 * 卡在哪也做不了什么。有它，最坏情况只是延迟 OP_ACK_TIMEOUT_MS。
 */
const OP_ACK_TIMEOUT_MS = 15000;

/**
 * 进度 op 的发送节流：播放中最多每 5s 一条。
 *
 * 与 host 侧 GUEST_IDLE_MS 的口径对齐（host.ts 的注释按「guest 播放中每 5s 一条」剪在席表），
 * 两边用同一个数，将来改一处才不会静默失配。调用方（页面）在暂停/停止时调 `flushPosition()`
 * 补一条 —— 那条不受节流限制。
 */
const POSITION_THROTTLE_MS = 5000;

/** guest id 的会话存储键。换了就等于换了台设备（旧的 outbox 补发回去也没有在席资格了）。 */
export const GUEST_ID_STORAGE_KEY = 'wangke-livelink-guest-id';

/**
 * 版本不匹配时给用户的那一句。**只有这一份**：welcome 的 hostVersion 对不上与
 * `CLOSE_PROTOCOL_MISMATCH` 两条路都必须说同一句话，否则同一个故障在界面上有两种说法，
 * 而用户分不出它们其实是同一件事。
 * （LiveGuest.tsx 的 `CLOSE_REASON_TEXT[4400]` 目前是同一句话的另一份拷贝 —— 那是 UI 文案
 * 表，Task 7 接这块 UI 时改成引用这里。）
 */
export const VERSION_MISMATCH_TEXT = '中继与来宾版本不一致，请刷新页面';

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

/** 一次请求/应答配对：reqId → resolve/reject + 超时句柄。 */
interface PendingReq {
  resolve: (f: Frame) => void;
  reject: (e: Error) => void;
  timer: number;
}

/**
 * 单元拉取现场。**生命周期里会搬一次家**：挂在 unitWaiters（reqId 键）等 unit.res，
 * 收到后改挂 unitSites（rid 键）收二进制分片。两个键分别对应「文本应答匹配」和
 * 「二进制帧路由」，见文件头的契约第 4 条。
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

// ───────────────────────── 组帧（纯函数，导出给测试） ─────────────────────────
// 与 host.ts 的 ackFrameFor / chatEvFor 同一路的做法：**「这一帧长什么样」是协议级断言的对象**，
// 混在一个方法里就只能靠起真 socket 才能验。组帧与发帧之间没有别的逻辑，纯函数 + 一个 send 回调就够。

/**
 * op 帧：`from` 是**发起这一帧的来宾 id**（= 它的 hello id），host 靠它查席、并把 ack 定向回来。
 * 缺 `from` 的 op 会被 host 直接拒收（不 apply、不 ack），所以它不是可选字段，是准入条件。
 * `opId` 就是 outbox 的 clientOpId —— host 侧 `study.add` 拿它当去重键。
 */
export function opFrameFor(guestId: string, opId: string, op: OpName, args: unknown): Frame {
  return { v: PROTOCOL_VERSION, t: FRAME.op, id: opId, opId, from: guestId, op, args };
}

/**
 * 一次提问。`to` 恒为 `'*'`（当前只有一台主机，协议里就是它，见 ChatReqFrame 的注释）；
 * `from` 是发起者 id，host 回流时把它填进每一帧的 `to`。
 */
export function chatReqFor(guestId: string, turnId: string, videoId: string, text: string, images?: unknown): Frame {
  return {
    v: PROTOCOL_VERSION,
    t: FRAME.chatReq,
    id: turnId,
    to: '*',
    from: guestId,
    turnId,
    videoId,
    text,
    ...(images !== undefined ? { images } : {}),
  };
}

/** 键值存储的最小面（guest id 的会话存储）。抽成接口只为了测试能注入，生产用 sessionStorage。 */
export interface IdStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 取本标签页这一会话的 guest id：有就复用，没有就现生成并存一份。
 *
 * 存在 sessionStorage 而不是 localStorage 的理由见文件头「稳定 guest id」一节（一句话：
 * 另一个标签页 / 另一个浏览器应该是独立的来宾）。
 * **每一步都兜异常**：隐私模式与「站点数据被禁用」下访问 `sessionStorage` 本身就会抛，
 * 读抛了按「没有」处理、写抛了就只在本次会话内存里有效 —— 都不该连累建连（那才是用户
 * 真正做不了的事：刷新一下来宾页就打不开了）。
 */
export function resolveGuestId(store: IdStore | null): string {
  try {
    const saved = store?.getItem(GUEST_ID_STORAGE_KEY);
    if (saved) return saved;
  } catch {
    // 读不到就当没有（下面的生成照样能用）
  }
  const fresh = `guest-${randomSuffix()}`;
  try {
    store?.setItem(GUEST_ID_STORAGE_KEY, fresh);
  } catch {
    // 写不进去：这次会话仍然自洽，只是刷新后 host 侧会把它当另一台（文件头已写明这个代价）
  }
  return fresh;
}

/** 生产用的 guest id 会话存储：window.sessionStorage，访问本身可能抛（整体包在 try 里）。 */
function defaultIdStore(): IdStore | null {
  try {
    const s = window.sessionStorage;
    return { getItem: (k) => s.getItem(k), setItem: (k, v) => s.setItem(k, v) };
  } catch {
    return null;
  }
}

/**
 * 定时器与时钟的注入口。抽出来只有一个理由：**让「节流 / 退避 / 看门狗」这类时间行为能在
 * Node 里被精确断言**（测试脚本给一个假时钟，推进 3000ms 就看得出「有没有原地自旋」）。
 * 生产实现就是全局那四个，不引任何调度框架。
 */
export interface GuestTimers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(handle: number): void;
}

/** 生产定时器。`as unknown as number` 只是为了把 Node 的 Timeout 抹成浏览器的 number 句柄形状。 */
const GLOBAL_TIMERS: GuestTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
  clearInterval: (h) => clearInterval(h),
};

// ───────────────────────── 问答轮次的内存状态 ─────────────────────────

/**
 * 一轮问答在**来宾这边**的内存镜像（不落库，不变量 9）。
 *
 * 字段与 ChatPanel 的 patch 语义逐条对齐（那才是同一轮问答在主机上的渲染口径）：
 * `content` 是流出来的正文，`onRoundStart` 会把它清空（上一轮流出的只是检索旁白，不是答案）；
 * `toolHint` 是一行流式提示，正文一来就让位（ChatPanel 里就是 `hint: undefined`）。
 * `finalContent` 是 chat.done 的 `content` —— 权威正文（可能被护栏改写过），落库也只在主机。
 */
export interface GuestTurn {
  turnId: string;
  /** streaming = 还在流；done = chat.done；error = chat.err（含「离线时不允许提问」那句） */
  state: 'streaming' | 'done' | 'error';
  videoId: string;
  /** 用户那一问的原文（本地镜像，UI 渲染用户气泡用；链路不依赖它） */
  question: string;
  /** 流出来的当前正文 */
  content: string;
  /** 思考链累积 */
  reasoning: string;
  /** 当前工具提示 / 停因（一行；正文一来就让位） */
  toolHint: string;
  /** 当前轮次（-1 = 还没开始） */
  round: number;
  /** 题卡 / 图卡（chat.card 随流推送，不阻塞主流程 —— 不变量 5） */
  quiz: unknown;
  widget: unknown;
  widgets?: unknown[];
  /** chat.done 带回来的最终正文（权威）。流式 content 在 done 时也被它覆盖（与 ChatPanel 一致） */
  finalContent: string;
  reasoningMs?: number;
  /** chat.err 的文案（state==='error' 时有） */
  error?: string;
}

/** guest core 往外抛的信号线。都是可选的：不给就不调。 */
export interface GuestCoreEvents {
  /** host 主动停 / relay 广播：进「主机已离线」态（P1 既有三态信号，别破坏） */
  onHostDown?: () => void;
  /** host 在宽限期内回来：恢复（host-link-up 由中继补发） */
  onHostUp?: () => void;
  /** 二进制帧出口（rid 未命中任何单元现场）：mse.ts 的 feedRange 挂这里 */
  onBinaryFrame?: (rid: number, seq: number, payload: Uint8Array) => void;
  /** 待补发 op 条数变化。**0 时 UI 自己决定不显示** —— 这是用户唯一能看出「数据卡住了」的信号 */
  onPendingOps?: (n: number) => void;
  /** 一轮问答的状态变化，每次都给一份**新副本**（UI 改不坏内部状态，同 outbox 的纪律） */
  onTurn?: (turn: GuestTurn) => void;
  /** 显式错误（当前只有版本不匹配）。与「连接关闭」分开：那一类是链路没了，这一类是链路在但对不上 */
  onError?: (msg: string) => void;
}

/** GuestCore 需要的全部外部动作。出向只有一条：发一帧。 */
export interface GuestCoreDeps {
  send(frame: Frame): void;
  events?: GuestCoreEvents;
  /** 稳定 guest id（见文件头）。host 拿它认在席、定向回执 */
  guestId: string;
  outbox: Outbox;
  now?: () => number;
  timers?: GuestTimers;
}

/**
 * guest 的全部帧编排：解帧 → 路由 → 组帧 → 出向动作。**不碰 socket**。
 *
 * 状态：
 * - `pending` / `unitWaiters` / `unitSites`：P1 的请求配对与单元两段式收集（P1 原样搬）；
 * - `inFlight`：逐条补发时**在途的那一条**（带发出时刻，看门狗靠它判断要不要原样重发）；
 * - `retryAfter`：internal 失败后的退避闸门（见 RETRY_TICK_MS 的理由）；
 * - `hostUp`：主机在不在席。**welcome 之前一律当不在** —— host 拒收 `from` 不在席的 op，
 *   而 WebSocket 并不保证消息到达顺序，所以「刚建连就发 op」有可能被当成来路不明而丢掉；
 * - `turns`：在跑的问答轮次（turnId → GuestTurn）；
 * - `pendingPosition`：最后写入胜出的那一条进度（不入 outbox，见文件头三条路径）。
 */
export class GuestCore {
  private deps: GuestCoreDeps;
  private events: GuestCoreEvents;
  private timers: GuestTimers;
  private now: () => number;
  private outbox: Outbox;
  private seq = 1;

  /** reqId → 索引/开视频等待项 */
  private pending = new Map<string, PendingReq>();
  /** reqId → 单元等待项（等 unit.res 阶段） */
  private unitWaiters = new Map<string, UnitCtx>();
  /** rid → 单元分片收集现场（收到 unit.res 之后） */
  private unitSites = new Map<number, UnitCtx>();

  /** host 在不在席（welcome / host-link-up 置真；断开 / host-link-down 置假） */
  private hostUp = false;
  /** 逐条补发：在途那一帧。null = 当前没有 op 在飞 */
  private inFlight: { opId: string; op: OpName; args: unknown; sentAt: number } | null = null;
  /** internal 失败后的闸门：不到这个时刻不 flush（原地自旋会堵住 host 的串行队列） */
  private retryAfter = 0;
  /** 最后一条待发的进度（pagehide / 节流到点时尽力发一次） */
  private pendingPosition: { videoId: string; position: number; finished: boolean } | null = null;
  /** 最近一次真的发出去的进度时刻（节流基准）。初值 -∞ = 「还没发过任何一条」，于是第一条立刻发 */
  private lastPositionAt = -Infinity;
  /** turnId → 在跑的那一轮 */
  private turns = new Map<string, GuestTurn>();

  constructor(deps: GuestCoreDeps) {
    this.deps = deps;
    this.events = deps.events ?? {};
    this.timers = deps.timers ?? GLOBAL_TIMERS;
    this.now = deps.now ?? Date.now;
    this.outbox = deps.outbox;
  }

  /** 本机的 guest id（hello / bye / op.from / chat.req.from 全部用它） */
  get guestId(): string {
    return this.deps.guestId;
  }

  /** 待补发 op 条数（共享条上「N 条操作待补发」） */
  pendingOps(): number {
    return this.outbox.pendingCount();
  }

  // ── 链路生命周期（由 shell 调，core 自己不碰 socket） ──────────────────────

  /** socket 刚开：发 hello（helloFrame 顺带带 clientVersion，host 判版本不匹配用） */
  linkOpened(): void {
    this.sendHello();
  }

  /** socket 断了 / 中继把连接关掉：在途那一帧的回执不会来了，补发要从队首重来 */
  linkClosed(detail: string): void {
    this.hostUp = false;
    this.inFlight = null;
    // 在途那一帧**不**就地重发：socket 都没了，重发只是把一帧丢给空气。等重连后从队首重来，
    // 那时 host 侧按 opId 去重（study.add）或按赋值语义（position.set）接住，不会双份。
    this.failAll(new Error(`链路已断开（${detail}）`));
  }

  /** 中继补发的 host-link-down：主机走了，补发闸门关掉（帧留着，回来再发） */
  hostLinkDown(): void {
    this.hostUp = false;
    this.inFlight = null;
    this.events.onHostDown?.();
  }

  /**
   * 中继补发的 host-link-up：主机回来了。
   *
   * **必须重发一次 hello**：host 的在席表在它自己断线时被清空了（HostCore.shutdown），
   * 而那张表**只能由 hello 重建** —— 不重发的话本机此后所有 op / chat.req 都会被当成
   * 「来路不明」拒收（不 apply、不 ack），症状是「恢复之后进度再也不动了、回执永远不来」，
   * 而界面上除了那条重连提示什么都没有。id 是同一个（稳定 id），重发 hello 走的是
   * 「覆盖同一条目」，host 的设备数不会因此虚高。
   */
  hostLinkUp(): void {
    this.hostUp = true;
    this.sendHello();
    this.events.onHostUp?.();
    this.flushOutbox();
  }

  /**
   * shell 的周期心跳（RETRY_TICK_MS 一次）。三件事：
   * ① 到点补一条进度（用户没暂停时靠它，而不是靠页面事件）；
   * ② 在途 op 的 ack 看门狗（超过 OP_ACK_TIMEOUT_MS 就原样重发，host 侧幂等）；
   * ③ 常规补发（含 internal 退避到点后的重试、以及新 enqueue 之后的续发）。
   */
  tick(): void {
    this.flushPosition(false);
    if (this.inFlight) {
      if (this.now() - this.inFlight.sentAt >= OP_ACK_TIMEOUT_MS) {
        this.deps.send(opFrameFor(this.guestId, this.inFlight.opId, this.inFlight.op, this.inFlight.args));
        this.inFlight.sentAt = this.now();
      }
      // 严格逐条：在途这一帧没回执就不发下一条（watchdog 的语义也是「还是它」）
      return;
    }
    this.flushOutbox();
  }

  // ── 写面：三条路径 ────────────────────────────────────────────────────────

  /**
   * 进度：**不入 outbox**（见文件头三条路径）。内存里只留最后一条，节流 5s。
   *
   * 调用方（页面）按播放器事件调，通常是 `timeupdate`（每秒触发）：低于 5s 的调用只会
   * 覆盖那条 pending，直到节流到点或 `flushPosition()` 才真的发出去。
   */
  setPosition(videoId: string, position: number, finished: boolean): void {
    if (!videoId) return;
    this.pendingPosition = { videoId, position, finished };
    this.flushPosition(false);
  }

  /**
   * 尽力发掉内存里那条 pending 进度。`force` 用于暂停/停止/pagehide（不等节流）；
   * 不 force 时由 tick 按节流调用。离线时**留着不丢**，等下一个 tick / pagehide。
   */
  flushPosition(force = true): void {
    const p = this.pendingPosition;
    if (!p) return;
    if (!force && this.now() - this.lastPositionAt < POSITION_THROTTLE_MS) return;
    if (!this.hostUp) return;
    this.pendingPosition = null;
    this.lastPositionAt = this.now();
    // 进度是**赋值语义、天然幂等**，本来就不需要去重键；它不进 outbox 就没有 clientOpId，
    // 所以这个 id 纯粹是帧的路由 id（信封 id 与 opId 同值，回执回来时对不上任何记录、直接忽略）。
    this.deps.send(opFrameFor(this.guestId, `pos-${randomSuffix()}`, 'position.set', {
      videoId: p.videoId,
      position: p.position,
      finished: p.finished,
    }));
  }

  /** 学习时长：入 outbox（累加语义，靠 host 侧 clientOpId 去重），入队成功立刻试着补发 */
  addStudy(date: string, seconds: number): void {
    this.enqueueOp('study.add', { date, seconds });
  }

  /** 卡片审核：入 outbox（用户显式动作，不能丢） */
  decideCard(videoId: string, cardId: number, status: 0 | 1 | 2): void {
    this.enqueueOp('card.decide', { videoId, cardId, status });
  }

  /** 停一轮问答：走 op 面（设计 §3.2），同样入 outbox —— 幂等，断链时排队比丢掉好 */
  stopTurn(turnId: string): void {
    if (!turnId) return;
    this.enqueueOp('chat.stop', { turnId });
  }

  private enqueueOp(op: OpName, args: unknown): void {
    this.outbox.enqueue(op, args);
    this.reportPending();
    // 触发时机 ①：在线时入队即补发。离线也不丢，下一个 tick / 恢复信号会再试。
    this.flushOutbox();
  }

  /**
   * 补发：取队首发一帧。**严格逐条** —— 有在途的、还没到退避时刻的、主机不在席的，都不发。
   */
  private flushOutbox(): void {
    if (this.inFlight) return;
    if (!this.hostUp) return; // 离线只入队（补发等 host-link-up / 下一个 tick）
    if (this.now() < this.retryAfter) return; // internal 退避中：等下一个 tick，不原地自旋
    const rec = this.outbox.next();
    if (!rec) return;
    this.inFlight = { opId: rec.clientOpId, op: rec.op, args: rec.args, sentAt: this.now() };
    this.deps.send(opFrameFor(this.guestId, rec.clientOpId, rec.op, rec.args));
  }

  // ── 问答客户端 ────────────────────────────────────────────────────────────

  /**
   * 发起一轮问答，返回 turnId（stopTurn 要用）。
   *
   * **离线直接判错、不排队**：设计非目标里明确「不做 guest 端离线攒着待发的提问」——
   * 攒起来会让用户以为已经问出去了，而他点的其实是另一台不在的机器。错误那一句由
   * `onTurn` 抛出去（state='error'），UI 原样显示即可。
   */
  ask(videoId: string, text: string, images?: unknown): string {
    const turnId = this.nextId();
    const turn: GuestTurn = {
      turnId,
      state: 'streaming',
      videoId,
      question: text,
      content: '',
      reasoning: '',
      toolHint: '',
      round: -1,
      quiz: undefined,
      widget: undefined,
      finalContent: '',
    };
    this.turns.set(turnId, turn);
    if (!this.hostUp) {
      turn.state = 'error';
      turn.error = '主机不在线，提问没有发出去';
    } else {
      this.deps.send(chatReqFor(this.guestId, turnId, videoId, text, images));
    }
    this.emitTurn(turn);
    return turnId;
  }

  /** 取一轮的当前状态（副本）。UI 也可以只靠 onTurn 增量更新 */
  turn(turnId: string): GuestTurn | undefined {
    const t = this.turns.get(turnId);
    return t ? { ...t } : undefined;
  }

  private emitTurn(t: GuestTurn): void {
    this.events.onTurn?.({ ...t }); // 副本：UI 不许改到内部状态（同 outbox.list() 的纪律）
  }

  // ── 读面（P1，原样搬过来，只把 this.send 换成 this.deps.send） ───────────────

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
    this.deps.send({ v: PROTOCOL_VERSION, t: FRAME.videoRange, id: String(rid), videoId, start, len });
  }

  // ── 入向 ──────────────────────────────────────────────────────────────────

  /** 一条入站消息的唯一入口（shell 的 onmessage 调它）。非文本非 ArrayBuffer 安静忽略。 */
  dispatch(data: unknown): void {
    if (typeof data === 'string') {
      this.onText(data);
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
      this.events.onBinaryFrame?.(b.rid, b.seq, b.payload);
    }
    // 真收到 Blob 说明 binaryType 没设对（文件头铁律 3）：静默丢，线索回 shell 里那行查
  }

  private onText(text: string): void {
    // ⚠️ 顺序不能换：**中继控制帧必须在 decodeFrame 之前判**。控制帧没有 v，
    // decodeFrame 的判据是 `f.v !== PROTOCOL_VERSION` —— 缺字段与错版本是同一条路，
    // 顺序反过来的话 host-link-down/up 会在被认出来之前先被当坏帧丢掉，症状是
    // 「主机断线后来宾收不到已离线、恢复时收不到已重连」。decodeFrameLoose 也一样
    // 收不了它（它要求 v 是整数）。见 protocol.ts decodeControlFrame 的注释。
    const ctl = decodeControlFrame(text);
    if (ctl) {
      if (ctl.t === FRAME.hostLinkDown) this.hostLinkDown();
      else this.hostLinkUp();
      return;
    }
    const f = decodeFrame(text);
    if (!f) {
      // 严格解不出来，但**只有一种情况还值得认**：welcome 且版本不符。那正是不变量 6
      // 要求「明说」的那一路 —— 与 host 侧对 hello 的处理对称（宽松解只放宽版本一项，
      // 理由见 protocol.ts decodeFrameLoose）。
      const loose = decodeFrameLoose(text);
      if (loose && loose.frame.t === FRAME.welcome) this.onWelcome(loose.frame);
      return; // 其余坏帧静默跳过（protocol.ts 约定）
    }
    switch (f.t) {
      case FRAME.welcome:
        this.onWelcome(f);
        return;
      case FRAME.ack:
        this.onAck(f);
        return;
      case FRAME.chatEv:
        this.onChatEv(f);
        return;
      case FRAME.chatCard:
        this.onChatCard(f);
        return;
      case FRAME.chatDone:
        this.onChatDone(f);
        return;
      case FRAME.chatErr:
        this.onChatErr(f);
        return;
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
      this.timers.clearTimeout(p.timer);
      p.resolve(f);
    }
  }

  /**
   * welcome：握手回执，兼**唯一的版本判据**（⚠️ 别拿信封的 v 当判据，见 WelcomeFrame）。
   *
   * 版本对不上 → **显式**报一句错，并且**不进在席状态**：此后所有 op 都会被 host 当来路不明
   * 拒收，页面只能显示那句话并等用户刷新（P1 的三态信号不动：「主机已离线」那条不归它管 ——
   * 主机是在线的，只是版本对不上，说「离线」是误导）。
   */
  private onWelcome(f: Frame): void {
    const hostVersion = Number(f.hostVersion);
    if (!Number.isInteger(hostVersion) || hostVersion !== PROTOCOL_VERSION) {
      this.hostUp = false;
      this.inFlight = null;
      this.events.onError?.(VERSION_MISMATCH_TEXT);
      return;
    }
    this.hostUp = true;
    this.flushOutbox(); // 建连/重连后补发队列里攒着的东西（触发时机 ①②的落点）
  }

  /**
   * 一条回执。**只认发给本机的**（`to === 我的 id`）—— ack 是路由，不是广播：
   * 广播出去等于把这台设备写了什么、改没改成告诉别的设备，而每台来宾都要按 opId 去匹配
   * 自己的 outbox（不变量 7）。认错的后果不是多显示一行，而是 B 的 outbox 删掉一条它从没
   * 发过的 op，而 A 那条永远重发到配额用尽（见 protocol.ts AckFrame）。
   *
   * `inFlight` 也**只在 opId 对得上时**才清：进度 op 同样会收到 ack，若不判 opId，
   * 一条进度回执就会把「正在补发的 op」误判成已确认，第 2 条提前发出去了。
   */
  private onAck(f: Frame): void {
    if (String(f.to ?? '') !== this.guestId) return;
    const opId = String(f.opId ?? '');
    if (!opId) return;
    let retry = false;
    if (f.ok === 1) {
      this.outbox.ack(opId);
    } else {
      // ok 严格判 1：别的写法（true / '1' / 缺失）一律按失败处理。落成「失败」最坏只是
      // 多重试几次（internal 有配额），反过来把坏 ack 当送达就是**静默丢用户数据**。
      retry = this.outbox.fail(opId, ackReason(f)) === 'retry';
    }
    this.reportPending();
    if (this.inFlight?.opId !== opId) return; // 不是在途那一帧的回执（迟到的 / 别的 op）
    this.inFlight = null;
    // internal 之后**不接着发下一条**：置一个退避闸门，等下一个 tick（理由见 RETRY_TICK_MS）
    if (retry) this.retryAfter = this.now() + RETRY_TICK_MS;
    this.flushOutbox();
  }

  /** chat.ev：流事件。只认发给本机的（`to === 我的 id`），别人那轮的流一个字都不许进本地状态 */
  private onChatEv(f: Frame): void {
    const turn = this.pickTurn(f);
    if (!turn) return;
    const text = typeof f.text === 'string' ? f.text : '';
    switch (String(f.kind) as ChatEvKind) {
      case 'round':
        // 新一轮开始 = 上一轮流出的内容只是检索旁白，清空等最终回答（ChatPanel 同款 patch）
        turn.round = Number(f.round ?? 0);
        turn.content = '';
        turn.toolHint = '';
        break;
      case 'delta':
        turn.content += text;
        turn.toolHint = ''; // 正文一来，工具提示让位（ChatPanel: hint: undefined）
        break;
      case 'reasoning':
        turn.reasoning += text;
        break;
      case 'tool':
      case 'stop':
        // 一行流式提示：显示它就知道「不是在生成了，是在检索 / 在收尾」
        turn.toolHint = text;
        break;
      default:
        return; // 不认识的 kind：不动状态（远端数据不完全可信）
    }
    this.emitTurn(turn);
  }

  /** chat.card：题卡 / 图卡，随流推送但**不阻塞**（不变量 5） */
  private onChatCard(f: Frame): void {
    const turn = this.pickTurn(f);
    if (!turn) return;
    if (String(f.kind) === 'widget') {
      turn.widget = f.payload;
      turn.widgets = [...(turn.widgets ?? []), f.payload];
    }
    else if (String(f.kind) === 'quiz') turn.quiz = f.payload;
    else return;
    this.emitTurn(turn);
  }

  /** chat.done：一轮结束。content 是权威正文（可能与流出来的不完全相同），其余字段随它一起到 */
  private onChatDone(f: Frame): void {
    const turn = this.pickTurn(f);
    if (!turn) return;
    turn.finalContent = String(f.content ?? '');
    turn.content = turn.finalContent; // 与 ChatPanel 一致：done 之后 content 就是最终正文
    turn.toolHint = '';
    if (typeof f.reasoning === 'string') turn.reasoning = f.reasoning;
    if (Number.isFinite(f.reasoningMs)) turn.reasoningMs = Number(f.reasoningMs);
    if (f.quiz !== undefined) turn.quiz = f.quiz;
    if (f.widget !== undefined) turn.widget = f.widget;
    if (Array.isArray(f.widgets)) turn.widgets = f.widgets;
    turn.state = 'done';
    this.emitTurn(turn);
  }

  /**
   * chat.err：这一轮失败了。**只动这一轮** —— 一个失败不许把别的轮次（哪怕是已完成的那条）
   * 的状态改成 error：两台设备各问各的时，B 的失败把 A 的答案标成「出错」是难以排查的一类故障。
   */
  private onChatErr(f: Frame): void {
    const turn = this.pickTurn(f);
    if (!turn) return;
    turn.state = 'error';
    turn.error = String(f.message ?? '问答失败');
    this.emitTurn(turn);
  }

  /** 取 `to === 我的 id` 的那一轮。不认识的一律忽略（既包括别人的帧，也包括页面已放弃的旧轮） */
  private pickTurn(f: Frame): GuestTurn | undefined {
    if (String(f.to ?? '') !== this.guestId) return undefined;
    const turn = this.turns.get(String(f.turnId ?? ''));
    return turn && turn.state === 'streaming' ? turn : undefined;
  }

  private reportPending(): void {
    this.events.onPendingOps?.(this.outbox.pendingCount());
  }

  private sendHello(): void {
    this.deps.send(helloFrame(this.guestId));
  }

  private nextId(): string {
    return `g${this.seq++}-${randomSuffix()}`;
  }

  /** 单次请求/应答（index.req / video.open 用）。超时 15s，见 REQUEST_TIMEOUT_MS。 */
  private request(frame: Omit<Frame, 'id'>): Promise<Frame> {
    const id = this.nextId();
    return new Promise<Frame>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`请求超时（${frame.t}）`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.deps.send({ ...frame, id } as Frame);
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
      ctx.timer = this.timers.setTimeout(() => {
        if (ctx.settled) return;
        this.forgetUnit(ctx);
        ctx.reject(new Error(`单元拉取超时（${unit}）`));
      }, UNIT_TIMEOUT_MS);
      this.deps.send({ v: PROTOCOL_VERSION, t: 'unit.req', id: reqId, unit });
    });
  }

  /** 从两张表里摘掉一个单元现场并停表。ctx 在 unitWaiters / unitSites 之间搬过家，两处都要清。 */
  private forgetUnit(ctx: UnitCtx): void {
    this.timers.clearTimeout(ctx.timer);
    ctx.settled = true;
    this.unitWaiters.delete(ctx.reqId);
    if (ctx.rid != null) this.unitSites.delete(ctx.rid);
  }

  /** socket 没了：所有等待项立刻失败，别让它们挂到超时才暴露（页面要立刻切态）。 */
  private failAll(err: Error): void {
    for (const p of [...this.pending.values()]) {
      this.timers.clearTimeout(p.timer);
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

/**
 * ack 里的失败原因 → outbox 的分类。**终态原因按名单收，其余一律按 internal（暂态）**：
 * 远端数据不完全可信，一个不认识的 reason 若被当成终态就是静默丢用户数据（他滑过的卡片
 * 再也不会出现在主机的库里），而按暂态最多多重试几次（有配额兜底）。
 */
function ackReason(f: Frame): ApplyReason {
  const raw = String(f.reason ?? 'internal');
  return raw === 'not-found' || raw === 'gone' || raw === 'bad-args' || raw === 'unknown-op' ? raw : 'internal';
}

// ───────────────────────── LiveGuest：socket 那一层 ─────────────────────────

export interface LiveGuestOptions {
  relayUrl: string;
  /** 配对码（中继的 room 名） */
  code: string;
  /** 二进制帧出口（rid 未命中任何单元现场）：mse.ts 的 feedRange 挂这里 */
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
  /** 待补发 op 条数变化（镜像页上的「N 条操作待补发」；0 时 UI 不显示） */
  onPendingOps?: (n: number) => void;
  /** 一轮问答的状态变化（每次变化都给一份新副本） */
  onTurn?: (turn: GuestTurn) => void;
  /**
   * 显式错误（当前只有版本不匹配那一句）。**与 onClosed 分开**：那一类是「连接没了」，
   * 这一类是「连接在、但两边版本对不上」——合并的话版本不匹配会被显示成「主机已离线」，
   * 那是误导（主机在线、配对码也对），而用户照着它去查主机有没有开共享，一次也修不好。
   */
  onError?: (msg: string) => void;
  /** 测试注入：guest id 的会话存储（生产用 window.sessionStorage） */
  idStore?: IdStore;
  /** 测试注入：outbox 落盘后端（生产用 localStorage） */
  outboxStorage?: OutboxStorage;
  /** 测试注入：时钟与定时器（生产用全局那四个） */
  now?: () => number;
  timers?: GuestTimers;
}

/**
 * guest 的 IO 壳：起/停 WebSocket、把出向帧接到 socket 上、挂「页面真的要走了」的钩子。
 *
 * **不自己判帧**：再判一遍就是两张路由表，改一处忘一处必然，而症状是某类帧静默不工作。
 *
 * shell 负责的四件事，理由都在各自注释里：binaryType（铁律 3）、连接生命周期与
 * onClosed 的 close code 语义、补发节拍定时器、pagehide/visibilitychange 的尽力补发。
 */
export class LiveGuest {
  private ws: WebSocket | null = null;
  private core: GuestCore;
  private opts: LiveGuestOptions;
  private timers: GuestTimers;
  /** 补发节拍句柄（connect 起、close 停） */
  private tickHandle: number | null = null;
  private closedByUs = false;
  /** 已挂上的生命周期钩子（幂等挂载：同一实例可能重连，close 时按这份摘） */
  private hooks: { onPageHide: () => void; onVisibility: () => void } | null = null;

  // 显式字段而不是构造器参数属性（ops.ts 的同一纪律：Node 的类型剥离不支持参数属性）
  constructor(opts: LiveGuestOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? GLOBAL_TIMERS;
    this.core = new GuestCore({
      send: (frame) => this.send(frame),
      events: {
        ...(opts.onBinaryFrame ? { onBinaryFrame: opts.onBinaryFrame } : {}),
        ...(opts.onHostDown ? { onHostDown: opts.onHostDown } : {}),
        ...(opts.onHostUp ? { onHostUp: opts.onHostUp } : {}),
        ...(opts.onPendingOps ? { onPendingOps: opts.onPendingOps } : {}),
        ...(opts.onTurn ? { onTurn: opts.onTurn } : {}),
        ...(opts.onError ? { onError: opts.onError } : {}),
      },
      // guest id 在**构造时**定一次：这个实例的 hello / bye / op.from 必须是同一个 id
      //（host 的 guests Map 按 id 去重，bye 换个 id 发会让设备数减不下来）
      guestId: resolveGuestId(opts.idStore ?? defaultIdStore()),
      outbox: new Outbox(opts.outboxStorage ?? createLocalStorageOutbox()),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.timers ? { timers: opts.timers } : {}),
    });
  }

  /** 本机的 guest id（排障用：帧日志 / 「为什么 host 上多了一台」） */
  get guestId(): string {
    return this.core.guestId;
  }

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
      // ⚠️ 最贵的一行：默认 'blob' 会让二进制帧全部静默解码失败，见文件头铁律 3
      ws.binaryType = 'arraybuffer';
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.core.linkOpened();
        this.startHooks();
        this.startTick();
        // 先把队列里攒着的条数报出去：刷新之后 outbox 是从 localStorage 恢复的，
        // 不报的话 UI 要等第一次补发才知道「有待补发的操作」（那个数是用户唯一的信号）
        this.opts.onPendingOps?.(this.core.pendingOps());
        resolve();
      };
      ws.onerror = () => {
        if (!opened) reject(new Error(`中继连接失败（${this.opts.relayUrl}）`));
      };
      ws.onmessage = (e) => this.core.dispatch(e.data);
      ws.onclose = (e) => {
        // 同实例重连时旧连接的关闭不算数（页面是每次新实例，这里是 defense in depth）
        if (this.ws !== ws) return;
        this.ws = null;
        this.core.linkClosed(`${e.code}${e.reason ? ` ${e.reason}` : ''}`);
        this.stopHooks();
        this.stopTick();
        if (!opened) reject(new Error(`连接未建立（${e.code}${e.reason ? ` ${e.reason}` : ''}）`));
        // 版本不匹配：host 关连接用的就是这一个码（protocol.ts 的 CLOSE_PROTOCOL_MISMATCH）。
        // 走 onError 而不是让页面显示「主机已离线」—— 那是误导，刷新才是修复动作。
        if (e.code === CLOSE_PROTOCOL_MISMATCH) {
          this.opts.onError?.(VERSION_MISMATCH_TEXT);
          this.opts.onClosed?.({ byUs: this.closedByUs, code: e.code, reason: e.reason });
          return;
        }
        this.opts.onClosed?.({ byUs: this.closedByUs, code: e.code, reason: e.reason });
      };
    });
  }

  /** 页面卸载/切走时调：先尽力补发内存里的进度，再发 bye（host 的 guest 计数立刻减一），最后关 socket。 */
  close(): void {
    this.closedByUs = true;
    // 进度是最后写入胜出语义：这一条发不出去就永远丢了（见文件头三条路径），
    // 所以放在 bye 之前 —— 反过来的话主机先摘了这台设备，op 的 from 就成了来路不明。
    this.core.flushPosition(true);
    // bye 的 id 必须与 hello 一致，否则 host 删不掉这个 guest（见 guestId 注释）
    this.send({ v: PROTOCOL_VERSION, t: FRAME.bye, id: this.core.guestId || 'guest-unknown' });
    this.stopHooks();
    this.stopTick();
    this.ws?.close();
    this.ws = null;
  }

  // ── 读面（转发给 core） ────────────────────────────────────────────────────
  /** 课程索引。host 侧 orderBy('createdAt') 的顺序原样保留（payloads.ts 的约定）。 */
  loadIndex(): Promise<IndexEntry[]> {
    return this.core.loadIndex();
  }

  /** 拉一个单元（两段式：unit.res → 按 rid 收分片 → 解压 → JSON.parse） */
  loadUnit(unit: string): Promise<unknown> {
    return this.core.loadUnit(unit);
  }

  /** 开视频：size 以 OPFS 真文件为准，mime 是 host 的 videos 行值（容器级） */
  openVideo(videoId: string): Promise<VideoOpenResult> {
    return this.core.openVideo(videoId);
  }

  /** 要一段视频字节。rid 由 mse.ts 生成，必须 < 0x80000000（见 core.requestRange） */
  requestRange(rid: number, videoId: string, start: number, len: number): void {
    this.core.requestRange(rid, videoId, start, len);
  }

  // ── 写面与问答（转发给 core，见 GuestCore 里每一处的理由注释） ───────────────

  /** 进度：内存留一条 + 5s 节流，**不入 outbox** */
  setPosition(videoId: string, position: number, finished: boolean): void {
    this.core.setPosition(videoId, position, finished);
  }

  /** 立刻补发内存里那条进度（暂停/停止时用，不等节流） */
  flushPosition(): void {
    this.core.flushPosition(true);
  }

  /** 学习时长：入 outbox */
  addStudy(date: string, seconds: number): void {
    this.core.addStudy(date, seconds);
  }

  /** 卡片审核：入 outbox */
  decideCard(videoId: string, cardId: number, status: 0 | 1 | 2): void {
    this.core.decideCard(videoId, cardId, status);
  }

  /** 发起一轮问答，返回 turnId（stopTurn 要用） */
  ask(videoId: string, text: string, images?: unknown): string {
    return this.core.ask(videoId, text, images);
  }

  /** 停一轮问答（发 chat.stop op，host 侧 abort） */
  stopTurn(turnId: string): void {
    this.core.stopTurn(turnId);
  }

  /** 待补发 op 条数（「N 条操作待补发」） */
  pendingOps(): number {
    return this.core.pendingOps();
  }

  /** 一轮问答的当前状态（副本） */
  turn(turnId: string): GuestTurn | undefined {
    return this.core.turn(turnId);
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private send(frame: Frame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(frame));
  }

  private startTick(): void {
    if (this.tickHandle != null) return;
    this.tickHandle = this.timers.setInterval(() => this.core.tick(), RETRY_TICK_MS);
  }

  private stopTick(): void {
    if (this.tickHandle == null) return;
    this.timers.clearInterval(this.tickHandle);
    this.tickHandle = null;
  }

  /**
   * 挂「页面真的要走了」的两个钩子。
   *
   * `pagehide` 是标准信号（bfcache 往返、iOS 收 App、关标签页都会触发）；
   * `visibilitychange → hidden` 是它的补充：手机上「切到别的 App」不一定走到 pagehide，
   * 而那恰恰是**进度最容易丢**的时刻（用户暂停着看，切出去，过一会儿回来 —— 进度条该在
   * 中间那个位置，缺了这一条它会退回上次那条 op 的位置）。
   *
   * 两个钩子都只做「尽力发一条」，发不出去就算了：不阻塞卸载（同步发一条 websocket
   * 文本是能进去的，但别在这里做任何阻塞或 await）。
   */
  private startHooks(): void {
    if (this.hooks) return;
    const onPageHide = () => this.core.flushPosition(true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') this.core.flushPosition(true);
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    this.hooks = { onPageHide, onVisibility };
  }

  private stopHooks(): void {
    if (!this.hooks) return;
    window.removeEventListener('pagehide', this.hooks.onPageHide);
    document.removeEventListener('visibilitychange', this.hooks.onVisibility);
    this.hooks = null;
  }
}
