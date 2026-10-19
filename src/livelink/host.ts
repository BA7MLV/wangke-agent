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
 *    （P2 的问答走 qaRunner，它自己 getSettings() 取 Key 在**本机**发起模型调用，
 *    Key 仍然一个字节都不上线 —— 那一层的白名单由 qaRunner 负责。）
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
 * ## P2 接线：为什么拆成 LiveHost（IO 壳）+ HostCore（帧编排）
 *
 * P1 的 `handle()` 一个方法里混着三件事：解帧、判断、IO（send / close / 落库后的读写）。
 * 那种形状没法单测 —— 它必须有真 socket 才跑得起来，于是「ack 有没有回给正确那台来宾」
 * 「版本对不上时有没有多发一帧」这类**协议级**断言就只能靠 e2e 全链路（要 dev server +
 * Playwright + 真浏览器）来守，而它们恰恰是最容易静默错的两处。
 *
 * 拆法是「依赖倒着传」：帧编排层（HostCore）只认三个动作 —— 发一帧、发一段二进制、
 * 关连接（deps），socket 那一层（LiveHost）只负责把动作接到真 WebSocket 上、并在
 * readyState 不是 OPEN 时把动作变成空操作。编排层于是可以在 Node 里对着一个数组
 * 跑完（scripts/test-livelink-host-wiring.mjs 真起一条桩中继 + 真 WebSocket 客户端，
 * 走的是同一条 LiveHost 代码路径；core 本身则连 socket 都不需要）。
 *
 * **视频面 / 读面路径在这一步没有改语义**：下面 handleUnitReq / handleVideoOpen /
 * handleVideoRange / sendUnit / waitRangeSlot / releaseRangeSlot 全是 P1 原样搬过来的，
 * 唯一的变化是 `this.send(...)` → `this.deps.send(...)`（出向帧必须走注入的口子，
 * 否则测不了「这一帧到底发给谁」）。
 *
 * ## P2 的三条入向路径（顺序是硬要求）
 *
 * `dispatch()` 里三步，顺序反过来都会静默丢帧：
 *
 * 1. **控制帧**（decodeControlFrame）→ 直接丢弃（host 是数据源，中继的 host-link-down/up
 *    是给 guest 看的，与 host 无关；host 自己掉线由自己的 socket close 感知）。它没有 `v`，
 *    先判才不会以「版本不符」被当坏帧丢掉。
 * 2. **握手**（decodeFrameLoose）→ hello 必须在严格解码之前认：decodeFrame 对 v1 的 hello
 *    返 null，老来宾的 hello 会被**静默**丢弃（host 毫无反应，guest 永远停在「连接中」，
 *    正是设计不变量 6 明令禁止的失败形态）。
 * 3. 其余一律 decodeFrame（严格）：版本不符的业务帧是「不认识的形状」，硬解出来的字段
 *    只会错配（把 v2 的 chat.ev 当 v1 的 video.meta 读），见 protocol.ts 文件头。
 *
 * 设计文档：docs/plans/2026-10-09-live-link.md（P1）、docs/plans/2026-10-13-live-link-p2-design.md（P2）
 */

import { db } from '../store/db';
import { getCourseFile, readCourseFileRange } from '../store/fileStore';
import {
  PROTOCOL_VERSION,
  FRAME,
  encodeFrame,
  decodeFrame,
  decodeFrameLoose,
  decodeControlFrame,
  encodeBinaryFrame,
  encodeUnitPayload,
  chunkUnit,
  versionCheck,
  welcomeFrame,
  CLOSE_PROTOCOL_MISMATCH,
  type Frame,
  type ChatEvKind,
  type ChatEvFrame,
  type ChatCardFrame,
  type ChatDoneFrame,
  type ChatErrFrame,
  type AckFrame,
} from './protocol';
import { buildIndex, buildMetaUnit, buildContentUnit, coverUnitFromBlob, buildCardsUnit } from './payloads';
import { OpQueue, createLruDedup, type ApplyResult, type OpName } from './ops';
import { runQa, qaToolHint, type QaRunResult, type QaSink } from '../harness/qaRunner';
import { unitKindOf } from '../materials/reindex';
import type { VideoRow } from '../store/db';
import type { ContentPart } from '../api/siliconflow';

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
 * 在席表里的条目静默多久算「大概已经不在了」。只在**收到新 hello** 时剪（不当定时器跑），
 * 剪的是计数，不剪路由 —— 见 pruneIdleGuests 与 admitGuest 的注释。
 *
 * 定这个数的依据：guest 播放中每 5s 一条 position.set（P2 的节流口径），所以一台真在用的
 * 设备不会静默超过几分钟；10 分钟要足够长到「暂停着看画面、十分钟没动」的那种设备不被
 * 当成掉线。
 */
const GUEST_IDLE_MS = 10 * 60 * 1000;
/** 在席表的长度上限。超了淘汰最久没见到的那条（挡「短时间内反复重连把表撑爆」）。 */
const MAX_GUESTS = 8;
/**
 * 墓碑表的复活宽限：被剪掉的条目在这个窗口内仍可凭 `from` 自动回到在席表。
 * 宁可让计数短暂偏多，也不让一台在用设备从此收不到 ack（那会表现成「iPad 上的进度条
 * 不动了」，界面上没有任何异常）。窗口给到 30 分钟：覆盖「剪掉之后设备继续用」的全程。
 */
const GUEST_REVIVE_MS = 30 * 60 * 1000;
/** 墓碑表长度上限（只进不出的表也得有界）。 */
const MAX_REVIVED = 32;
/**
 * ack 目标表的保护上限。正常情况下每条 op 入队即记、ack 即删，量级等于在途 op 数；
 * 这个上限只防「ack 丢了一直没回来」的异常路径把内存吃光（表按插入序淘汰最旧的）。
 */
const MAX_ACK_TARGETS = 512;

/**
 * 解析 guest 要的单元 id：`video:<id>:meta|content|cover|cards`，从右侧切。
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

// ───────────────────────── P2 组帧（纯函数，导出给测试） ─────────────────────────
// 单独抽出来的理由与 HostCore 的拆分同源：**「这一帧长什么样」是协议级断言的对象**
// （ack 带没带 to、chat.done 的 content 是什么），混在一个几十行的方法里就只能靠
// 起真 socket 才能验。组帧与发帧之间没有别的逻辑，所以纯函数 + 一个 send 回调就够。

/** op 的回执：`to` 指向发起那条 op 的来宾。ok 是 1|0（线上口径，见 protocol.ts）。 */
export function ackFrameFor(to: string, opId: string, result: ApplyResult): AckFrame {
  return {
    v: PROTOCOL_VERSION,
    t: FRAME.ack,
    id: opId,
    opId,
    to,
    ok: result.ok ? 1 : 0,
    ...(result.ok ? (result.rowId !== undefined ? { rowId: result.rowId } : {}) : { reason: result.reason }),
  };
}

/** 一条流事件。text / round 按需带上（不带就是不带，不塞 undefined）。 */
export function chatEvFor(
  to: string,
  turnId: string,
  kind: ChatEvKind,
  extra: { text?: string; round?: number } = {},
): ChatEvFrame {
  return {
    v: PROTOCOL_VERSION,
    t: FRAME.chatEv,
    id: turnId,
    to,
    turnId,
    kind,
    ...(extra.text !== undefined ? { text: extra.text } : {}),
    ...(extra.round !== undefined ? { round: extra.round } : {}),
  };
}

/** 题卡 / 图卡：工具闭包旁路推出来的，不在流里。 */
export function chatCardFor(to: string, turnId: string, kind: 'quiz' | 'widget', payload: unknown): ChatCardFrame {
  return { v: PROTOCOL_VERSION, t: FRAME.chatCard, id: turnId, to, turnId, kind, payload };
}

/** 一轮结束。reasoning / 耗时 / 两张卡都随这条发（来宾据此渲染，且自己不落库）。 */
export function chatDoneFor(to: string, turnId: string, res: QaRunResult): ChatDoneFrame {
  return {
    v: PROTOCOL_VERSION,
    t: FRAME.chatDone,
    id: turnId,
    to,
    turnId,
    content: res.content,
    ...(res.reasoning ? { reasoning: res.reasoning } : {}),
    ...(res.reasoningMs !== undefined ? { reasoningMs: res.reasoningMs } : {}),
    ...(res.quiz ? { quiz: res.quiz } : {}),
    ...(res.widget ? { widget: res.widget } : {}),
  };
}

/**
 * 这一轮失败了。
 *
 * **失败不落库**：照搬 ChatPanel 的语义 —— 面板那边也是把错误渲染成一条错误气泡，
 * 不写进 db.chats。这里同理：主机自己的聊天记录不该被链路上的一次网络抖动塞满错误噪音
 * （而那些行会进下一次的历史预算，把真正有用的问答挤出去）。设计 §3.1 的「也要落库成
 * 一条 assistant」说的是 host 自己的 UI 兜底责任，不是来宾这一帧的责任。
 */
export function chatErrFor(to: string, turnId: string, err: unknown): ChatErrFrame {
  const message = err instanceof Error ? err.message : String(err);
  return { v: PROTOCOL_VERSION, t: FRAME.chatErr, id: turnId, to, turnId, message };
}

/**
 * 护栏停因的一句话（chat.ev kind:'stop' 的 text）。
 *
 * 只做**一行流式提示**：来宾面板看到它就知道「不是在生成了，是在收尾」，而最终文案以
 * chat.done 的 content 为准（那条走 noAnswerNotice 那套措辞）。所以这里刻意不复述
 * `noAnswerNotice` 的文案 —— 同一件事两份措辞必然漂移。
 */
function stopLineText(info: { reason: string; rounds: number }): string {
  const reasonText =
    info.reason === 'rounds'
      ? '到轮次上限'
      : info.reason === 'loop'
        ? '工具调用重复'
        : info.reason === 'tokens'
          ? '超出 token 预算'
          : info.reason === 'empty'
            ? '模型没答上来'
            : '出错停下';
  return `第 ${info.rounds} 轮停下：${reasonText}`;
}

/**
 * runQa 的 sink → 一串 chat.* 帧。**问答逻辑一个字都不在这里**：提示词、工具白名单、
 * 历史预算、落库全在 qaRunner 里（与播放页问答面板共用同一份，见 qaRunner 文件头）。
 * 这一层只做「回调 → 帧」的形状映射。
 *
 * `isMaterial` 现在由调用方**按课程行推导**（见 handleChatReq 的「材料形态」），
 * 默认值只留给单测与将来的其它调用点。P2 刚接线时这里是写死 false 的，那是一处**静默
 * 错误**：来宾问材料课时主机跑的是视频课的提示词与工具集，界面上不报错、模型照常回答，
 * 只是答的不是这节课的东西（用户看到「正在检索字幕…」而库里是页码，检索工具也选错）。
 * 这类 bug 只在「问材料课」时才撞得上，所以下面 handleChatReq 里把这行钉住了。
 */
export function chatSinkFor(
  to: string,
  turnId: string,
  send: (frame: Frame) => void,
  signal: AbortSignal,
  isMaterial = false,
): QaSink {
  return {
    onReasoning: (text) => send(chatEvFor(to, turnId, 'reasoning', { text })),
    onDelta: (text) => send(chatEvFor(to, turnId, 'delta', { text })),
    onRoundStart: (round) => send(chatEvFor(to, turnId, 'round', { round })),
    onToolStart: (name, argsJson) => send(chatEvFor(to, turnId, 'tool', { text: qaToolHint(name, argsJson, isMaterial) })),
    onStop: (info) => send(chatEvFor(to, turnId, 'stop', { text: stopLineText(info) })),
    onCard: (card) =>
      send(
        card.kind === 'quiz'
          ? chatCardFor(to, turnId, 'quiz', card.quiz)
          : chatCardFor(to, turnId, 'widget', card.widget),
      ),
    signal,
  };
}

/**
 * 远端帧里的 images → runQa 的 ContentPart[]。
 *
 * 远端数据不可信，**逐项过白名单**：只放行 image_url 且 url 是字符串的项，其余丢掉。
 * 放过去的畸形项会在 `fetch` 的 body 序列化里变成一个 model 不认识的结构，症状是
 * 「来宾提问时报 400」而主机日志里看不出是哪来的图。P2 的来宾镜像页本来也没有截图入口
 * （设计非目标），所以正常路径下这个数组恒为空 —— 留着它是为了将来接截图时不用改协议。
 */
function sanitizeImages(raw: unknown): ContentPart[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ContentPart[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const p = item as { type?: unknown; image_url?: { url?: unknown } };
    if (p.type !== 'image_url') continue;
    const url = p.image_url?.url;
    if (typeof url !== 'string' || !url) continue;
    out.push({ type: 'image_url', image_url: { url } });
  }
  return out.length > 0 ? out : undefined;
}

// ───────────────────────── 事件 ─────────────────────────

/** 一轮问答的状态。`state` 的五个值分别是：开始 / 正常收工 / 出错 / 被停止 / 没跑（主人已停或来宾已走）。 */
export interface HostTurnInfo {
  turnId: string;
  /** 发起这一轮的来宾 hello id */
  guestId: string;
  state: 'start' | 'done' | 'error' | 'stopped' | 'skipped';
}

export interface HostEvents {
  onGuests(guests: { id: string }[]): void;
  onStatus(s: 'connecting' | 'online' | 'off'): void;
  onError(msg: string): void;
  /**
   * 问答轮次状态（可选；不给就不调）。
   *
   * 用途：共享条上显示「某台设备正在提问…」，以及来宾按停时把那条提示收掉。**不接也不影响
   * 任何数据流** —— 它只是给 UI 的一根信号线：host 上问答在跑，界面上什么都不显示的话，
   * 用户会以为「点了没反应」，而链路其实正在流。
   */
  onTurn?(info: HostTurnInfo): void;
  /**
   * 写面 op 的待确认条数（可选；不给就不调）。用途：共享条上显示「N 条操作待确认」。
   * 与 guest 侧的「N 条待补发」是一对镜像信号（那条是来宾知道自己发了几条没确认，这条是
   * 主机知道自己还欠几个回执），两边都显示才查得出「到底卡在发送还是卡在落库」。
   */
  onOps?(pending: number): void;
}

/** 在席来宾的一条记录。`seenAt` 是「最近一次见到它」的时刻（hello 或任何带 from 的帧）。 */
interface GuestEntry {
  id: string;
  seenAt: number;
}

/** 一轮正在跑的问答。注册表是 `chat.stop` 那条 op 找 AbortController 的唯一途径。 */
interface ActiveTurn {
  controller: AbortController;
  /** 发起者来宾 id：bye 时按它停轮（一台设备走了就不该替它白花模型的钱） */
  guestId: string;
}

// ───────────────────────── HostCore：帧编排（无 socket） ─────────────────────────

/**
 * host 需要的一切「出向动作」。刻意只有三条：帧编排层不该知道 socket 的存在。
 *
 * - `send` / `sendBinary` 的实现方自己判连接状态（LiveHost 判 readyState），所以 core
 *   可以在连接已经断了的情况下继续跑逻辑 —— 那正是 `handleVideoRange` 等 await 之后必须
 *   做到的事（socket 可能在读盘期间被关掉）。
 * - `close` 只在版本不匹配时用（CLOSE_PROTOCOL_MISMATCH）。
 */
export interface HostCoreDeps {
  send(frame: Frame): void;
  sendBinary(rid: number, seq: number, payload: Uint8Array): void;
  close(code: number): void;
  events: HostEvents;
}

/**
 * host 的全部帧编排：解帧 → 路由 → 组帧 → 出向动作。
 *
 * 状态只有四张表（都是进程内的，socket 一断就重建，与 P1 一致）：
 * - `guests`：在席来宾（`from` 的白名单 + 共享条上的计数）；
 * - `ops`：写 op 的**单例**串行队列 + 它自带的去重表（`study.add` 的准入条件，见 ops.ts）；
 * - `turns`：在跑的问答轮次（`chat.stop` 找 AbortController 的地方）；
 * - `ackTarget`：opId → 目标来宾（onAck 只拿到 opId，回执要定向就得自己记着，见 sendAck）。
 */
export class HostCore {
  private deps: HostCoreDeps;
  /** 在席 guest：键就是 hello 帧的 id。同 id 重连会覆盖旧条目（计数不变） */
  private guests = new Map<string, GuestEntry>();
  /** 墓碑表：被剪掉的在席条目（id → 剪掉时刻），用来给「还在用」的设备自动复活，见 admitGuest */
  private revived = new Map<string, number>();
  /** 已发放且未归还的读盘名额数（含排队等名额的请求），见 waitRangeSlot */
  private rangeSlots = 0;
  /** 等名额的 FIFO 队列：resolve = 轮到你了。见文件头取舍 2。 */
  private rangeQueue: (() => void)[] = [];
  private stopped = false;
  /** 单元 rid 游标，初值与理由见 rid()。 */
  private ridSeq = 0x80000000;
  /** 写 op 队列。**整个 host 生命周期一个实例**（理由见构造函数） */
  private ops: OpQueue;
  /** opId → 回执该发给谁。同一个 opId 重发时用 pending 计数（见 sendAck） */
  private ackTarget = new Map<string, { to: string; pending: number }>();
  /** turnId → 在跑的那一轮 */
  private turns = new Map<string, ActiveTurn>();
  /** 问答全局串行的「在跑」标记 */
  private turnBusy = false;
  /** 问答等待队列（后到的排队，不并发，见 runTurn） */
  private turnQueue: (() => void)[] = [];

  constructor(deps: HostCoreDeps) {
    this.deps = deps;
    this.ops = new OpQueue({
      /**
       * 去重表挂在 host 实例上（而不是让 OpQueue 懒建）：`study.add` 重放一次就多记一段
       * 学习时长，而界面完全看不出异常 —— 去重表是它的**准入条件**（不变量 3）。每收一帧
       * 新建一条队列 = 每帧一张空表，去重彻底失效。
       */
      dedup: createLruDedup(),
      turnAbort: (turnId) => this.turns.get(turnId)?.controller,
    });
    this.ops.onAck = (opId, result) => this.sendAck(opId, result);
  }

  /** host 重新连上中继：清掉上次下线留下的标记（socket 断开也会走 shutdown，见 LiveHost.onclose） */
  resume(): void {
    this.stopped = false;
  }

  /**
   * 主人停共享 / socket 断开：清席、停轮。
   *
   * 停轮（abort 所有在跑的问答）不是为了省模型调用而加的，是**正确性**：一轮问答的历史是
   * 按 `sortBy(createdAt)` + `slice(0, -1)` 取的（qaRunner），而共享已经停了，继续跑下去
   * 只会把一条没人收的答案写进主机自己的聊天记录。
   */
  shutdown(): void {
    this.stopped = true;
    this.guests.clear();
    this.revived.clear();
    this.deps.events.onGuests([]);
    this.abortTurns();
  }

  // ── 入向：一条消息 → 路由 ──────────────────────────────────────────────────

  /**
   * 一条入站消息的唯一入口（LiveHost 的 onmessage 调它）。非文本帧（P1/P2 都不收）安静忽略。
   */
  async dispatch(data: unknown): Promise<void> {
    // 二进制帧：P1 host 没有写面 op，guest 也没有发给 host 的二进制。
    // 不解码直接忽略——解出来的 payload 没有消费者，白耗一遍 CPU。
    if (typeof data !== 'string') return;
    const text = data;
    // ① 中继控制帧：host 不消费（它自己就是数据源），认出来是为了别让它掉进后面的解码路径
    if (decodeControlFrame(text)) return;
    // ② 握手：必须宽松解，理由见文件头「P2 的三条入向路径」
    const loose = decodeFrameLoose(text);
    if (loose && loose.frame.t === FRAME.hello) {
      this.handleHello(loose.version, loose.frame.id);
      return;
    }
    // ③ 其余一律严格解
    const f = decodeFrame(text);
    if (!f) return; // 坏帧跳过，不杀链路（protocol.ts 的约定）
    await this.dispatchFrame(f);
  }

  private async dispatchFrame(f: Frame): Promise<void> {
    switch (f.t) {
      case FRAME.indexReq: {
        const rows = await db.videos.orderBy('createdAt').toArray();
        this.deps.send({ v: PROTOCOL_VERSION, t: FRAME.indexRes, id: f.id, courses: buildIndex(rows) });
        return;
      }
      case FRAME.unitReq:
        await this.handleUnitReq(f);
        return;
      case FRAME.videoOpen:
        await this.handleVideoOpen(f);
        return;
      case FRAME.videoRange:
        await this.handleVideoRange(f);
        return;
      case FRAME.op:
        await this.handleOp(f);
        return;
      case FRAME.chatReq:
        await this.handleChatReq(f);
        return;
      case FRAME.bye:
        this.handleBye(String(f.id));
        return;
      default:
        // 不认识的类型安静跳过（P1 的既有约定）：把收到的帧写进 host 的业务面，
        // 等于让它对远端传什么都要有反应，那正是「一帧坏数据打崩整条链路」的来路。
        return;
    }
  }

  /**
   * 握手：版本对得上才进席，版本对不上直接关连接。
   *
   * **不发 version.err**（尽管 protocol.ts 还留着那个构造器与帧型）：一个已发布的老来宾用
   * 自己的 decodeFrame 严格解 v，它连这一帧都解不出来 —— 发了是给空气发消息。
   * **也不借用中继的 4000 / 4001 / 4403**：那三个文案都是具体事实（房间回收 / 配对码不存在
   * / 配对限流），拿它们关一个版本不匹配的连接等于给用户一条假的解释（他会去换配对链接、
   * 让主机重开共享，那些动作对版本差一点用都没有），回来后只会再来一遍。
   * 两条取舍的完整理由见 protocol.ts 的 CLOSE_PROTOCOL_MISMATCH。
   */
  private handleHello(version: number, id: string): void {
    const check = versionCheck(version);
    if (!check.ok) {
      this.deps.close(CLOSE_PROTOCOL_MISMATCH);
      return;
    }
    // 空 id 不能进表：它会成为万能 from（谁都能拿它路由回帧），而 hello 的 id 来自远端
    if (!id) return;
    this.pruneIdleGuests();
    this.guests.set(id, { id, seenAt: Date.now() });
    this.publishGuests();
    this.deps.send(welcomeFrame(id));
  }

  private handleBye(id: string): void {
    if (this.guests.delete(id)) this.publishGuests();
    // 走了就别替它跑完这一轮（见 shutdown 里那句正确性理由）
    this.abortTurnsOf(id);
  }

  // ── 写面 op ────────────────────────────────────────────────────────────────

  /**
   * 一条写 op：进串行队列，回执**定向**回给 `from`。
   *
   * `from` 不在席 → 不 apply、不 ack（理由见 protocol.ts 的 op.from）。这里必须拒而不是
   * 「先做再说」：ack 是路由，而路由的身份是来宾自报的，不查表等于任何一台在席设备都能
   * 把回执引到自己那儿。
   */
  private async handleOp(f: Frame): Promise<void> {
    const from = String(f.from ?? '');
    const opId = String(f.opId ?? '');
    if (!this.admitGuest(from)) {
      console.warn('[live-host] 拒收来路不明的 op（from 不在席）：', opId, from);
      return;
    }
    // 没有 opId 就没法回执、也没法去重：坏帧直接丢（来宾侧有超时与重发兜底）
    if (!opId) return;
    const rec = this.ackTarget.get(opId);
    if (rec) {
      // 同一个 opId 又来了（断链重发）：记一次 pending，回执才会一条不漏（见 sendAck）
      rec.pending++;
      // 表异常膨胀（ack 一直没回来）时淘汰最早的：按插入序取头就是最旧
      if (this.ackTarget.size > MAX_ACK_TARGETS) {
        const oldest = this.ackTarget.keys().next();
        if (!oldest.done) this.ackTarget.delete(oldest.value);
      }
    } else {
      this.ackTarget.set(opId, { to: from, pending: 1 });
    }
    // 入队**之前**先报一次：UI 要看到的是「已经欠了一个回执」，而不是等落库跑完才亮
    this.reportOps();
    // 不管 apply 成功还是失败，enqueue 都会 resolve（链尾吞异常），所以这里不需要 try
    await this.ops.enqueue({ clientOpId: opId, name: String(f.op) as OpName, args: f.args });
    this.reportOps();
  }

  /**
   * 一条 op 的回执。`OpQueue.onAck` 只给 opId，回执要发给谁得自己记着（ackTarget）。
   *
   * **pending 计数的意义**：来宾重发时两条同 opId 的 op 会在队列里排着，回执必须一条一条
   * 回（漏掉一条，那台来宾的 outbox 会一直留着它重发到配额用尽）。先记 2、回 1 条、
   * 再回 1 条，删表 —— 而不是「第一次回执就把表删了」，那样第二条无家可归、静默丢掉。
   */
  private sendAck(opId: string, result: ApplyResult): void {
    const rec = this.ackTarget.get(opId);
    if (!rec) {
      // 到不了这条（入队必先记表），但真到了就说明表被异常淘汰了：记一条 warn。
      // 静默丢回执的后果是来宾那边无限重发，而主机这边看起来一切正常。
      console.warn('[live-host] ack 找不到目标来宾：', opId);
      return;
    }
    rec.pending--;
    if (rec.pending <= 0) this.ackTarget.delete(opId);
    this.deps.send(ackFrameFor(rec.to, opId, result));
    this.reportOps();
  }

  // ── 问答 ──────────────────────────────────────────────────────────────────

  /**
   * 一轮问答：`chat.req` → runQa → 流式回**同一台**来宾。
   *
   * **这一层不含任何问答逻辑**：提示词、工具白名单、历史预算、卡片旁路、落库全在
   * qaRunner 里（与播放页问答面板同一个函数、同一份提示词 —— 见 qaRunner 文件头「为什么是
   * 抽出来而不是复制一份」）。这里只做三件事：解出输入、把 sink 映射成 chat.* 帧、收尾。
   */
  private async handleChatReq(f: Frame): Promise<void> {
    const from = String(f.from ?? '');
    const turnId = String(f.turnId ?? '');
    const videoId = String(f.videoId ?? '');
    const text = String(f.text ?? '');
    // 与 op 同一条纪律：来路不明的一律不接（否则两台设备能互相触发对方的会话）
    if (!this.admitGuest(from)) {
      console.warn('[live-host] 拒收来路不明的 chat.req：', turnId, from);
      return;
    }
    // 坏帧不回错误帧：来宾自己也有超时与失败态，凭空多一帧 chat.err 只会让它显示一句
    // 用户看不懂的话（缺 turnId 连回执都不知道该往哪回）
    if (!turnId || !videoId || !text.trim()) return;
    // 同一个 turnId 又来一次 = 来宾在重发（它没收到这一轮的流）。再跑一遍等于花钱问两次
    if (this.turns.has(turnId)) return;

    const turn: ActiveTurn = { controller: new AbortController(), guestId: from };
    this.turns.set(turnId, turn);
    this.deps.events.onTurn?.({ turnId, guestId: from, state: 'start' });

    // 注册表在**入队之前**就填好：排在后面的那一轮也要能被 chat.stop 停掉（否则用户按了
    // 停止，而那一轮还没开始跑，于是「停止」按了个寂寞，它照样跑完并写进主机历史）
    await this.runTurn(async () => {
      // 等到它的时候主人已经停了共享、或发起它的那台已经 bye：不白跑一轮
      if (this.stopped || !this.guests.has(from)) {
        this.deps.events.onTurn?.({ turnId, guestId: from, state: 'skipped' });
        return;
      }
      try {
        // 课程行先取出来，后面两件事都要用：会话归属（挂着不存在的 videoId 的会话永远
        // 检索不到内容）与材料形态。**不存在就明说，别拿默认的视频课语义往下跑** ——
        // 那样模型会拿视频课的提示词去答一门根本不存在的课，答完还落库，主机自己的聊天
        // 记录里就多一条查无出处的对话。
        const row = await this.loadCourse(videoId);
        if (!row) {
          this.deps.send(chatErrFor(from, turnId, new Error('这门课不在主机的库里')));
          return;
        }
        const sessionId = await this.resolveSessionId(row);
        const images = sanitizeImages(f.images);
        /**
         * 材料形态：qaRunner 用 `materialKind !== undefined` 判「这是不是材料课」，
         * 并据此换掉整条系统提示词与整份工具白名单（页码语义 + search_material，
         * 而不是时间戳语义 + search_transcript）。
         *
         * ⚠️ 这一段是**静默错误的守门处**：推导错了不会报任何错，模型照常回答，只是答的
         * 不是这节课的东西（用户看到「正在检索字幕…」而库里是页码；模型调的是
         * search_transcript，而这份材料的检索索引在 materialBlocks 里，于是它什么都搜
         * 不到，只能靠自己的通用知识编一个看着很像的答案）。这类 bug 只在「来宾问材料课」
         * 时才撞得上，所以推导口径必须与播放页问答面板一致（qaRunner 是共用的，提示词
         * 只有一份）。
         *
         * `materialFormat` 缺失的老数据按 `'pdf'` 走页码口径：与 Player.tsx / LiveGuest
         * 传给 ChatPanel 的那个内联判据（`format === 'pdf' || !format ? 'page' : 'para'`）
         * 逐字一致。unitKindOf 只管四种格式之间的映射，undefined 不是格式 ——「缺字段
         * 算哪种」是调用方的口径问题，不该悄悄塞进那张映射表里（塞进去就等于让所有调用
         * 点共用一个没人验证过的默认）。
         */
        const isMaterial = row.kind === 'material';
        const res = await runQa(
          {
            videoId,
            sessionId,
            text,
            videoName: row.name,
            ...(isMaterial
              ? {
                  materialKind: unitKindOf(row.materialFormat ?? 'pdf'),
                  ...(row.materialFormat ? { materialFormat: row.materialFormat } : {}),
                }
              : {}),
            ...(images ? { images } : {}),
          },
          chatSinkFor(from, turnId, (frame) => this.deps.send(frame), turn.controller.signal, isMaterial),
        );
        this.deps.send(chatDoneFor(from, turnId, res));
        this.deps.events.onTurn?.({ turnId, guestId: from, state: 'done' });
      } catch (err) {
        if (turn.controller.signal.aborted) {
          // runQa 自己消化 abort（返回「已停止生成」那条并落库），能抛到这里只可能是中止
          // 发生在它的 catch 之外（例如落库那步被中止）。照样按「已停止」收尾，别报成失败。
          this.deps.send(chatDoneFor(from, turnId, { content: '_（已停止生成）_' }));
          this.deps.events.onTurn?.({ turnId, guestId: from, state: 'stopped' });
        } else {
          // 真错误：只发 chat.err、**不落库**（见 chatErrFor 的注释）
          console.warn('[live-host] 问答失败：', err);
          this.deps.send(chatErrFor(from, turnId, err));
          this.deps.events.onTurn?.({ turnId, guestId: from, state: 'error' });
        }
      }
    });
    // 出队即注销：注册表只装「在跑或在等」的轮次。漏删的后果是表只增不减，而且同一 turnId
    // 的重发会被上面那道 turns.has 判成重复 —— 那一轮永远不会再跑，来宾干等到超时
    this.turns.delete(turnId);
  }

  /**
   * 问答**全局串行**：host 一次只跑一轮，后到的排队。
   *
   * 为什么不是「并发跑」：qaRunner 取历史的方式是 `sortBy('createdAt')` + `slice(0, -1)`，
   * 把刚落库的那一条当成本轮问题（Task 4 的报告把它列为最高风险）。并发跑同一会话的两轮
   * 时，A 轮 slice 掉的「末条」可能是 B 轮刚落的 user 行 —— 于是 A 拿到 B 的问题当历史末条、
   * 把自己的问题重复发了一遍，而两端都看不见任何异常：模型答非所问，界面上只是一句答得
   * 莫名其妙的回答。串行是唯一不用给历史加事务/版本号就正确的做法（与 ops.ts 的写队列同理，
   * 那里是 lost update，这里是历史串味）。
   *
   * 代价是两台设备同时提问要排队 —— 这是有意的：agent loop 本来就是分钟级的重型操作，
   * 并发只会让两个回答都变慢，而顺序执行还能让主机这一侧的历史保持一个确定的顺序。
   */
  private async runTurn(job: () => Promise<void>): Promise<void> {
    if (this.turnBusy) await new Promise<void>((resolve) => this.turnQueue.push(resolve));
    this.turnBusy = true;
    try {
      await job();
    } finally {
      // 名额直接移交给队首（计数不变）；没人等才置回空闲
      const next = this.turnQueue.shift();
      if (next) next();
      else this.turnBusy = false;
    }
  }

  /**
   * 课程行。**来宾可能传脏 videoId**（旧链路的镜像、手输的 URL、竞态的课程行已删），
   * 所以这里显式给「找不到」一条路：调用方据此回 chat.err，而不是拿默认值硬跑 ——
   * 见 handleChatReq 里那段注释（跑错语义不报错，答出来的答案是错的）。
   */
  private async loadCourse(videoId: string): Promise<VideoRow | null> {
    return (await db.videos.get(videoId)) ?? null;
  }

  /**
   * 这一轮该写进哪个会话。
   *
   * 来宾不带 sessionId（P2 没有「会话切换」入口，来宾镜像页只有一条会话流），所以取该课
   * **最近一个**会话，没有就建一个 —— 与 ChatPanel 初始化那段（sessions 列表为空就建
   * 「新会话」、默认激活最后一个）是同一套口径，否则来宾的提问会散进另一个会话里。
   *
   * **收行而不是收 videoId**：课程存不存在由调用方（loadCourse）判，那里还要拿同一行推导
   * 材料形态。判一次、读一次，别在这里再 get 一遍 —— 两次读之间课程行可能已经被删，
   * 于是「判存在 → 建会话 → 挂着一个没有课程的会话 id」这种不一致只在并发窗口里出现。
   */
  private async resolveSessionId(row: VideoRow): Promise<number> {
    const list = await db.chatSessions.where('videoId').equals(row.id).sortBy('createdAt');
    const last = list[list.length - 1];
    if (last?.id != null) return last.id;
    return (await db.chatSessions.add({ videoId: row.id, title: '来宾会话', createdAt: Date.now() })) as number;
  }

  /** 停掉某台设备发起的所有在跑轮次（bye / 主线断开时） */
  private abortTurnsOf(guestId: string): void {
    for (const [turnId, turn] of this.turns) {
      if (turn.guestId !== guestId) continue;
      turn.controller.abort();
      this.deps.events.onTurn?.({ turnId, guestId, state: 'stopped' });
    }
  }

  /** 停掉所有在跑轮次（共享已停） */
  private abortTurns(): void {
    for (const [turnId, turn] of this.turns) {
      turn.controller.abort();
      this.deps.events.onTurn?.({ turnId, guestId: turn.guestId, state: 'stopped' });
    }
    this.turns.clear();
  }

  // ── 在席表 ────────────────────────────────────────────────────────────────

  /**
   * `from` 是不是一台我们认识的来宾。认识就顺手刷新 `seenAt`（它在用）。
   *
   * **剪掉的条目在宽限内自动复活**：剪枝（见 pruneIdleGuests）只为让「N 台设备已连接」这个
   * 数字说实话；一台剪掉之后还在发帧的设备是**真的还连着**，把它当来路不明拒掉的后果是
   * 「iPad 上的进度条再也不动了，回执也永远不来」—— 而界面上没有任何异常可看。所以这里
   * 在墓碑表里认出来就让它回席。墓碑表里只会出现真 hello 过的 id，所以复活不削弱
   * 「`from` 必须在席」这道校验（凭空造一个 id 依然进不来）。
   */
  private admitGuest(id: string): boolean {
    if (!id) return false;
    const hit = this.guests.get(id);
    if (hit) {
      hit.seenAt = Date.now();
      return true;
    }
    const prunedAt = this.revived.get(id);
    if (prunedAt === undefined || Date.now() - prunedAt > GUEST_REVIVE_MS) return false;
    this.revived.delete(id);
    this.guests.set(id, { id, seenAt: Date.now() });
    this.publishGuests();
    return true;
  }

  /**
   * 一次 hello 就剪一次长期静默的条目 + 超长就淘汰最旧的。
   *
   * **为什么 host 这张表天生只会增**：中继只按 role 转发，guest 掉线时它不通知 host
   * （host-link-down/up 是反方向的、给 guest 看的），而 hello id 是**每连接换一个**的
   * （guest.ts 的 guestId），所以「这台设备刷新了一下页面」在 host 这边就是「多了一台」。
   * 三层处置各自挡的东西不同：
   *
   * 1. `bye` 精确删（P1 已有；guest 在 pagehide 会尽力补一条，见 LiveGuest）；
   * 2. 本方法：静默超过 GUEST_IDLE_MS 的剪掉 —— 挡「一台设备开着页面忘了关，隔天另一台连上」；
   * 3. 长度上限：超了淘汰最久没见到的那条 —— 挡「短时间内反复重连把表撑爆」。
   *
   * ⚠️ 真正的根治在 guest 侧：hello id 存进 sessionStorage，刷新/重连仍是同一个 id，走的
   * 就是「覆盖同一条目」而不是「新增一条」（Task 6 接线时钉这条）。host 侧拿不到「谁还在」
   * 这个事实，只能给有界近似 —— 这也是为什么剪掉的条目要留墓碑（见 admitGuest）。
   */
  private pruneIdleGuests(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, g] of this.guests) {
      if (now - g.seenAt <= GUEST_IDLE_MS) continue;
      this.guests.delete(id);
      this.rememberPruned(id, now);
      changed = true;
    }
    // 超长淘汰最久没见到的那条：真在用的设备 seenAt 是新的，会被留到最后
    while (this.guests.size > MAX_GUESTS) {
      let oldestId: string | undefined;
      let oldestAt = Infinity;
      for (const [id, g] of this.guests) {
        if (g.seenAt < oldestAt) {
          oldestAt = g.seenAt;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      this.guests.delete(oldestId);
      this.rememberPruned(oldestId, now);
      changed = true;
    }
    if (changed) this.publishGuests();
  }

  /** 记一条墓碑（只进不出的表也得有界：满了从头淘汰，Map 的插入序就是热度序） */
  private rememberPruned(id: string, at: number): void {
    this.revived.delete(id);
    this.revived.set(id, at);
    while (this.revived.size > MAX_REVIVED) {
      const oldest = this.revived.keys().next();
      if (oldest.done) break;
      this.revived.delete(oldest.value);
    }
  }

  private publishGuests(): void {
    this.deps.events.onGuests([...this.guests.values()]);
  }

  /** 待确认 op 条数 = 队列里排着的 + 正在跑的那条（OpQueue 的 depth 不含在跑的那条） */
  private reportOps(): void {
    if (!this.deps.events.onOps) return;
    this.deps.events.onOps(this.ops.depth + (this.ops.busy ? 1 : 0));
  }

  // ── P1 读面（原样搬过来，只把 this.send 换成 this.deps.send） ─────────────────

  private async handleUnitReq(f: Frame): Promise<void> {
    const reqId = f.id;
    const rid = this.rid();
    const parsed = parseVideoUnit(String(f.unit));
    if (!parsed) {
      this.deps.send({ v: PROTOCOL_VERSION, t: FRAME.unitErr, id: reqId, reason: 'unsupported-unit' });
      return;
    }
    if (parsed.suffix === 'meta') {
      const row = await db.videos.get(parsed.id);
      if (!row) {
        this.deps.send({ v: PROTOCOL_VERSION, t: FRAME.unitErr, id: reqId, reason: 'not-found' });
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
        this.deps.send({ v: PROTOCOL_VERSION, t: FRAME.unitErr, id: reqId, reason: 'not-found' });
        return;
      }
      this.sendUnit(reqId, rid, await coverUnitFromBlob(cover));
      return;
    }
    if (parsed.suffix === 'cards') {
      /**
       * 制卡候选（P2）。来宾审核要用的就是这张表，只发待审的行（理由见 payloads.ts）。
       *
       * `sortBy('time')` 而不是 `toArray()`：后者按主键（自增 id）排序，那是**生成顺序**，
       * 而 SwipeDeck 的 props 契约是「按时间排序」（卡片带考点时间，审核顺序应当跟着时间
       * 走）。生成顺序与时间顺序在正常情况下恰好一致，但一旦重跑制卡 / 改过 time，两者
       * 就会分叉 —— 来宾那侧的审核次序与主机面板不一致，而两边都没有任何提示。
       *
       * 课程行不存在时这里发的是**空载荷**而不是 unit.err：来宾拿到的 `cards: []` 会显示
       * 「没有待审核的卡片」，而 unit.err 会让它挂到 30s 超时（guest.ts 的 onUnitErr
       * 一律 reject）。「这门课没卡」与「这门课不存在」在来宾那里是同一个可接受的结果，
       * 没有任何动作可做 —— 差别只对排障有意义，而 cards 单元不携带判别它所需的信息。
       */
      const rows = await db.cards.where('videoId').equals(parsed.id).sortBy('time');
      this.sendUnit(reqId, rid, buildCardsUnit(parsed.id, rows));
      return;
    }
    // vectors / frames 等 P1 不拉的单元：明说 unsupported，别让 guest 干等超时
    this.deps.send({ v: PROTOCOL_VERSION, t: FRAME.unitErr, id: reqId, reason: 'unsupported-unit' });
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
    this.deps.send({ v: PROTOCOL_VERSION, t: FRAME.unitRes, id: reqId, rid, parts: parts.length, len: bytes.byteLength });
    for (let i = 0; i < parts.length; i++) this.deps.sendBinary(rid, i, parts[i]);
  }

  private async handleVideoOpen(f: Frame): Promise<void> {
    const videoId = String(f.videoId);
    const row = await db.videos.get(videoId);
    // 四级拒绝，逐级说清原因（guest 直接把 reason 显示给用户）：
    if (!row) {
      this.deps.send({ v: PROTOCOL_VERSION, t: FRAME.videoMeta, id: f.id, ok: false, reason: 'not-found' });
      return;
    }
    if (row.fileDeleted === 1) {
      this.deps.send({ v: PROTOCOL_VERSION, t: FRAME.videoMeta, id: f.id, ok: false, reason: 'file-deleted' });
      return;
    }
    if (!DIRECT_CONTAINERS.includes(row.mimeType)) {
      this.deps.send({
        v: PROTOCOL_VERSION,
        t: FRAME.videoMeta,
        id: f.id,
        ok: false,
        reason: 'unsupported-container',
        mime: row.mimeType,
      });
      return;
    }
    const file = await getCourseFile(videoId);
    if (!file) {
      this.deps.send({ v: PROTOCOL_VERSION, t: FRAME.videoMeta, id: f.id, ok: false, reason: 'file-missing' });
      return;
    }
    // size 以 OPFS 里的真文件为准：行上的 size 是导入时记的元数据，两者理论上会漂
    this.deps.send({ v: PROTOCOL_VERSION, t: FRAME.videoMeta, id: f.id, ok: true, size: file.size, mime: row.mimeType });
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
        this.deps.sendBinary(rid, start, payload);
        return;
      }
      // len 入口已钳到 RANGE_CHUNK，这里至多一片；循环保留是防入口将来放宽时
      // 静默发出超大帧（relay 与浏览器都有单帧上限，超限的表现是整帧消失）。
      for (let off = 0; off < payload.byteLength; off += RANGE_CHUNK) {
        this.deps.sendBinary(rid, start + off, payload.subarray(off, Math.min(payload.byteLength, off + RANGE_CHUNK)));
      }
    } finally {
      this.releaseRangeSlot();
    }
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
}

// ───────────────────────── LiveHost：socket 那一层 ─────────────────────────

/**
 * host 的 IO 壳：起/停 WebSocket、把核心的三条出向动作接到 socket 上。
 *
 * 帧编排全在 HostCore（可单测），这里只剩「什么时候发、连接没开时怎么办」。**不自己判
 * 帧**：再判一遍就等于两套路由表，那是最容易漂移的地方（改一处忘一处的症状是某类帧
 * 静默不工作了）。
 */
export class LiveHost {
  private ws: WebSocket | null = null;
  private core: HostCore;
  private relayUrl: string;
  private code: string;
  private events: HostEvents;
  private stopped = false;

  // 显式字段而不是构造器参数属性（ops.ts 的同一纪律：Node 的类型剥离不支持参数属性）。
  // P1 那版写的是参数属性，这里顺带改掉是因为拆完之后这一层是要被 Node 直接 import 的
  constructor(opts: { relayUrl: string; code: string; events: HostEvents }) {
    this.relayUrl = opts.relayUrl;
    this.code = opts.code;
    this.events = opts.events;
    this.core = new HostCore({
      send: (frame) => this.send(frame),
      sendBinary: (rid, seq, payload) => this.sendBinary(rid, seq, payload),
      // close 走这一层：core 只知道「版本不匹配，该关连接了」，不碰 socket API
      close: (code) => this.ws?.close(code),
      events: opts.events,
    });
  }

  start(): void {
    this.stopped = false;
    this.core.resume();
    this.events.onStatus('connecting');
    const url = `${this.relayUrl}?room=${encodeURIComponent(this.code)}&role=host`;
    const ws = new WebSocket(url);
    this.ws = ws;
    // 必须显式设：默认的 'blob' 会让二进制帧以 Blob 到达，protocol.ts 的
    // decodeBinaryFrame 对非 ArrayBuffer 一律返 null——链路像死了一样但
    // 没有任何报错。P1 host 不收二进制，这行是 defense in depth（Task 6
    // 的 guest 侧同理，且它是真要收二进制的那一端）。
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.events.onStatus('online');
    ws.onclose = () => {
      this.ws = null;
      // 在席清空 + 在跑的问答停掉：共享已经断了，这一层的状态不能留着假装还在
      this.core.shutdown();
      // 只有被动断（中继挂了 / 网络抖了）才广播 off；stop() 里已经置过 off，
      // 这里再置一次会让 Task 5 的 store 无谓重渲染。
      if (!this.stopped) this.events.onStatus('off');
    };
    ws.onerror = () => this.events.onError('中继连接失败，检查中继地址');
    ws.onmessage = (e) => {
      // dispatch 是 async：读库 / 读盘 / 问答都可能抛。不接这一下，一次坏请求会以
      // unhandledrejection 的面目出现——链路明明是好的，排查时最容易被带偏。
      // 只 console.warn 不升到 onError：单条消息失败不是链路事件（guest 有
      // 自己的超时），升上去会把一次健康的共享打成 error 态。
      void this.core.dispatch(e.data).catch((err) => {
        console.warn('[live-host] 消息处理失败：', err);
      });
    };
  }

  stop(): void {
    this.stopped = true;
    this.core.shutdown();
    this.ws?.close();
    this.ws = null;
    this.events.onStatus('off');
  }

  /**
   * 发一帧。**readyState 守卫在这里而不在 core**：core 的 handler 会跨 await（读库、读盘、
   * 问答），等待期间 socket 完全可能被关掉，而 WebSocket.send 在非 OPEN 状态会抛
   * InvalidStateError —— 那会让一条已经算好的结果变成一次控制台警告。
   */
  private send(frame: Frame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(frame));
  }

  /** 二进制帧直发。与 send 分开就为这个守卫：单元 / range 的响应都跨 await。 */
  private sendBinary(rid: number, seq: number, payload: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeBinaryFrame(rid, seq, payload));
  }
}