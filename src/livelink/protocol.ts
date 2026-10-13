/**
 * 实时链路的协议帧编解码：文本信封、二进制帧头、单元分片、载荷 gzip。
 * host / guest / Cloudflare Worker 三方共用，任何一端单方面改格式都会让对面静默解码失败。
 *
 * ## 版本：P1 的帧格式一个字都没改，只加了新帧型
 *
 * v1 → v2（P2 写面 + 问答流）。P1 的编码、字段名、二进制头全部保持原样，bump 的只有
 * 版本号与新增帧型 —— 这样「哪些是老的、哪些是新的」在协议层是**可判定的**（见
 * decodeFrame / decodeFrameLoose 两条解码路径），而不是靠人记。
 *
 * 中继（cloudflare-worker/live-relay）是另一套部署、不共享本模块，它合成的
 * `host-link-down/up` 两帧把 `v` 写死在源码里 —— **bump 版本时必须同步改中继**，否则
 * guest 会把「主机已离线」那两帧当坏帧丢掉（P2 不变量 6 的反面：静默到用户毫无察觉）。
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
 * 编解码层的坏帧一律返回 null。这条承诺有两个写在明面上的例外，别当成漏网：
 *
 * 1. `decodeUnitPayload`：坏 gzip 会抛异常（fflate 的契约 —— 它不区分「空载荷」和
 *    「乱码」），调用方必须 try/catch。
 * 2. `decodeFrameLoose`：它**故意**接受版本不符的帧（只放宽版本，其它校验一律照旧）。
 *    不是漏掉，是握手的职责，见它的注释。
 */

import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';
import { PART_BYTES } from '../sync/units.ts';
// 只取类型，运行期零依赖（`import type` 在类型剥离与打包时都被整条抹掉）。这样写而不是
// 在这里复制一份 op 名清单：ops.ts 是执行侧的白名单，两份名单必然漂移，而漂移的表现是
// 一帧 op 被回 unknown-op（写面静默丢一条记录，界面上什么都没有）。
import type { OpName } from './ops.ts';

/**
 * 协议版本。不匹配的帧直接拒收，免得旧客户端把新字段当成新类型旧处理。
 *
 * 2 = P2：新增 op / ack 写面与 chat.* 问答流帧，hello 带 clientVersion、welcome 带
 * hostVersion。任何一侧单独 bump 都必须同时 bump 中继（文件头）。
 */
export const PROTOCOL_VERSION = 2;

/**
 * P1 的版本号，**只**在两处用：测试的黄金向量（钉住「P1 的帧格式一个字都没改」）与
 * 「老来宾长什么样」的场景化注释。运行期没有任何地方需要它 —— 版本的比较一律走
 * versionCheck，不要在这里再写一遍 `=== 1`（那才是会漂移的东西）。
 */
export const PROTOCOL_VERSION_V1 = 1;

/** 二进制帧头长度：rid(u32 LE) + seq(f64 LE)。 */
export const BINARY_HEADER_BYTES = 12;

/**
 * 帧类型常量。**P1 的名字也一并列在这里**，因为 host.ts / guest.ts 里那些路由键是裸
 * 字符串：改一端不改另一端的后果不是报错，是那张 switch 里少一个 case、那条功能静静
 * 地不工作了。把全部名字收在一处，两端改同一个键这件事才 Review 得出来。
 *
 * 注意这里**没有** `video.data`：P1 的 range 数据走二进制帧直发（12 字节头 + 载荷），
 * 没有对应的文本帧；别按旧设计稿里的名字凭空补一个。
 */
export const FRAME = {
  // P1 读面 / 控制面
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
  // P2 写面（guest→host 的 op，host→guest 的 ack）
  op: 'op',
  ack: 'ack',
  // P2 问答流
  chatReq: 'chat.req',
  chatEv: 'chat.ev',
  chatCard: 'chat.card',
  chatDone: 'chat.done',
  chatErr: 'chat.err',
  // P2 版本握手
  versionErr: 'version.err',
} as const;

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

// ── P2 帧型（信封 + 载荷）────────────────────────────────────────────────
// 只描述「线上长什么样」，不做字段级校验：那些校验在收帧的一侧（host/guest）按契约逐项
// 对账，因为**只有收帧的一侧知道字段该怎么用**，在这一层校验等于猜。
// 统一 `id` 的语义（来自入队的 reqId / opId / turnId 路由）写在各自注释里。

/** hello（guest→host）。`clientVersion` 是 host 判「要不要回 version.err」的唯一依据。 */
export interface HelloFrame extends Frame {
  t: typeof FRAME.hello;
  clientVersion: number;
}

/** welcome（host→guest）。`hostVersion` 是 guest 侧唯一的判据 —— 别拿信封的 v 当判据。 */
export interface WelcomeFrame extends Frame {
  t: typeof FRAME.welcome;
  hostVersion: number;
}

/** version.err（host→guest）：「我听不懂你」的最后一句话，带上两边的版本号好说人话。 */
export interface VersionErrFrame extends Frame {
  t: typeof FRAME.versionErr;
  host: number;
  you: number;
}

/**
 * op（guest→host）：来宾写面的唯一入口。`opId` 就是 outbox 的 clientOpId，ack 原样回它，
 * `study.add` 还拿它当去重键（ops.ts 的 DedupStore 是准入条件）。
 *
 * `args` **必须是对象且按 op 分形状**，host 侧 dispatch 一律当不可信数据消毒（String/Number）
 * 后再交给 apply。放在 `args` 里而不是摊平到信封上：摊平后新加一个字段就会与
 * `to` / `round` 这类公共字段撞名，而撞名的表现是「参数被隔壁字段覆盖」，不报错。
 */
export interface OpFrame extends Frame {
  t: typeof FRAME.op;
  opId: string;
  op: OpName;
  args: unknown;
}

/**
 * ack（host→guest）：幂等回执。`id` 是 ack 自己的路由 id（与 opId 同值好对账，但**匹配
 * 一律用 opId**，重发时机序可能错位，id 未必一一对应）。
 *
 * `ok` 是 1|0 而不是 true/false：线上是数字，页面与 outbox 都按数字判（`ok === 1`）。
 * 落成 true/false 的代价是接收侧两处都得判，两处漏一处就是「失败被当成送达」——
 * 那正是 outbox 终态丢弃的前提（不变量 4）。
 */
export interface AckFrame extends Frame {
  t: typeof FRAME.ack;
  opId: string;
  ok: 1 | 0;
  reason?: string;
  rowId?: number | string;
}

/**
 * 问答流事件种类。对应 qaRunner 的 sink 回调（设计 §3.3）：
 * reasoning（思考链片段）/ delta（正文增量）/ round（第 n 轮开始）/ tool（工具开始或结束）/
 * stop（被停止）。tool 的文本里带工具名与结果摘要 —— 图卡与题卡不走这里（见 chat.card）。
 */
export type ChatEvKind = 'reasoning' | 'delta' | 'round' | 'tool' | 'stop';

/**
 * chat.ev（host→guest）：流事件。`to` 是目标来宾的 hello id 或 `'*'`（广播），
 * 来宾**只认发给自己的**（不变量 7：两台设备不能互相看见对方的问答流）。
 */
export interface ChatEvFrame extends Frame {
  t: typeof FRAME.chatEv;
  to: string;
  turnId: string;
  kind: ChatEvKind;
  text?: string;
  round?: number;
}

/** chat.req（guest→host）：一次提问。`to` 是它要发给的主机（当前只有一台主机，恒为 '*'）。 */
export interface ChatReqFrame extends Frame {
  t: typeof FRAME.chatReq;
  to: string;
  turnId: string;
  videoId: string;
  text: string;
  images?: unknown;
}

/**
 * chat.card（host→guest）：题卡 / 图卡。**随流推送但不阻塞**（不变量 5）—— 这两张卡在
 * qaRunner 里是工具闭包的旁路回调，不在 agent loop 的消息序列里（设计 §3.3）。
 */
export interface ChatCardFrame extends Frame {
  t: typeof FRAME.chatCard;
  to: string;
  turnId: string;
  kind: 'quiz' | 'widget';
  payload: unknown;
}

/**
 * chat.done（host→guest）：一轮结束，`content` 是最终正文。
 * `reasoning` / `reasoningMs` / `quiz` / `widget` 是同一轮在库里的那份 assistant 的其余
 * 字段（host 已落库，guest 只进内存镜像）—— 来宾据此渲染「思考链 / 耗时 / 附卡」，
 * 不自己再落一次库（不变量 9）。
 */
export interface ChatDoneFrame extends Frame {
  t: typeof FRAME.chatDone;
  to: string;
  turnId: string;
  content: string;
  reasoning?: string;
  reasoningMs?: number;
  quiz?: unknown;
  widget?: unknown;
}

/** chat.err（host→guest）：这一轮失败了。失败也要落库成一条 assistant（设计 §3.3）。 */
export interface ChatErrFrame extends Frame {
  t: typeof FRAME.chatErr;
  to: string;
  turnId: string;
  message: string;
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
 *
 * **除了握手，所有帧都走这里**（不变量 6）：版本不符的帧一律返回 null，老端子的新帧
 * 与新端子的老帧都是「不认识的形状」，硬解出来的字段只会是错配（例如把 v2 的
 * `chat.ev` 当 v1 的 `video.meta` 读），那比丢掉糟得多。
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
 * **只给握手用**的宽松解码：接受任意整数版本，把版本号一起交还。
 *
 * ## 为什么只有握手能宽松
 *
 * 握手的职责恰恰是「认出对方是哪个版本」。bump 到 v2 之后 decodeFrame 对 v1 帧一律返
 * null（它现在的语义就是「版本不符 → 坏帧 → 跳过」），于是**老 guest 的 hello 会被静默
 * 丢弃**：host 那边什么也没发生，guest 那边永远停在「连接中」—— 这正是设计不变量 6
 * 明令禁止的失败形态（「版本不匹配必须显式失败」的前提是它先被听见）。
 * 宽松解码让老 hello 被认出，于是 host 回一句 version.err（host/you 两个版本号）再断开。
 *
 * 对**其它**帧继续宽松则是把静默错配变成系统性错配：v1 的 guest 收到 v2 的 `chat.ev`
 * 时，t、id、to 都合法，宽松解出来就是一个「形状对、语义错」的对象，来宾会拿它去渲染
 * 或去匹配 pending（症状是问答主界面串到别的机器的问答流，且没有一处报错）。所以放宽的
 * 只有版本这一项，其余校验（非对象/数组、t·id 必须是字符串）与 decodeFrame 逐字相同。
 *
 * 返回 `version` 而不是只返回帧：调用方要的就是这个数（判等、还是回 version.err）。
 */
export function decodeFrameLoose(text: string): { frame: Frame; version: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const f = parsed as Record<string, unknown>;
  if (typeof f.t !== 'string' || typeof f.id !== 'string') return null;
  // 版本必须是**整数**：'2' / 2.5 / 缺失 都不是合法的协议版本，放行它们等于把
  // 「说不清版本号」的老对端也当成某个版本看待，那还是错配。
  if (typeof f.v !== 'number' || !Number.isInteger(f.v)) return null;
  return { frame: f as Frame, version: f.v as number };
}

/** 版本判据。两端共用同一个函数：「谁是新的」不该有两套算法。 */
export type VersionCheck = { ok: true } | { ok: false; host: number; you: number };

/**
 * 比对面报的版本号。参数取自 `decodeFrameLoose(...).version`。
 * 不匹配时把 `host`（我这边的版本）与 `you`（对面的）一起带出去，来宾/用户据此看到
 * 一句明说，而不是对着一个不动的界面猜。
 */
export function versionCheck(peerVersion: number): VersionCheck {
  if (peerVersion === PROTOCOL_VERSION) return { ok: true };
  return { ok: false, host: PROTOCOL_VERSION, you: peerVersion };
}

/** hello（guest→host）。clientVersion 必带：host 靠它判要不要回 version.err。 */
export function helloFrame(id: string): HelloFrame {
  return { v: PROTOCOL_VERSION, t: FRAME.hello, id, clientVersion: PROTOCOL_VERSION };
}

/**
 * welcome（host→guest）。hostVersion 必带。
 *
 * **顺带记一笔，实现接线时别踩**：`version.err` 带的是当前版本号，而一个 v1 的 guest 用
 * 自己的 decodeFrame 严格解 v —— 它解不出这帧（会当坏帧丢掉），P1 的 guest 路由里本来也
 * 没有 version.err 这个 case。所以**对已发布的旧来宾，真正能传达到的信号是「断开连接」
 * 本身**（close code / reason），version.err 是给「握手也开始宽松解的下一代」准备的。
 * 接线时（Task 4/6）建议把版本不匹配也走一个专属 close code。
 */
export function welcomeFrame(id: string): WelcomeFrame {
  return { v: PROTOCOL_VERSION, t: FRAME.welcome, id, hostVersion: PROTOCOL_VERSION };
}

/** version.err：host 给老来宾的最后一句话，带上两边的版本号好说人话。 */
export function versionErrFrame(id: string, you: number): VersionErrFrame {
  return { v: PROTOCOL_VERSION, t: FRAME.versionErr, id, host: PROTOCOL_VERSION, you };
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
