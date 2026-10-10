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
 *   MAX_RANGE_INFLIGHT=2 匹配：host 读盘并发 2 是这 4 个在途里真正在读 OPFS 的上限。
 *
 * ## append 必须串行
 *
 * 每次 appendBuffer 前等上一次 updateend。并发 append 在 Safari 上会把缓冲打花
 * （同样的段到两次、时间戳乱序），而 Chrome / Firefox 上也只是「看起来没事」——
 * 跨设备链路不能赌浏览器成全，串行是唯一稳的姿势。代价是吞吐上限 = 单 buffer
 * 的解析速度，8MB 窗口下远高于家用上行，付得起。
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
/** 在途请求上限。host 读盘并发 2 是这 4 个里真正在读 OPFS 的上限。 */
const MAX_INFLIGHT = 4;
/**
 * 一个候选的总时限（sourceopen 等不到 / 首片不落地都算猜错）。
 * 10s 够跨一次弱网往返；到点就换下一个候选，页面不会永久停在「连接中」。
 */
const ATTEMPT_TIMEOUT_MS = 10000;
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
}

/**
 * rid → range 现场。guest.ts 的 onBinaryFrame 经 feedRange 找到现场。
 * 模块级：进程内单播放器，见文件头取舍。
 */
const pendingRanges = new Map<number, RangeCtx>();

/** mse.ts 与 guest.ts 之间的组装入口：一片二进制帧到达 → 喂给对应 range 的播放器。 */
export function feedRange(rid: number, seq: number, payload: Uint8Array): void {
  const ctx = pendingRanges.get(rid);
  if (!ctx) return; // 早已收齐/回收的 rid：迟到帧直接丢（host 不会重发风暴）
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
  private ridSeq = 1;
  private objectUrl: string | null = null;
  /** 候选 type 游标：猜错一个换一个（文件头实测 2） */
  private typeIdx = 0;
  /**
   * startup 阶段的判定信号（start() 的循环正等着它）：
   * resolve(true) = 这一轮猜错了，换下一个候选；resolve(false) = 活着。
   * null = 已过 startup，此后的错误直接致命。见 settleAttempt。
   */
  private attemptFailed: ((failed: boolean) => void) | null = null;
  /** 候选总时限句柄：见 ATTEMPT_TIMEOUT_MS */
  private attemptTimer: number | null = null;
  /** 重试轮用小窗口探（PROBE_BYTES），首片落地后置 false 拉满正常窗口 */
  private probing = false;
  /** 待 append 队列：帧到达 → 入队；drain 串行消费（见文件头「append 必须串行」）。 */
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
   * resolve = 有一个候选活着；reject = openVideo 被拒 / 文件大小为 0 / sourceopen
   * 超时 / 候选全试完（页面转 live-play-error）。
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
      const first = this.typeIdx === 0; // 头一把就直接拉满窗口，重试轮才探
      const type = this.nextType();
      if (!type) throw new Error('这台设备解不了这个文件（mp4 / webm 的常见编码组合都试过了）：换台设备打开，或让主机换个编码的视频');
      const failed = await this.tryPipeline(type, first);
      if (!failed) return; // 这一轮活着： startup 结束，之后 errors 直接走 fatal
    }
  }

  /** 一轮规划：pos 钳位 + buffered 并在途 + planFetches → 发请求、记在途。 */
  fill(): void {
    if (this.disposed || this.broken || !this.sb || !this.meta) return;
    const size = this.meta.size;
    const raw = this.currentByte();
    // pos 钳到 [0, size]：currentTime/duration 线性估算在 EOF 附近会过冲
    const pos = raw == null ? null : Math.max(0, Math.min(size, raw));
    const plans = planFetches({
      size,
      buffered: this.planBuffered(),
      chunk: CHUNK_BYTES,
      windowBytes: this.probing ? PROBE_BYTES : WINDOW_BYTES,
      inflight: this.inflight,
      maxInflight: MAX_INFLIGHT,
      pos,
    });
    for (const p of plans) {
      const rid = this.nextRid();
      this.inflight++;
      pendingRanges.set(rid, {
        start: p.start,
        end: p.start + p.len,
        size,
        player: this,
        framesDone: false,
        queued: 0,
      });
      this.io.requestRange(rid, p.start, p.len);
    }
  }

  /** 一帧字节入队。公开是给 feedRange 用（跨模块 glue，见文件头）。seq 是这帧的字节偏移。 */
  appendChunk(rid: number, seq: number, payload: Uint8Array): void {
    if (this.disposed || this.broken) return;
    const ctx = pendingRanges.get(rid);
    if (ctx) ctx.queued++;
    this.queue.push({ rid, seq, payload });
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
    this.settleAttempt(false); // start() 还在等：这一轮算「没失败」，让它直接返回
    this.teardownPipeline();
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

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

  /**
   * guest 侧 range rid 游标：**必须留在 [1, 0x7fffffff]**（高半区 0x80000000+ 是
   * host 单元分片的地盘，命名空间契约见 guest.ts 文件头）。从 1 起而不是 0：rid 0
   * 与「没设置」长得像，日志里分不清。跨候选重试也不回绕 —— 旧请求的字节还在
   * 路上，rid 复用会把迟到的应答配错现场。
   */
  private nextRid(): number {
    const r = this.ridSeq;
    this.ridSeq = this.ridSeq >= 0x7fffffff ? 1 : this.ridSeq + 1;
    return r;
  }

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
   * resolve(true) = 这一轮猜错了（调用方换下一个候选 type 重来）；
   * resolve(false) = 活着。判定依据只有两条：**首片 append 真的落地**（猜对了），
   * 或**这一轮在任何时候报错 / 超时**（猜错了）。中间没有第三种状态 ——
   * 挂着的 start() 会把页面钉在「连接中」。
   */
  private tryPipeline(type: string, first: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.attemptFailed = resolve;
      this.probing = !first;
      // 候选总时限：sourceopen 不来、首片不落地，都算猜错（各兜一种悬挂）
      this.attemptTimer = window.setTimeout(() => this.settleAttempt(true), ATTEMPT_TIMEOUT_MS);
      try {
        this.attachPipeline(type);
      } catch {
        this.settleAttempt(true);
      }
    });
  }

  /**
   * startup 判定收口， attemptFailed 的清理只此一处。
   * failed=true：拆掉这一轮，让 start() 的循环试下一个候选；
   * failed=false：活着（或本实例已 dispose，start() 直接返回）。
   */
  private settleAttempt(failed: boolean): void {
    const resolve = this.attemptFailed;
    this.attemptFailed = null;
    if (this.attemptTimer != null) {
      window.clearTimeout(this.attemptTimer);
      this.attemptTimer = null;
    }
    if (failed) {
      if (!this.disposed) this.teardownPipeline();
    } else if (this.probing && !this.disposed) {
      // 探针落地：把正常窗口拉起来。onRangeDone 触发的那次 fill 还带着探针的
      // 小窗口（probing 还没置位），不补这一下的话整个管道停在 256KB 上。
      this.probing = false;
      this.fill();
    }
    if (!resolve) return;
    resolve(this.disposed ? false : failed);
  }

  /** 建 MediaSource + 挂 src；sourceopen 后 addSourceBuffer + 挂事件 + 首轮填充。 */
  private attachPipeline(type: string): void {
    if (this.disposed) return;
    const ms = new MediaSource();
    this.ms = ms;
    this.objectUrl = URL.createObjectURL(ms);
    this.video.src = this.objectUrl;
    // sourceopen 之前 addSourceBuffer 会抛 InvalidStateError；等不到就由 attemptTimer
    // 兜底（这一轮猜错，换下一个候选），页面不会永久停在「连接中」
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
   */
  private settleAttemptPipelineError(message: string): void {
    if (this.attemptFailed) {
      this.settleAttempt(true);
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

  /** 串行 append 循环。一次只有一个 appendBuffer 在途，见文件头。 */
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
        const item = this.queue.shift()!;
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
        const ctx = pendingRanges.get(item.rid);
        if (ctx) {
          ctx.queued--;
          this.settleRange(item.rid);
        }
        // 首片真的落地 = 这个 type 猜对了：startup 结束，拉满正常窗口，之后 errors 直接走 fatal
        if (this.attemptFailed) this.settleAttempt(false);
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
