/**
 * guest 侧 MSE 播放管道：MediaSource + SourceBuffer + 按窗口拉流（window.ts 规划）。
 *
 * ## 拉哪些字节：完全由 window.ts 规划，播放器真实状态回喂
 *
 * 不另起一套预测逻辑。每轮把「已缓冲 ∪ 在途」与播放头喂给 planFetches，它返回
 * 该补的段。三个参数各有来历：
 *
 * - **buffered 必须并入在途区间**（Task 2 反复强调的模块边界约束）：在途请求的
 *   字节还没进 video.buffered，不并进去，两轮 fill 之间同一段字节会被规划两次；
 *   MSE 对同一段字节重复 append 会直接损坏已解码帧 —— 花屏、无声、没有任何报错。
 *   本文件的覆盖区间从「发出请求」一直守到「这段字节真的 append 完」
 *   （RangeCtx.framesDone + queued 两个标志配合，见 settleRange），而不是收到
 *   帧就放手 —— 收到帧只等于字节到了 guest 内存里，video.buffered 要等 updateend。
 * - **pos 钳到 [0, size]**：currentTime/duration 线性估算在 EOF 附近会过冲
 *   （Task 2 的约定；window.ts 内部也钳，这里显式钳是让意图可读 + 双保险）。
 * - **chunk=1MB / window=8MB / maxInflight=4** 与 host.ts 的 RANGE_CHUNK=1MB、
 *   MAX_RANGE_INFLIGHT=4 匹配：host 给多少读盘名额，这里就发多少请求（host 超限
 *   时有界排队等，不丢帧）。万一还是丢了帧，RANGE_STALE_MS 的 sweep 兜底重规划。
 *
 * ## append 必须串行，还必须按字节序、不许跨洞（字节流容器两条硬约束）
 *
 * 每次 appendBuffer 前等上一次 updateend。并发 append 在 Safari 上会把缓冲打花
 * （同样的段到两次、时间戳乱序），而 Chrome / Firefox 上也只是「看起来没事」——
 * 跨设备链路不能赌浏览器成全，串行是唯一稳的姿势。代价是吞吐上限 = 单 buffer
 * 的解析速度，8MB 窗口下远高于家用上行，付得起。
 *
 * 串行只是第一条。**webm / mp4 是字节流容器**：Chrome 的 demuxer 按 append 的
 * 顺序连续解析，两条约束因此成立（2026-10-10 用 11MB webm fixture 实测，一次
 * 探针四条并列）：
 *
 * 1. **必须按字节序 append**。乱序（哪怕只把前两个 1MB 片对调）当场
 *    `CHUNK_DEMUXER_ERROR_APPEND_FAILED` / sb error。而 host 侧 4 个读盘名额并发
 *    完成，响应顺序本来就不等于请求顺序 —— 所以 guest 侧必须有一个按 seq 的
 *    重排队列（`appendChunk` 有序插入 + `drain` 只取 seq 等于游标的那一片）。
 * 2. **不许跨洞 append**。中间少一个 1MB 片，往后的片全部报同样的错。因此
 *    drain 是**队头阻塞**的：游标处的那一片没到，后面的字节就在队列里等着。
 *    洞的来源只有丢帧（RANGE_STALE_MS 的 sweep 会作废并重拉那一片），所以
 *    「等」与「重拉」合起来才闭合 —— 这也是 sweep 为什么必须存在。
 *
 * 附带结论：seek 不能靠「跳到新位置开窗」实现（那会在字节流中间挖一个洞）。
 * 现在的做法是规划锚点取 `min(播放头, 游标)`—— 跳过去了就把中间那段补齐再往前，
 *  seek 的成本是那段字节，换来的是字节流不断。往回跳超过已喂范围时，那段数据
 * 若还在 SourceBuffer 里就能直接播，被浏览器淘汰了就停住（与「MSE 淘汰不重拉」
 * 是同一条已知限制，刷新页面即恢复）。
 *
 * ## codec 串必须带 codecs 参数，而且猜错要能换（实测两条，都推翻了计划里的判断）
 *
 * 计划文档写「mp4/webm 容器级 type 即可（codecs 可选）」。两条实测结论：
 *
 * 1. **裸容器级 type 在 Chrome 上直接被拒**：`MediaSource.isTypeSupported('video/mp4')`
 *    与 `'video/webm'` 都是 false，`addSourceBuffer('video/mp4')` 抛 NotSupportedError
 *    （2026-10-10 实测，Chrome 155，headed 与 headless 一致）。codecs 参数是选
 *    解码器的依据，必须带。
 * 2. **isTypeSupported 会说谎，codec 串必须匹配文件真实的轨**：声明
 *    `'video/webm; codecs="vp9, opus"'` 时 isTypeSupported 为 true，但文件只有
 *    视频轨（没有音频）时 append 直接 sb error + video error(4)；反过来声明纯视频
 *    串而文件带音频轨同样报错。文件有没有音轨、H.264 是哪个 profile，只有 append
 *    那一刻知道 —— 所以这里是「候选序 + 猜错就换下一个」：startup 阶段任一 append
 *    失败就整套拆掉换下一个候选 type，全试完才告诉页面「这台设备解不了」。
 *
 * 残余风险（诚实记账）：候选序覆盖 mp4 的 H.264/AAC、AV1、HEVC 与 webm 的
 * VP9/VP8 + opus/vorbis 各常见组合，但**猜不中就是一条诚实的错误提示**，
 * 不假装在播。真要覆盖任意文件，得解析 init segment 里的 avcC / CodecPrivate
 * 自己拼 codec 串（hls.js / dash.js 那条路）——P1 不做，记在这里。
 *
 * ## pendingRanges 为什么是模块级 map（跨模块 glue 的取舍）
 *
 * feedRange 是 guest.ts 的 onBinaryFrame 挂的入口，要按 rid 找到「这个请求的现场」，
 * 而现场的生命周期跨 fill / feedRange / append 三个阶段。进程内同时只有一个播放器
 * （P1 不为多实例抽象），所以用模块级 Map + player 反查足够；真要支持同页两个播放器，
 * 该把这张表收进实例里 —— 现在分散是为了让 guest.ts 不需要持有 player 引用。
 */

import { planFetches, type Range } from './window';
import type { VideoOpenOk, VideoOpenResult } from './guest';

/** 单次请求的基准字节数。与 host.ts 的 RANGE_CHUNK 一致（host 会按 1MB 再切）。 */
const CHUNK_BYTES = 1024 * 1024;
/** 播放头前方愿意提前缓冲的字节总量。与 host.ts 取舍 4 的账一致。 */
const WINDOW_BYTES = 8 * 1024 * 1024;
/** 在途请求上限。与 host.ts 的 MAX_RANGE_INFLIGHT 对齐（都是 4）。 */
const MAX_INFLIGHT = 4;
/**
 * 单个 range 的字节兜底超时（毫秒）：超过这么久**一个字节都没到**，就当这个
 * rid 丢了 —— 从 pendingRanges 摘掉、在途水位减一，下一轮自然重规划缺的那截。
 *
 * 为什么必须有这条（终审 A）：host 丢帧曾经有两种形态（并发超限静默 return、
 * 取文件失败静默 return），被丢的 rid 永远等不到应答帧，而 pendingRanges 的
 * 唯一清理路径是 teardown。后果是被丢的区间被 planBuffered 永久算成「已覆盖」
 * （文件留洞）、inflight 永久少一格（窗口预算腰斩），而 MSE 只是卡住：没有
 * error、没有 UI 变化。host 侧的丢弃已经修掉（换成了有界 FIFO 等待），这条是
 * **根治的兜底**——将来任何新的丢帧路径（relay 静默吞帧、host 忘了应答）都会被
 * 它在 15s 内自愈，而不是把用户钉在黑屏上。
 */
const RANGE_STALE_MS = 15000;
/** stale sweep 的间隔。5s × 15s 判据：比判据短一个量级，够及时又不添开销。 */
const RANGE_SWEEP_INTERVAL_MS = 5000;
/**
 * 一个候选的总时限（sourceopen 等不到 / 首片不落地都算猜错）。
 * 10s 够跨一次弱网往返；到点就换下一个候选，页面不会永久停在「连接中」。
 *
 * ⚠️ 这个超时只管 startup 阶段，且**不等于「解码不了」**——等字节慢只是链路
 * 慢，见 settleAttempt 的 attemptTimer 回调（原样重试同一个候选，不推进 typeIdx）。
 */
const ATTEMPT_TIMEOUT_MS = 10000;
/** 同一个候选 type 的尝试次数上限：等字节超时会原样重试，但不能无限重试。 */
const MAX_TYPE_ATTEMPTS = 3;
/** startup 阶段的全局尝试次数上限：候选表很长 × 每个都重试会把用户钉在「连接中」。 */
const MAX_TOTAL_ATTEMPTS = 12;
/**
 * 重试时的探针窗口（字节）。
 *
 * 猜错 codec 串的暴露点在 init segment（文件最前面那几 KB～几百 KB），所以重试
 * 轮先用一个小窗口探：搬 256KB 就能知道猜没猜对，不用把整个首窗（≤4MB，在途
 * 上限 4 片）都拉过链路。首轮不探 —— 第一把中的概率最高，直接拉满窗口。
 */
const PROBE_BYTES = 256 * 1024;

/**
 * mp4 候选 type，按「网课文件里的常见度」排序，取第一个 isTypeSupported 的；
 * append 失败还会往后换（见文件头实测 2）。音视频组合在前、纯视频兜底：
 * 文件有没有音轨只有 append 时知道，两种都要有得试。
 */
const MP4_TYPES = [
  'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', // H.264 baseline + AAC
  'video/mp4; codecs="avc1.4D401F, mp4a.40.2"', // H.264 main + AAC
  'video/mp4; codecs="avc1.64001F, mp4a.40.2"', // H.264 high + AAC
  'video/mp4; codecs="avc1.640029, mp4a.40.2"', // H.264 high@4.1 + AAC
  'video/mp4; codecs="avc1.42E01E"', // 只有视频轨
  'video/mp4; codecs="avc1.64001F"',
  'video/mp4; codecs="av01.0.05M.08, mp4a.40.2"', // AV1 + AAC
  'video/mp4; codecs="av01.0.05M.08"',
  'video/mp4; codecs="hev1.1.6.L93.B0, mp4a.40.2"', // HEVC（Safari / 部分平台）
  'video/mp4; codecs="mp4a.40.2"', // 纯音频 mp4 兜底
] as const;

/** webm 候选 type：VP9/VP8 × opus/vorbis，组合同序。 */
const WEBM_TYPES = [
  'video/webm; codecs="vp9, opus"',
  'video/webm; codecs="vp9"',
  'video/webm; codecs="vp8, vorbis"',
  'video/webm; codecs="vp8"',
  'video/webm; codecs="vp9, vorbis"',
  'video/webm; codecs="vp8, opus"',
] as const;

export interface MseIo {
  openVideo(videoId: string): Promise<VideoOpenResult>;
  /** 发 video.range 帧（走 LiveGuest 的帧通道；host 只认这个帧）。rid ∈ [0, 0x7fffffff]。 */
  requestRange(rid: number, start: number, len: number): void;
  /**
   * 播放管道致命错误（候选 type 全试过仍解不了）：页面 error 态接住。
   * 不抛异常是因为这些错误都发生在事件回调里，抛出去只会变成 unhandledrejection。
   */
  onError?: (message: string) => void;
}

/**
 * startup 一轮的生死判定。**「猜错了」和「只是等不到字节」必须分开**：前者换
 * 下一个候选 type，后者原样重试同一个（终审 K —— 把慢链路误判成「解码不了」
 * 会让用户白换一台设备）。定义与理由见 start() 与 tryPipeline。
 */
type AttemptOutcome = 'alive' | 'wrong' | 'retry';

/** 一个 range 请求的现场：从发出的那一刻起负责「这段字节已被覆盖」。 */
interface RangeCtx {
  start: number;
  end: number;
  /** 文件总字节：host 按 EOF 截断时，帧尾会短于请求末端，靠它判定收齐 */
  size: number;
  player: GuestMsePlayer;
  /** host 这一请求的帧已发齐（seq+len ≥ end，或触到 EOF） */
  framesDone: boolean;
  /** 已入队还没 append 完的分片数（>0 时这段字节仍不算「已缓冲」） */
  queued: number;
  /**
   * 最近一次见到字节的时刻（ms）。初始 = 发出请求的时刻，之后每收到一帧就刷新。
   *
   * 超时判据是「多久没有任何字节到达」而不是「发出多久」：一个 1MB 片在慢链路
   * 上合法地可以传很久，但 15s 一个字节都不动只能说明这个 rid 的帧丢了。
   */
  issuedAt: number;
}

/**
 * rid → range 现场。guest.ts 的 onBinaryFrame 经 feedRange 找到现场。
 * 模块级：进程内单播放器，见文件头取舍。
 */
const pendingRanges = new Map<number, RangeCtx>();

/**
 * range rid 游标，**模块级**（不是实例级）。
 *
 * 必须留在 [1, 0x7fffffff]：高半区 0x80000000+ 是 host 单元分片的地盘，命名空间
 * 契约见 guest.ts 文件头。从 1 起而不是 0：rid 0 与「没设置」长得像，日志里分不清。
 *
 * **为什么不能是实例级**：pendingRanges 是模块级 map，而「换课」时旧播放器 dispose
 * 之后，host 手里旧请求的应答还会在飞。实例级游标会让新旧两个播放器都从 1 开始发
 * 号 —— 迟到的旧应答会配上新播放器的现场，把另一门课的字节 append 进这个管道：
 * 不报错、只是数据错乱，还会以花屏 / demuxer error 的面目出现。模块级游标让 rid
 * 在一次页面生命周期里不重复，这类错配从根上消失。跨候选重试也不回绕，同一个
 * 理由。
 */
let rangeRidSeq = 1;

function nextRid(): number {
  const r = rangeRidSeq;
  rangeRidSeq = rangeRidSeq >= 0x7fffffff ? 1 : rangeRidSeq + 1;
  return r;
}

/** mse.ts 与 guest.ts 之间的组装入口：一片二进制帧到达 → 喂给对应 range 的播放器。 */
export function feedRange(rid: number, seq: number, payload: Uint8Array): void {
  const ctx = pendingRanges.get(rid);
  if (!ctx) return; // 早已收齐/回收的 rid：迟到帧直接丢（host 不会重发风暴）
  // 先刷新「最近见到字节」：stale sweep 的判据是多久没字节，不是发出多久
  ctx.issuedAt = Date.now();
  if (payload.byteLength === 0) {
    // host 的「该段已回收、无字节可 append」信号（start 压在 EOF 上时）。只回收
    // 在途水位，**绝不 appendBuffer(空数组)** —— 空 append 各浏览器行为不一
    // （有的抛、有的静默），没有语义只有风险。
    pendingRanges.delete(rid);
    ctx.player.onRangeDone();
    return;
  }
  ctx.player.appendChunk(rid, seq, payload);
  // 收齐判定：帧尾越过请求末端，或触到文件尾（host 按 EOF 截断，帧尾会短于请求末端）。
  // 注意此刻只标记「帧收齐」，字节要等 updateend 才真正进 video.buffered，
  // 所以现场还不能撤（queued > 0）—— 见文件头覆盖区间的两条。
  if (seq + payload.byteLength >= ctx.end || seq + payload.byteLength >= ctx.size) {
    ctx.framesDone = true;
    ctx.player.settleRange(rid);
  }
}

export class GuestMsePlayer {
  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  private meta: VideoOpenOk | null = null;
  private inflight = 0;
  private disposed = false;
  /** 致命错误后置位：不再 append、不再规划（继续喂只是烧 host 的上行带宽） */
  private broken = false;
  private reported = false;
  private objectUrl: string | null = null;
  /** 候选 type 游标：猜错一个换一个（文件头实测 2） */
  private typeIdx = 0;
  /** 当前候选 type（startup 循环的游标）；等字节超时会原样重试它，只有解码报错才换。 */
  private currentType: string | null = null;
  /** 当前候选已尝试的次数（用于 MAX_TYPE_ATTEMPTS 的重试上限） */
  private typeAttempts = 0;
  /** startup 以来的总尝试次数（用于 MAX_TOTAL_ATTEMPTS 的全局上限） */
  private attempts = 0;
  /**
   * startup 阶段的判定信号（start() 的循环正等着它）：
   * 'alive' = 这一轮活了；'wrong' = 这一轮猜错了（type 不对），换下一个候选；
   * 'retry' = 只是字节等太久（链路慢），原样重试同一个候选。
   * null = 已过 startup，此后的错误直接致命。见 settleAttempt。
   */
  private attemptFailed: ((outcome: AttemptOutcome) => void) | null = null;
  /** 候选总时限句柄：见 ATTEMPT_TIMEOUT_MS */
  private attemptTimer: number | null = null;
  /** stale sweep 的定时器句柄，见 startStaleSweep / RANGE_STALE_MS */
  private staleTimer: number | null = null;
  /**
   * append 游标：下一个允许 appendBuffer 的字节偏移（null = 还没开始喂）。
   *
   * 为什么必须有：webm / mp4 是字节流容器，demuxer 按 append 顺序连续解析，
   * 乱序与跨洞都当场报错（文件头实测）。host 的 4 个读盘名额并发完成，响应顺序
   * 本来就不等于请求顺序，所以 guest 侧必须自己按字节序排，并且**游标处那片没到
   * 就不许往后喂**（队头阻塞）。洞只能来自丢帧，由 stale sweep 作废重拉来闭合。
   */
  private appendCursor: number | null = null;
  /** 游标最后一次前进的时刻。sweep 的「卡住」判据用它，见 sweepStaleRanges。 */
  private cursorAdvancedAt = 0;
  /** 重试轮用小窗口探（PROBE_BYTES），首片落地后置 false 拉满正常窗口 */
  private probing = false;
  /** 待 append 队列：帧到达 → 按 seq 有序插入；drain 只消费 seq 等于游标的那一片。 */
  private queue: { rid: number; seq: number; payload: Uint8Array }[] = [];
  private draining = false;
  /**
   * 已 append 进 SourceBuffer 的**字节区间**（本地记账，合并相邻段）。
   *
   * 为什么必须自己记：浏览器只暴露**时间轴**区间（video.buffered 与
   * sourceBuffer.buffered 都是 TimeRanges，单位是秒），没有任何 API 能问「哪些
   * 字节已经在缓冲里」。而 window.ts 的规划是字节级的 —— 把 video.buffered 的秒
   * 当成字节喂进去，会算出 start=4.999 这种请求（冒烟测试里实测过：同一段字节被
   * 请求三次，重复 append 直接损坏解码）。所以字节覆盖以本地账本为准：pendingRanges
   * （在途）从这里毕业后搬进来，两个表共同构成「已覆盖」。
   *
   * 已知限制（诚实记账）：浏览器在内存压力下会淘汰**播放头之后很远**的旧数据，
   * 本地账本不知道，会继续声称那一段已覆盖 —— 表现为进度条拖回旧位置时卡住。
   * 8MB 窗口内极少触发；真发生了刷新页面即恢复，P1 不做 buffer reset 自动恢复。
   */
  private appended: Range[] = [];

  constructor(
    private video: HTMLVideoElement,
    private io: MseIo,
    private videoId: string,
  ) {}

  /**
   * 开视频 → 逐个候选 type 建管道 + 首轮填充。
   *
   * resolve = 有一个候选活着；reject = openVideo 被拒 / 文件大小为 0 /
   * 候选全试完或尝试预算耗尽（页面转 live-play-error）。
   *
   * **两类失败必须分开**（终审 K）：① sourcebuffer / video 的 error = 这个 type
   * 解不了，换下一个候选；② 只是等不到字节 = 链路慢，**原样重试同一个候选**。
   * 早先把两者一起当作「猜错」，结果是弱网下把 10 个候选挨个试完，最后报一句
   * 「换台设备打开」——把「等字节慢」误判成「解码不了」，用户照做也没用。
   */
  async start(): Promise<void> {
    const meta = await this.io.openVideo(this.videoId);
    // openVideo 是异步的：这期间可能已被 dispose（React StrictMode 的双挂、用户
    // 切课）。被 dispose 的实例绝不能再碰 video 元素 —— 会把活着那个播放器的
    // src 顶掉，表现为「有缓冲但不播」（冒烟测试里实测过）。
    if (this.disposed) return;
    if (!meta.ok) throw new Error(openFailText(meta.reason, meta.mime));
    if (!(meta.size > 0)) throw new Error('主机侧文件大小为 0，无法播放');
    this.meta = meta;
    for (;;) {
      if (this.disposed) return; // 重试路上被 dispose（换课 / 卸载）：安静退出
      if (this.attempts >= MAX_TOTAL_ATTEMPTS) {
        throw new Error('首片字节一直等不到（链路太慢，或主机没有真正把文件发出来）：换个网络环境再试');
      }
      if (this.currentType == null) {
        this.currentType = this.nextType();
        this.typeAttempts = 0;
      }
      if (!this.currentType) throw new Error('这台设备解不了这个文件（mp4 / webm 的常见编码组合都试过了）：换台设备打开，或让主机换个编码的视频');
      const first = this.attempts === 0; // 头一把就直接拉满窗口，重试轮才探
      const outcome = await this.tryPipeline(this.currentType, first);
      this.attempts++;
      this.typeAttempts++;
      if (outcome === 'alive') return; // 这一轮活着：startup 结束，之后 errors 直接走 fatal
      // 'retry' 且这个候选还没试够：currentType 不动，原样再来一次（等字节超时）
      if (outcome === 'retry' && this.typeAttempts < MAX_TYPE_ATTEMPTS) continue;
      this.currentType = null; // 猜错了（或重试到顶）：换下一个候选
    }
  }

  /** 一轮规划：pos 钳位 + buffered 并在途 + planFetches → 发请求、记在途。 */
  fill(): void {
    if (this.disposed || this.broken || !this.sb || !this.meta) return;
    const size = this.meta.size;
    const raw = this.currentByte();
    // pos 钳到 [0, size]：currentTime/duration 线性估算在 EOF 附近会过冲
    const pos = raw == null ? null : Math.max(0, Math.min(size, raw));
    /**
     * 规划锚点 = min(播放头, append 游标)。
     *
     * 为什么不是播放头：字节流不许跨洞（文件头）。播放头跳到前面去（seek）而游标
     * 还在后面时，只按播放头规划就永远没人去补中间那段 —— 游标队头阻塞，播放永久
     * 停摆。取 min 之后 seek 的代价变成「把跳过的字节补齐」，换来字节流不断。
     * 已喂过的区间在 planBuffered 的账本里，不会被重复请求。
     */
    const anchor = pos == null ? null : this.appendCursor == null ? pos : Math.min(pos, this.appendCursor);
    const plans = planFetches({
      size,
      buffered: this.planBuffered(),
      chunk: CHUNK_BYTES,
      windowBytes: this.probing ? PROBE_BYTES : WINDOW_BYTES,
      inflight: this.inflight,
      maxInflight: MAX_INFLIGHT,
      pos: anchor,
    }).filter((p) => this.wholeChunkWorth(p, size));
    for (const p of plans) {
      const rid = nextRid();
      this.inflight++;
      // 字节流的起点：第一片请求的 start 就是游标初值（正常是 0）
      if (this.appendCursor == null) {
        this.appendCursor = p.start;
        this.cursorAdvancedAt = Date.now();
      }
      pendingRanges.set(rid, {
        start: p.start,
        end: p.start + p.len,
        size,
        player: this,
        framesDone: false,
        queued: 0,
        issuedAt: Date.now(),
      });
      this.io.requestRange(rid, p.start, p.len);
    }
    // 有请求在途就把 stale sweep 挂上（见 RANGE_STALE_MS）：丢帧的 rid 若没人管，
    // 覆盖表会永久留着那个洞、水位永久少一格。sweep 是低频定时器而不是塞进
    // fill()：MSE 卡住时 timeupdate / progress 都不再触发，靠事件驱动的兜底
    // 恰好在最需要它的那一刻不响。
    if (plans.length > 0) this.startStaleSweep();
  }

  /**
   * 这一段值不值得发一次请求（**反请求风暴的判据**，终审强化 e2e 实测出来的形态）。
   *
   * 窗口边界是跟着播放头连续移动的，而覆盖区间已经顶到边界上。于是每过一次
   * fill 都只「在边缘露出一个很小的口子」，规划器按 `min(chunk, 口子)` 发出几百
   * 字节的请求；更要命的是 onRangeDone → fill 自己形成正反馈：碎片请求完成 → 再
   * 规划一个碎片 → 再完成……以网络往返的速度空转。实测（11MB / 45s / 2000kbps
   * webm）：**19248 个请求、平均 100 字节**，中继白转 16MB，而其中真正必要的只有
   * 十几个 1MB 片。
   *
   * 所以：**除非整片都在窗口内（或已经贴到文件尾），否则不发这个请求**。缓冲因此
   * 在「窗口 − 1 chunk」与「窗口」之间小幅起伏 —— 播放头前方永远有 7MB 以上，
   * 付得起。探针轮（PROBE_BYTES）不适用这条：那一轮要的就是「搬一小段就知道猜没
   * 猜对」，而且它只发生在 startup。
   *
   * 覆盖表本身是连续区间（append 游标保证「已 append 的必须是 [0, 游标)」、新请求
   * 都接在覆盖末端后面），所以被这条判据挡掉的只可能是边缘碎口，不会是洞 —— 洞
   * 有 stale sweep 兜底，见 sweepStaleRanges。
   */
  private wholeChunkWorth(p: { start: number; len: number }, size: number): boolean {
    if (this.probing) return true;
    return p.len >= CHUNK_BYTES || p.start + p.len >= size;
  }

  /**
   * 一帧字节入队。公开是给 feedRange 用（跨模块 glue，见文件头）。seq 是这帧的字节偏移。
   *
   * **按 seq 有序插入**，不是 push：host 的读盘名额并发完成，帧的到达顺序本来就不
   * 等于字节序，而 demuxer 要求严格按字节序喂（乱序当场报错，文件头实测）。
   */
  appendChunk(rid: number, seq: number, payload: Uint8Array): void {
    if (this.disposed || this.broken) return;
    const ctx = pendingRanges.get(rid);
    if (ctx) ctx.queued++;
    // 升序插入。队列长度有界（在途请求数 × 每请求帧数，正常 ≤4），线性扫足够；
    // 真到了几百项的规模再换有序结构 —— 现在换只是把复杂度搬到没人看的地方。
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].seq > seq) i--;
    this.queue.splice(i, 0, { rid, seq, payload });
    void this.drain();
  }

  /**
   * 帧收齐回调：撤现场、回收在途水位、立刻再规划。
   * queued > 0（字节还没 append 完）时什么都不做 —— 覆盖区间要继续守到 updateend。
   */
  settleRange(rid: number): void {
    const ctx = pendingRanges.get(rid);
    if (!ctx || !ctx.framesDone || ctx.queued > 0) return;
    pendingRanges.delete(rid);
    this.onRangeDone();
  }

  /** 一个 range 彻底结束（帧收齐 + 字节落地，或 host 的空段回收信号）。 */
  onRangeDone(): void {
    if (this.disposed) return;
    this.inflight = Math.max(0, this.inflight - 1);
    this.fill();
  }

  /** 拆掉：停事件、清队、摘 src、endOfStream、撤 objectURL、清自己名下的在途项。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopStaleSweep(); // 定时器比实例活得长是最难查的一类泄漏
    this.settleAttempt('alive'); // start() 还在等：这一轮算「活着」，让它直接返回
    this.teardownPipeline();
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  /**
   * 挂上 stale sweep（低频定时器）。只在真的有请求在途时才需要它。
   * 用定时器而不是塞进 fill()：MSE 卡住（等一个永远不来的 rid）时
   * timeupdate / progress 都不再触发，事件驱动的兜底恰好在最需要它的那一刻不响。
   */
  private startStaleSweep(): void {
    if (this.staleTimer != null || this.disposed) return;
    this.staleTimer = window.setInterval(() => this.sweepStaleRanges(), RANGE_SWEEP_INTERVAL_MS);
  }

  private stopStaleSweep(): void {
    if (this.staleTimer == null) return;
    window.clearInterval(this.staleTimer);
    this.staleTimer = null;
  }

  /**
   * 兜底扫描：把「超过 RANGE_STALE_MS 一个字节都没到」的 rid 作废并重规划。
   *
   * 这条守的是**静默丢帧**：host 不再丢帧（有界 FIFO 等待）之后它正常一次都不响，
   * 但只要还在，将来任何新的丢帧路径（relay 吞帧、host 忘了应答、请求根本没发出去）
   * 都会被它在 15s 内自愈，而不是让文件留一个永久的洞、播放头卡在那儿没反应。
   *
   * 只作废 queued === 0 的现场：字节已经进了 append 队列的，等 drain 落地即可，
   * 动它反而会把「半截已 append」的状态搅乱。已经落地的字节在 appended 账本上，
   * 重规划时 planBuffered 会把它算成已覆盖 —— 所以重拉的恰好是缺的那一截，
   * **不会重复 append**（重复 append 会损坏解码，见文件头）。
   */
  private sweepStaleRanges(): void {
    if (this.disposed) return;
    const now = Date.now();
    for (const [rid, ctx] of [...pendingRanges]) {
      if (ctx.player !== this || ctx.framesDone || ctx.queued > 0) continue;
      if (now - ctx.issuedAt <= RANGE_STALE_MS) continue;
      console.warn(
        `[live-mse] range rid=${rid} [${ctx.start}, ${ctx.end}) ${Math.round((now - ctx.issuedAt) / 1000)}s 没有任何字节，作废后重规划`,
      );
      pendingRanges.delete(rid);
      // 跨过判据的那一刻可能又来了一帧（刚进队列）：留着它只会 append 一段没人等的字节
      this.queue = this.queue.filter((q) => q.rid !== rid);
      this.inflight = Math.max(0, this.inflight - 1);
      this.fill(); // 立刻重规划缺的那一截
    }
    // 兜底二：游标卡住，且游标处没有任何在途请求。
    // 典型成因是「请求根本没发出去」——guest.requestRange 在 socket 未 OPEN 时
    // send() 是 no-op（断线重连那一瞬最容易撞上）。这种形态连 rid 都不存在，
    // 上面的循环抓不到，只能靠「游标多久没前进」来发现。fill() 的锚点取
    // min(播放头, 游标)，所以它补的正是游标那一截。
    const cursor = this.appendCursor;
    if (cursor != null && this.meta && cursor < this.meta.size && now - this.cursorAdvancedAt > RANGE_STALE_MS) {
      const covered = [...pendingRanges.values()].some((c) => c.player === this && c.start <= cursor && cursor < c.end);
      if (!covered) {
        console.warn(`[live-mse] append 游标停在 ${cursor} 超过 ${RANGE_STALE_MS / 1000}s 且无在途请求，重新规划`);
        this.fill();
      }
    }
  }

  private onVideoEvent = (): void => {
    this.fill();
  };

  private onSbError = (): void => {
    this.settleAttemptPipelineError('解码失败：这个文件的编码这台设备解不了');
  };

  private onVideoError = (): void => {
    // startup 期间 video error 只是 sb error 的下游噪声（同一件事报两遍），
    // 交给 attemptFailed 那条路换候选；startup 之后才是真错误
    if (this.attemptFailed) return;
    const code = this.video.error?.code;
    this.fatal(code === 4 ? '播放失败：容器或编码不被这台设备支持' : `播放失败（video error ${code ?? '?'}）`);
  };

  /** 下一个候选 type；全试完返 null。 */
  private nextType(): string | null {
    if (!this.meta) return null;
    const list = this.meta.mime === 'video/webm' ? WEBM_TYPES : MP4_TYPES;
    while (this.typeIdx < list.length) {
      const t = list[this.typeIdx++];
      try {
        if (MediaSource.isTypeSupported(t)) return t;
      } catch {
        // 老 Safari 没有 isTypeSupported：跳过探测直接用下一个
      }
    }
    return null;
  }

  /**
   * 建一轮管道并发出首次填充，等这一轮的生死判定。
   *
   * 'alive' = 活着；'wrong' = 这个 type 猜错了（调用方换下一个候选）；
   * 'retry' = 只是字节等太久（调用方原样重试同一个候选）。
   */
  private tryPipeline(type: string, first: boolean): Promise<AttemptOutcome> {
    return new Promise<AttemptOutcome>((resolve) => {
      this.attemptFailed = resolve;
      this.probing = !first;
      // 候选总时限：sourceopen 不来、首片不落地，都算这一轮没成。
      // 注意它 resolve 的是 'retry' 而不是 'wrong' —— **等不到字节不等于解码不了**
      // （弱网下首片合法地可以传很久），只有 sourcebuffer / video 的 error 才是
      // 「这个 type 不行」。两者混同的后果是把慢链路误报成「换台设备」，见 start()。
      this.attemptTimer = window.setTimeout(() => this.settleAttempt('retry'), ATTEMPT_TIMEOUT_MS);
      try {
        this.attachPipeline(type);
      } catch {
        // 同步抛的那种（addSourceBuffer 不认这个 type）确实是猜错
        this.settleAttempt('wrong');
      }
    });
  }

  /**
   * startup 判定收口， attemptFailed 的清理只此一处。
   * 'wrong'：拆掉这一轮，让 start() 的循环试下一个候选；
   * 'retry'：同样拆掉，但下一个循环会用同一个 type 重建（只换了尝试计数）；
   * 'alive'：活着（或本实例已 dispose，start() 直接返回）。
   */
  private settleAttempt(outcome: AttemptOutcome): void {
    const resolve = this.attemptFailed;
    this.attemptFailed = null;
    if (this.attemptTimer != null) {
      window.clearTimeout(this.attemptTimer);
      this.attemptTimer = null;
    }
    if (outcome === 'alive') {
      if (this.probing && !this.disposed) {
        // 探针落地：把正常窗口拉起来。onRangeDone 触发的那次 fill 还带着探针的
        // 小窗口（probing 还没置位），不补这一下的话整个管道停在 256KB 上。
        this.probing = false;
        this.fill();
      }
    } else if (!this.disposed) {
      this.teardownPipeline();
    }
    if (!resolve) return;
    resolve(this.disposed ? 'alive' : outcome);
  }

  /** 建 MediaSource + 挂 src；sourceopen 后 addSourceBuffer + 挂事件 + 首轮填充。 */
  private attachPipeline(type: string): void {
    if (this.disposed) return;
    const ms = new MediaSource();
    this.ms = ms;
    this.objectUrl = URL.createObjectURL(ms);
    this.video.src = this.objectUrl;
    // sourceopen 之前 addSourceBuffer 会抛 InvalidStateError；等不到就由 attemptTimer
    // 兜底（这一轮重来，页面不会永久停在「连接中」；只是慢的话会用同一个 type 重试）
    ms.addEventListener(
      'sourceopen',
      () => {
        if (this.disposed || this.ms !== ms) return; // 已被 dispose / 换成新一轮
        try {
          const sb = ms.addSourceBuffer(type);
          this.sb = sb;
          // 解码/容器级错误是**异步事件**（appendBuffer 对坏数据不抛，probe 实测：
          // sb 的 'error' 事件 + MediaSource 转 closed + video.error）。必须挂监听，
          // 否则页面永远等不到错误提示，只有黑屏。
          sb.addEventListener('error', this.onSbError);
          this.video.addEventListener('error', this.onVideoError);
          this.video.addEventListener('seeked', this.onVideoEvent);
          this.video.addEventListener('timeupdate', this.onVideoEvent);
          // progress：缓冲推进时补规划（首次填充后主要靠它把窗口顶满）
          this.video.addEventListener('progress', this.onVideoEvent);
          // 首轮填充：SourceBuffer 就位后才能发 range 请求
          this.fill();
        } catch (err) {
          this.settleAttemptPipelineError(`追加缓冲初始化失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
      { once: true },
    );
  }

  /**
   * 管线错误：startup 期间 = 这一轮猜错了，拆掉换下一个候选；之后 = 致命，
   * 报给页面（live-play-error）并停掉后续填充 —— 继续喂只是烧 host 的上行带宽。
   *
   * 注意这里是**真错误**（sb 'error' / video error / appendBuffer 抛），不是等字节
   * 超时：只有它才推进 typeIdx 换候选（终审 K）。
   */
  private settleAttemptPipelineError(message: string): void {
    if (this.attemptFailed) {
      this.settleAttempt('wrong');
      return;
    }
    this.fatal(message);
  }

  /** 拆一轮管线（猜错重试与 dispose 共用）：停事件、清队、清在途、摘 src。 */
  private teardownPipeline(): void {
    this.video.removeEventListener('seeked', this.onVideoEvent);
    this.video.removeEventListener('timeupdate', this.onVideoEvent);
    this.video.removeEventListener('progress', this.onVideoEvent);
    this.video.removeEventListener('error', this.onVideoError);
    this.sb?.removeEventListener('error', this.onSbError);
    this.queue.length = 0;
    // 账本与在途一起清：换候选 / 重建管线后从头再来，别把上一轮的覆盖带到下一轮
    this.appended = [];
    // 游标也回 null：新一轮管道的字节流从下一片请求的 start 重新起算
    this.appendCursor = null;
    for (const [rid, ctx] of pendingRanges) {
      if (ctx.player === this) pendingRanges.delete(rid); // 别人名下的不动（多实例理论存在）
    }
    this.inflight = 0;
    // 先摘 src 再 endOfStream：src 还指着即将被 revoke 的 objectURL 时 load() 会报错
    this.video.removeAttribute('src');
    this.video.load();
    const ms = this.ms;
    if (ms && ms.readyState === 'open') {
      try {
        ms.endOfStream();
      } catch {
        /* 已经在关的路上：拆管线不挑时机 */
      }
    }
    this.sb = null;
    this.ms = null;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  /**
   * 「已覆盖」的字节区间 = 已 append 的账本 ∪ 在途（pendingRanges 里本实例的现场）。
   * 在途区间是 Task 2 的模块边界约束，见文件头；账本的来历见 appended 的注释。
   */
  private planBuffered(): Range[] {
    const out: Range[] = [...this.appended];
    for (const ctx of pendingRanges.values()) {
      if (ctx.player === this) out.push({ start: ctx.start, end: ctx.end });
    }
    return out;
  }

  /**
   * 记账：一段字节真的进了 SourceBuffer。相邻/重叠段合并，保持表短小
   * （1MB 一片 × 窗口内若干片，不合并就是几十项线性扫）。
   */
  private markAppended(start: number, byteLength: number): void {
    if (!(byteLength > 0)) return;
    const next: Range[] = [];
    const s = start;
    const e = start + byteLength;
    for (const r of [...this.appended, { start: s, end: e }].sort((a, b) => a.start - b.start)) {
      if (next.length && r.start <= next[next.length - 1].end) {
        next[next.length - 1].end = Math.max(next[next.length - 1].end, r.end); // 相接或重叠 → 并
      } else {
        next.push({ ...r });
      }
    }
    this.appended = next;
  }

  /**
   * 播放位置（秒）→ 字节偏移粗估。host 不知道码率，只能线性估；duration 拿不到
   * （首段还没解出 moov）时返 null，规划器按播放头在 0 处理 —— 新打开的视频本就
   * 该从文件头开始缓冲。
   */
  private currentByte(): number | null {
    const d = this.video.duration;
    if (!this.meta || !Number.isFinite(d) || d <= 0) return null;
    const t = this.video.currentTime;
    if (!Number.isFinite(t) || t < 0) return null;
    return Math.floor((t / d) * this.meta.size);
  }

  /**
   * 串行 append 循环。一次只有一个 appendBuffer 在途，且**只喂游标处那一片**
   * （按字节序、不许跨洞），见文件头。
   *
   * 队头阻塞的语义：游标处那片没到，就停在这儿等 —— 后面的字节已经在队列里排好
   * 了，等 sweep 作废丢帧的 rid 并重拉、那片补到时，下一个 appendChunk 会再把
   * drain 叫起来。宁可卡住也不能跨洞喂：那会让 demuxer 直接报错（实测）。
   */
  private async drain(): Promise<void> {
    if (this.draining) return; // 已在排：while 循环会接着取新入队的帧
    this.draining = true;
    try {
      while (!this.disposed && !this.broken && this.queue.length > 0) {
        const sb = this.sb;
        if (!sb || this.ms?.readyState !== 'open') break;
        if (sb.updating && !(await this.waitUpdateEnd(sb))) break;
        // await 期间可能被 dispose / 拆管线换过 SourceBuffer：三项都对上才继续
        if (this.disposed || this.broken || this.sb !== sb || this.ms?.readyState !== 'open') break;
        // 队头阻塞：只认 seq 正好等于游标的那片（队列已按 seq 升序，队头不对就是有洞）
        const item = this.queue[0];
        if (!item || item.seq !== this.appendCursor) break;
        this.queue.shift();
        try {
          sb.appendBuffer(appendable(item.payload));
        } catch (err) {
          // MediaSource 已关 / type 不认：同步抛的那种。startup 期间算这一轮猜错。
          this.settleAttemptPipelineError(`追加缓冲失败：${err instanceof Error ? err.message : String(err)}`);
          break;
        }
        // 等它落地：video.buffered 这一刻才含这段字节，覆盖区间才能撤（queued--）
        if (!(await this.waitUpdateEnd(sb))) break; // 没落地（error/closed）：错误路径接手
        if (this.disposed || this.broken || this.sb !== sb) break;
        // 顺序要紧：先记账再收尾。settleRange 会顺带触发 fill() 重规划，那一刻
        // 「这段字节已覆盖」必须已经写在账本上，否则同一段会被再请求一次（重复
        // append 会损坏解码）—— 冒烟测试里实测过这个次序颠倒。
        this.markAppended(item.seq, item.payload.byteLength);
        this.appendCursor = item.seq + item.payload.byteLength;
        this.cursorAdvancedAt = Date.now();
        const ctx = pendingRanges.get(item.rid);
        if (ctx) {
          ctx.queued--;
          this.settleRange(item.rid);
        }
        // 首片真的落地 = 这个 type 猜对了：startup 结束，拉满正常窗口，之后 errors 直接走 fatal
        if (this.attemptFailed) this.settleAttempt('alive');
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * 等一次 append 落地。resolve(true) = updateend（字节真的进了缓冲）；
   * resolve(false) = 中途出错或被关（坏数据时 updateend 可能永不来，probe 实测：
   * sb 'error' 后 MediaSource 直接 closed），必须一起听，否则 drain 永久挂起。
   */
  private waitUpdateEnd(sb: SourceBuffer): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const done = (landed: boolean) => (): void => {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error', onErr);
        this.ms?.removeEventListener('sourceclosed', onClose);
        resolve(landed);
      };
      const onEnd = done(true);
      const onErr = done(false);
      const onClose = done(false);
      sb.addEventListener('updateend', onEnd, { once: true });
      sb.addEventListener('error', onErr, { once: true });
      this.ms?.addEventListener('sourceclosed', onClose, { once: true });
    });
  }

  /** 致命错误：只报一次（页面据此转 error 态），停队列、停规划。 */
  private fatal(message: string): void {
    if (this.disposed || this.broken) return;
    this.broken = true;
    this.queue.length = 0;
    if (this.reported) return;
    this.reported = true;
    this.io.onError?.(message);
  }
}

/**
 * appendBuffer 的字节源。
 *
 * TS 5.9 起 Uint8Array 的 buffer 类型参数默认是 ArrayBufferLike（含
 * SharedArrayBuffer），而 appendBuffer 只收 ArrayBuffer 上的视图。链路上的载荷
 * 全部来自 WS 消息的独立 ArrayBuffer（protocol.ts 的 decodeBinaryFrame 构造时
 * 就是 ArrayBuffer），不可能出自 SharedArrayBuffer，所以断言回精确类型 ——
 * 不复制字节（1MB 一片的队列复制不起）。
 */
function appendable(payload: Uint8Array): ArrayBufferView<ArrayBuffer> {
  return payload as unknown as ArrayBufferView<ArrayBuffer>;
}

/** openVideo 的拒绝原因 → 人话。reason 是 host 直出的协议值，文案里说清怎么办。 */
function openFailText(reason: string, mime?: string): string {
  switch (reason) {
    case 'not-found':
      return '主机上找不到这门课（可能刚被删）';
    case 'file-deleted':
      return '主机上的视频文件已删，只能看字幕与讲义';
    case 'unsupported-container':
      return `主机文件是 ${mime || '未知容器'}，实时链路只播 mp4 / webm`;
    case 'file-missing':
      return '主机上的视频文件取不到（存储被清理或正被占用）';
    default:
      return `无法播放：${reason}`;
  }
}
