/**
 * 实时链路的协议帧编解码：文本信封、二进制帧头、单元分片、载荷 gzip。
 * host / guest / Cloudflare Worker 三方共用，任何一端单方面改格式都会让对面静默解码失败。
 *
 * ## 版本：P1 的帧格式一个字都没改，只加了新帧型
 *
 * v1 → v2（P2 写面 + 问答流）。P1 的编码、字段名、二进制头全部保持原样，bump 的只有
 * 版本号与新增帧型 —— 这样「哪些是老的、哪些是新的」在协议层是**可判定的**（见
 * decodeFrame / decodeFrameLoose / decodeControlFrame 三条解码路径），而不是靠人记。
 *
 * ## 中继控制帧不进 app 协议（`ctl` 字段，与 PROTOCOL_VERSION 无关）
 *
 * 中继（cloudflare-worker/live-relay）是**另一个部署物**，有自己的发布节奏：app 改完
 * 提交 ≠ 中继已经上线。把它的 `host-link-down/up` 两帧塞进 app 的 `v` 里，等于给两个
 * 本该独立的生命周期绑一根绳 —— 每 bump 一次 app 协议就得**重新部署一次中继**，忘了
 * 部署的表现是新来宾把「主机已离线 / 已重连」当坏帧静默丢弃（不变量 6 的反面：静默到
 * 用户毫无察觉）。
 *
 * 所以控制帧用**自己的字段** `{ ctl: 1, t, id }`：没有 `v`，解码也不看 `v`，走
 * decodeControlFrame。改 app 协议从此不必碰中继（反过来中继改形状仍要发版，那是一次
 * 有意的动作，不是每次 bump 的税）。
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
 *
 * `decodeControlFrame`（中继控制帧）不在例外之列：它照样对坏帧返 null，只是**不看
 * 版本** —— 版本与它无关。
 *
 * ## 谁在说话：入向帧的 `from` 与出向帧的 `to`
 *
 * 中继**只搬运**：它按 role 转发，不看内容、不解析载荷（live-relay 的文件头就是这么定的
 * 取舍 1）。于是 host 收帧时看到的是「某个 guest 发来的一帧」，**看不到是哪一台**。P1 全是
 * 读面、应答一律广播，回给谁都无所谓；P2 不行：op 的 ack 与一整轮问答都必须**定向**回给
 * 发起的那台，否则两台设备同时连着时，iPad 的提问会渲染到 Mac 上（不变量 7）。
 *
 * 修法是**让来宾自己声明**（不是改中继）：
 *
 * - **入向帧带 `from`**：host 派生的每一种入向帧（`op` / `chat.req`）都带一个
 *   `from: <hello 帧的 id>`。
 * - **出向帧带 `to`**：host 回帧时把 `to` 填成刚才那个 `from`，来宾只认发给自己的。
 *
 * ## 为什么不让中继注入发送者（改中继的代价）
 *
 * 听起来更干净的做法是中继在转发前把「发这条帧的 socket 身份」贴上去（像 Supabase
 * Realtime 的 topic / 或 DO 里存一份 socket→id 表）。没选它，两个理由：
 *
 * 1. **它破坏中继「只搬运」的设计原则**。中继要贴发送者，就得开始读文本帧的信封、区分
 *    app 帧与控制帧、还要把发送者身份混进载荷 —— 于是它**解析了 app 协议**，而
 *    PROTOCOL_VERSION 每 bump 一次都要重新部署一次中继（文件头「中继控制帧」一节记的正是
 *    那个税）。更糟的是解析之后它就有义务处理解析失败（坏 JSON 转发不转发？），而
 *    「坏帧原样转发」恰恰是中继现在最好的一条性质。
 * 2. **来宾自己声明是零成本的**：它本来就握着那个 id（hello 时自己生成并记住，见
 *    guest.ts 的 guestId），多写一个字段而已；host 侧再用「`from` 必须在席」兜住伪造
 *    （host.ts 的 admitGuest）—— 也就是说，**校验放在业务侧就够了**，中继不需要为
 *    「这个 id 可不可信」承担任何责任。
 *
 * 声明式 id 的代价是中继层完全无感，所以「哪台设备还在」这种信息 host 也拿不到（guest
 * 掉线时中继不会通知 host）；那份缺口的处置见 host.ts 的 guests 表一节。
 *
 * ⚠️ `from` / `to` 是 **v2 内增补**的字段（P2 尚未发版，guest 侧一起对齐），所以版本号
 * 不再 bump：判据是「同一个未发布的协议版本内补齐字段」，而 bump 会让已经按 v2 写好的
 * guest 全部被判版本不符。
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
  // ⚠️ 下面两个是**中继控制帧**的 t，不是 app 协议帧：它们没有 v，由中继合成、
  // 由 decodeControlFrame 收（见文件头「中继控制帧」一节）。名字放在这张表里只是
  // 因为它同样是「host/guest/relay 三方要逐字对齐的字符串」，不要因为它们在表里
  // 就以为它们走 decodeFrame —— 它们走不过去。
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

/** hello（guest→host）。`clientVersion` 是 host 判「版本不匹配 → close(4400)」的唯一依据。 */
export interface HelloFrame extends Frame {
  t: typeof FRAME.hello;
  clientVersion: number;
}

/** welcome（host→guest）。`hostVersion` 是 guest 侧唯一的判据 —— 别拿信封的 v 当判据。 */
export interface WelcomeFrame extends Frame {
  t: typeof FRAME.welcome;
  hostVersion: number;
}

/** version.err（host→guest）：带 host/you 两个版本号的一帧。host 当前**不发**它，见 versionErrFrame。 */
export interface VersionErrFrame extends Frame {
  t: typeof FRAME.versionErr;
  host: number;
  you: number;
}

/**
 * op（guest→host）：来宾写面的唯一入口。`opId` 就是 outbox 的 clientOpId，ack 原样回它，
 * `study.add` 还拿它当去重键（ops.ts 的 DedupStore 是准入条件）。
 *
 * `from` 是**发起这一帧的来宾 id**（= 它的 hello id）：ack 必须定向回给同一台，发给别人的
 * 后果是「A 的操作确认到了 B」（B 的 outbox 删掉一条它从没发过的 op，A 那条永远重发）。
 * host 侧**必须先查席**再处理（`from` 不在 guests 表 → 不 apply、不 ack）：身份是来宾自己
 * 声明的，声明本身就不算证据。为什么不让中继注入发送者，见文件头「谁在说话」。
 *
 * `args` **必须是对象且按 op 分形状**，host 侧 dispatch 一律当不可信数据消毒（String/Number）
 * 后再交给 apply。放在 `args` 里而不是摊平到信封上：摊平后新加一个字段就会与
 * `to` / `round` 这类公共字段撞名，而撞名的表现是「参数被隔壁字段覆盖」，不报错。
 */
export interface OpFrame extends Frame {
  t: typeof FRAME.op;
  opId: string;
  /** 发起者来宾 id（hello id）。host 用它定向回 ack，见上 */
  from: string;
  op: OpName;
  args: unknown;
}

/**
 * ack（host→guest）：幂等回执。`id` 是 ack 自己的路由 id（与 opId 同值好对账，但**匹配
 * 一律用 opId**，重发时机序可能错位，id 未必一一对应）。
 *
 * `to` 是**目标来宾**（发起那条 op 的 `from`）。ack 不能广播：广播出去等于把这台设备写了
 * 什么、改没改成告诉别的设备，而每台来宾都要按 opId 去匹配自己的 outbox（不变量 7）。
 *
 * `ok` 是 1|0 而不是 true/false：线上是数字，页面与 outbox 都按数字判（`ok === 1`）。
 * 落成 true/false 的代价是接收侧两处都得判，两处漏一处就是「失败被当成送达」——
 * 那正是 outbox 终态丢弃的前提（不变量 4）。
 */
export interface AckFrame extends Frame {
  t: typeof FRAME.ack;
  opId: string;
  /** 目标来宾 id（= 发起那条 op 的 from） */
  to: string;
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
 * host 侧**只填具体来宾 id**（它没有「该广播给谁」的判断依据 —— 逐帧都有 from，广播等于
 * 把一台设备的问答推到别的屏幕上）；`'*'` 留给将来 host 自己发起的那类全端消息。
 */
export interface ChatEvFrame extends Frame {
  t: typeof FRAME.chatEv;
  to: string;
  turnId: string;
  kind: ChatEvKind;
  text?: string;
  round?: number;
}

/**
 * chat.req（guest→host）：一次提问。`to` 是它要发给的主机（当前只有一台主机，恒为 '*'），
 * `from` 是**发起提问的来宾 id**（hello id）—— 一整轮问答的每一帧都要定向回它，两台设备
 * 同时连着时不能互相看见对方的流（不变量 7）。理由同 op 的 `from`，见文件头「谁在说话」。
 */
export interface ChatReqFrame extends Frame {
  t: typeof FRAME.chatReq;
  to: string;
  /** 发起者来宾 id（hello id）。host 回流时填进 `to` */
  from: string;
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
  widgets?: unknown[];
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

/**
 * 中继控制帧：`{ ctl: 1, t: 'host-link-down' | 'host-link-up', id: 'relay' }`。
 *
 * **它没有 `v`，也不认 `v`** —— 中继是另一个部署物，它的生命周期不跟着 app 协议走
 * （文件头「中继控制帧」一节）。于是它与 app 帧是两条互不相干的解码路径：
 * `decodeFrame` 会因 `f.v !== PROTOCOL_VERSION`（缺字段与错版本是同一条路）拒掉它，
 * `decodeFrameLoose` 会因「版本必须是整数」拒掉它 —— 两条路都不通，这是**刻意的**，
 * 下面那条顺序要求就是从这个事实里来的。
 */
export interface ControlFrame {
  t: typeof FRAME.hostLinkDown | typeof FRAME.hostLinkUp;
}

/**
 * 控制帧的形状标记。**与 PROTOCOL_VERSION 是两回事**：它标的是「这是控制帧」这个
 * 形状（ctl: 1 = 当前唯一的控制帧形状），而不是「哪一版协议」。将来中继要加第三种
 * 控制帧时改的是这个数字，改它**不需要**动 app 的 PROTOCOL_VERSION，也不需要
 * 重新部署 app。
 */
const CONTROL_FRAME_SHAPE = 1;

/**
 * 解中继控制帧；不是控制帧（或坏帧）一律返回 null。
 *
 * ## ⚠️ 调用顺序：`decodeControlFrame` 必须在 `decodeFrame` **之前**判
 *
 * 控制帧没有 `v`，decodeFrame 的判据是 `f.v !== PROTOCOL_VERSION` —— 顺序反过来，
 * `host-link-down/up` 会在被认出来之前先以「版本不符」被当成坏帧静默丢掉。症状是
 * 主机断线后来宾收不到「已离线」、恢复时收不到「已重连」（不变量 6 明令禁止的静默）。
 * 与 decodeFrameLoose 同理：宽松路径要求 `v` 是整数，控制帧照样过不了。
 *
 * **不检查 `v` 字段**（存在与否都不看）：控制帧没有版本这回事。判据只有两个 ——
 * `ctl === CONTROL_FRAME_SHAPE` 与 `t` 是那两个值之一；其余（app 帧、坏 JSON、
 * 未知 t、ctl 不是 1）一律 null，不猜。
 *
 * 顺带钉一条过渡期的已知事实：**老中继**（仍发 `{"v":2,"t":"host-link-down",…}` 的
 * 那一版）发来的两帧解不出来 —— 认形状不认版本是这次解耦的全部意义，不可能同时兼容
 * 两种形状（兼容了就得猜「带 v 的那条是哪一版的」，而那正是要拆掉的东西）。表现：
 * app 更新了但中继还没重新部署的窗口里，来宾收不到离线条，退化成轮询兜底那条路径；
 * 中继一发新版即恢复。
 */
export function decodeControlFrame(text: string): ControlFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const f = parsed as Record<string, unknown>;
  if (f.ctl !== CONTROL_FRAME_SHAPE) return null;
  if (f.t !== FRAME.hostLinkDown && f.t !== FRAME.hostLinkUp) return null;
  return { t: f.t };
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

/** hello（guest→host）。clientVersion 必带：host 靠它判要不要 close(CLOSE_PROTOCOL_MISMATCH)。 */
export function helloFrame(id: string): HelloFrame {
  return { v: PROTOCOL_VERSION, t: FRAME.hello, id, clientVersion: PROTOCOL_VERSION };
}

/**
 * welcome（host→guest）。hostVersion 必带。
 *
 * **顺带记一笔，实现接线时别踩**：`version.err` 带的是当前版本号，而一个 v1 的 guest 用
 * 自己的 decodeFrame 严格解 v —— 它解不出这帧（会当坏帧丢掉），P1 的 guest 路由里本来也
 * 没有 version.err 这个 case。所以**对已发布的旧来宾，真正能传达到的信号是「断开连接」
 * 本身**（close code / reason）。接线时版本不匹配走 CLOSE_PROTOCOL_MISMATCH。
 */
export function welcomeFrame(id: string): WelcomeFrame {
  return { v: PROTOCOL_VERSION, t: FRAME.welcome, id, hostVersion: PROTOCOL_VERSION };
}

/**
 * version.err：带 host/you 两个版本号的一帧。
 *
 * **当前 host 在版本不匹配时不再发它**（见 CLOSE_PROTOCOL_MISMATCH）。留着这个构造器与
 * 帧型是因为协议面已经对外公布过它、测试也钉着它；将来若有「握手也开始宽松解」的
 * 来宾，它仍是那份明说。**别因为它还在就以为 host 会发** —— 接线时那条路是关着的。
 */
export function versionErrFrame(id: string, you: number): VersionErrFrame {
  return { v: PROTOCOL_VERSION, t: FRAME.versionErr, id, host: PROTOCOL_VERSION, you };
}

/**
 * 版本不匹配时的 close code（host → guest 方向，中继不合成这个码）。
 *
 * ## 为什么是「关连接」，而不是先发一句 version.err
 *
 * 「明说」这件事**只对能听懂的那一端成立**。一个已发布的老来宾（v1）用严格 decodeFrame
 * 解码：它连 host 的 hello 回执都解不出来，一条 `version.err` 落到它手里只是被当坏帧
 * 丢掉 —— 发了是**给空气发消息**。它唯一收得到的信号在连接层：socket 被关（close
 * code / reason），或中继合成的 host-link-down。所以这一步只关连接，多发的那一帧字节
 * 纯属浪费。
 * ⚠️ 但**今天的真中继并不转发 host 的 close code**（它只广播 host-link-down，见
 * live-relay 文件末那条记录），所以下面「两端各自的待遇」里老来宾那一半还差一跳：
 * 这个码目前谁也收不到。先把这个码定下来，是为了让接线时那一跳有地方可接。
 *
 * ## 为什么不借用中继那三个致命码（4000 / 4001 / 4403）
 *
 * 它们的文案都是**具体事实**：「房间回收」「配对码不存在」「配对限流」。拿其中一个来
 * 关一个版本不匹配的连接，等于给用户一条**假的解释**：他会去换配对链接、或让主机重开
 * 共享（那些动作对版本不匹配一点用都没有），页面回到「重连中」后他只会再来一遍。
 * 与其给一条指错方向的线索，不如给一个他看不懂但诚实的结果。
 *
 * ## 两端各自的待遇（明知的取舍）
 *
 * - **听得懂的那一端**（白名单里带 4400 的来宾页）：显示「版本不匹配，请刷新页面」，
 *   不重连 —— 重连解决不了版本差，刷新才是修复动作。说这句话的 host 与那一页不是同一
 *   个版本，方向通常是「这一页比主机旧」。
 * - **老来宾**：它的致命码白名单是 [4000, 4001, 4403]（LiveGuest.tsx 的
 *   FATAL_CLOSE_CODES），4400 不在里面 → 它按网络抖动退避重连，而它永远读不懂新协议的
 *   帧，于是只会一直「连接失败 → 重连中」。这不是漏考虑，是没有第三个既能让老端停住、
 *   又不撒谎的码；停住它的唯一办法是骗它。宁可让它退避重连到用户刷新页面，也不给它一个
 *   假的失败原因。
 */
export const CLOSE_PROTOCOL_MISMATCH = 4400;

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
