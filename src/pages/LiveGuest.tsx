/**
 * guest 镜像页（路由 /live，链接形如 `#/live?relay=wss://…&pair=CODE`）。
 *
 * 文件头三条取舍，与 guest.ts / mse.ts 对齐：
 *
 * 1. **内存镜像，不落库**（不变量 9）。本页没有任何 Dexie import：拉到的索引 /
 *    单元只进 React state，关页面即焚。落库会产生「iPad 上半个课程库、与 Mac 数据
 *    静默分叉」的脏状态，并让人误以为 guest 是独立副本（那是云同步的场景）。
 * 2. **LLM 调用不在本模块**（P2）。问答要在 guest 上发起，必须走 guest 自己设备
 *    设置里的 Key —— 凭据不过链路（不变量 1），host 只发课程数据。
 * 3. **断线三态，文案诚实**：connecting（首次连接 / 重连中 / 主机重连补数据）/
 *    ready / offline（主机已离线或配对码不对）。禁止拿陈旧镜像假装在线 ——
 *    offline 时若还开着课程详情，banner 会明说「这是离线前的内存镜像」。
 *
 * 页面形态刻意做轻：列表 → 详情（封面 + 字幕/对照轨点击跳转 + native controls
 * 播放器）。不复刻本地播放器的全部能力（跟读高亮、倍速面板、讲义联动……）——
 * 那要把本地 store 抽象成 source 接口，是最大的工作量风险，YAGNI。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ListBox } from '@heroui/react';
import { Banner, EmptyState, PageShell, SectionCard, Sym } from '../ui';
import { LiveGuest as LiveGuestClient, type IndexEntry } from '../livelink/guest';
import { GuestMsePlayer, feedRange } from '../livelink/mse';
import { videoUnit } from '../sync/units';
import { formatSize } from '../utils/format';
import './live-guest.css';

type Phase = 'need-code' | 'connecting' | 'ready' | 'offline';

interface Segment {
  idx: number;
  start: number;
  end: number;
  text: string;
  status: 0 | 1;
}
interface Cue {
  start: number;
  end: number;
  text: string;
}
interface Track {
  lang: string;
  lanDoc: string;
  cues: Cue[];
}
/** content 单元载荷的形状（payloads.ts 的 buildContentUnit）。 */
interface ContentUnit {
  segments?: Segment[];
  tracks?: Track[];
}
/** cover 单元载荷的形状（payloads.ts 的 coverUnitFromBlob）。 */
interface CoverUnit {
  blobBase64?: string;
}
/** meta 单元载荷里本页用得到的字段。 */
interface MetaUnit {
  dominantColor?: string;
}

interface Detail {
  entry: IndexEntry;
  /** 无封面时为 null，详情区按 dominantColor 铺占位底色 */
  coverUrl: string | null;
  dominantColor: string | null;
  segments: Segment[];
  tracks: Track[];
  playErr: string;
}

/** 重连退避上限。再长用户就以为坏了；host 的宽限是 60s，8s 一档足够覆盖。 */
const RECONNECT_MAX_MS = 8000;
/** offline 时的判活间隔：轮询 loadIndex，主机回来就恢复（见 pollWhileOffline 注释）。 */
const POLL_INTERVAL_MS = 3000;
/** 中继明说「这门亲事不成」的 close code：房间回收 / 配对码不存在 / 错误配对限流。 */
const FATAL_CLOSE_CODES = [4000, 4001, 4403];
/**
 * 中继 close code → 中文文案。
 *
 * 中继的 close reason 是英文协议值（'room expired' / 'bad code' / 'too many attempts'，
 * 见 live-relay/src/index.ts），原样塞进中文界面等于没翻译。这里每种说清「是什么 +
 * 怎么办」；英文 reason 降级成 console 诊断信息（下面 onClosed 里）。新增 code 要同时
 * 改中继那侧的三常量 —— 两侧的对应关系写在它的文件头。
 */
const CLOSE_REASON_TEXT: Record<number, string> = {
  4000: '房间已过期：主机下线超过 60 秒（或房间被回收），让主机重新打开「实时链路」再试',
  4001: '配对码不存在：主机没在共享，或链接里的码已过期，向主机重新索取链接',
  4403: '配对尝试次数过多，这个房间已被临时锁定：等 5 分钟再用同一个链接',
};

export default function LiveGuest() {
  const [params] = useSearchParams();
  const relay = (params.get('relay') ?? '').trim();
  const pair = (params.get('pair') ?? '').trim();

  const [phase, setPhase] = useState<Phase>(relay && pair ? 'connecting' : 'need-code');
  /** 重连次数（0=首次连接）。只用来说实话的文案，不做业务判断。 */
  const [attempt, setAttempt] = useState(0);
  /** host 在宽限期内回来了（host-link-up）：先回 connecting 重拉索引，别拿旧镜像装在线 */
  const [hostBack, setHostBack] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [courses, setCourses] = useState<IndexEntry[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  /**
   * 「换过连接」计数器。**与下面 genRef 的「实例代际」是两件事，别混**：
   * genRef 让**旧实例的回调作废（防串台）**；connGen 让**播放器重建**。
   *
   * 为什么播放器要跟着它重建：断线重连会新建一个 LiveGuestClient，而播放器 effect
   * 原先只依赖 videoCourseId —— 旧播放器闭包里的 io.requestRange 指着已经关掉的旧
   * client，send() 是 no-op：视频静静停住，没有报错也没有提示（iPad 休眠 / 切 Wi-Fi
   * 与 4G / 中继重启都会触发，终审 C）。所以连接换代时把它 +1，让播放器 effect
   * 重跑、用新 client 重建管道（重建会重拉首窗，可接受）。
   */
  const [connGen, setConnGen] = useState(0);

  /** 连接代际：断线重连会让旧实例的回调全部作废（拿不到状态就悄悄丢，不炸） */
  const genRef = useRef(0);
  const guestRef = useRef<LiveGuestClient | null>(null);
  const playerRef = useRef<GuestMsePlayer | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timerRef = useRef<number | null>(null);
  /** 打开课程的代际：连点两门课时，旧那批 loadUnit 的结果作废 */
  const openSeqRef = useRef(0);
  const attemptRef = useRef(0);

  // connect 的重连路径要再调一次自己，而 useCallback 的自引用会让 TS 推不出类型，
  // 借一个 ref 拐弯（每次渲染同步最新闭包）。
  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    const gen = ++genRef.current;
    const g = new LiveGuestClient({
      relayUrl: relay,
      code: pair,
      // 二进制帧出口： rid 未命中单元现场的视频帧 → MSE 管道
      onBinaryFrame: feedRange,
      onHostDown: () => {
        if (gen === genRef.current) setPhase('offline');
      },
      onHostUp: () => {
        // host-link-up 只说明「主机回来了」，数据要重拉才算数：先回 connecting，
        // 拉到了才 ready；拉不到（主机还没就绪）落 offline 交给轮询
        if (gen !== genRef.current) return;
        setHostBack(true);
        setPhase('connecting');
        void g
          .loadIndex()
          .then((list) => {
            if (gen !== genRef.current) return;
            setCourses(list);
            markLive();
          })
          .catch(() => {
            if (gen === genRef.current) setPhase('offline');
          });
      },
      onClosed: ({ byUs, code, reason }) => {
        if (byUs || gen !== genRef.current) return;
        if (FATAL_CLOSE_CODES.includes(code)) {
          // 中继把原因说死了：房间回收、配对码不存在、错误配对限流。重连没意义。
          // 英文 reason 只进 console（诊断用），界面上给中文文案
          if (reason) console.warn(`[live-guest] 中继关闭连接：${code} ${reason}`);
          setCloseReason(CLOSE_REASON_TEXT[code] ?? reason ?? `连接已断开（${code}）`);
          setPhase('offline');
          return;
        }
        // 网络抖动 / 中继重启：退避重连。host 在 60s 宽限内回来就自动恢复
        // （guest 侧会闪一下「重连中」再重新拉取，全程不用手动操作）
        const next = attemptRef.current + 1;
        attemptRef.current = next;
        setAttempt(next);
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          if (genRef.current === gen) connectRef.current();
        }, Math.min(RECONNECT_MAX_MS, 1000 * 2 ** next));
        setPhase('connecting');
      },
    });
    guestRef.current = g;
    setPhase('connecting');
    void g
      .connect()
      .then(async () => {
        if (gen !== genRef.current) return;
        try {
          const list = await g.loadIndex();
          if (gen !== genRef.current) return;
          setCourses(list);
          markLive();
          // 连接换代 → 播放器重建。这一下是终审 C 的修复：旧播放器闭包里的
          // requestRange 指着马上要被顶替的旧 client，不重建的话视频会静静停住
          // （无报错、无提示）。依赖见 connGen 的声明处。
          setConnGen((n) => n + 1);
        } catch {
          // 链路通着但没人应答（典型：配对码不存在，房间里没有 host）。
          // 落 offline 靠轮询等主机出现，不诈活
          if (gen === genRef.current) setPhase('offline');
        }
      })
      .catch(() => {
        if (gen === genRef.current) setPhase('offline');
      });
    // markLive / connectRef 不进依赖：它们是稳定的（ref + 模块级赋值），进依赖只会
    // 让 effect 每次渲染重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relay, pair]);
  connectRef.current = connect;

  /** 索引拉成功：清掉一切「曾经出过事」的痕迹，进 ready。 */
  const markLive = () => {
    attemptRef.current = 0;
    setAttempt(0);
    setHostBack(false);
    setCloseReason('');
    setPhase('ready');
  };

  useEffect(() => {
    if (relay && pair) connect();
    // React 的 cleanup 在「关标签页」时不一定跑得到（浏览器直接拆页面），而 host
    // 的已连接设备数靠 bye 才减得下来。所以再挂一个 pagehide 兜底 —— 它才是
    // 「页面真的要走了」的标准信号。
    const onPageHide = () => guestRef.current?.close();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      genRef.current++; // 让所有在途回调作废
      if (timerRef.current) window.clearTimeout(timerRef.current);
      window.removeEventListener('pagehide', onPageHide);
      guestRef.current?.close(); // 发 bye：host 的已连接设备数立刻减一
      guestRef.current = null;
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, [connect, relay, pair]);

  /**
   * offline 时的自救轮询。
   *
   * 主恢复路径是中继补发 host-link-up（live-relay 的 host 重连即广播，收到即恢复）；
   * 轮询是兜底：socket 若因别的原因半死（中继换了房间、host 换了配对码），
   * 每 3s 问一次索引，问到就算数。它让「主机重新打开后自动恢复」这条 UX 承诺
   * 不依赖单一信号源。两条路径都收敛到 ready，重复也无害。
   */
  useEffect(() => {
    if (phase !== 'offline') return;
    let stopped = false;
    let inFlight = false;
    const tick = () => {
      const g = guestRef.current;
      if (stopped || inFlight || !g) return;
      inFlight = true;
      void g
        .loadIndex()
        .then((list) => {
          inFlight = false;
          if (stopped) return;
          setCourses(list);
          markLive();
        })
        .catch(() => {
          // 主机还没回来 / socket 已死（重连逻辑会接手）：安静等下一轮
          inFlight = false;
        });
    };
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
    // markLive 是渲染期新建的函数，进依赖会让 effect 每轮重挂；它只读 ref + setState，
    // 语义稳定，这里刻意不跟（与 connect 的注释同一理由）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const openCourse = (entry: IndexEntry) => {
    const seq = ++openSeqRef.current;
    const guest = guestRef.current;
    if (!guest) return;
    // 先摆个空详情：封面位与视频区立刻出现，单元拉完再填内容
    setDetail({ entry, coverUrl: null, dominantColor: null, segments: [], tracks: [], playErr: '' });
    void (async () => {
      // 三个单元并行拉，单个失败不炸页面（cover 拉不到 = 无封面占位，
      // 这是 payloads.ts 定的语义）
      const [content, cover, meta] = await Promise.all([
        guest.loadUnit(videoUnit(entry.id, 'content')).catch(() => null),
        guest.loadUnit(videoUnit(entry.id, 'cover')).catch(() => null),
        guest.loadUnit(videoUnit(entry.id, 'meta')).catch(() => null),
      ]);
      if (openSeqRef.current !== seq) return; // 期间又点了别的课（或重连换代）
      setDetail({
        entry,
        coverUrl: coverUrlOf(cover),
        dominantColor: dominantOf(meta),
        segments: segmentsOf(content),
        tracks: tracksOf(content),
        playErr: '',
      });
    })();
  };

  /**
   * 播放器生命周期挂在**课程 id + 连接代际**上（不是整个 detail 对象！）：video 元素
   * 随详情渲染，ref 就位后建管道；换课 / 换代 / 卸载时 cleanup 里 dispose（否则旧
   * MediaSource 还挂在 video.src 上）。
   *
   * ⚠️ 依赖必须是 entry.id 而不是 detail：onError → setDetail(playErr) 会造出新
   * 的 detail 对象，以 detail 为依赖会把「报错 → 重渲染 → 新建播放器 → 再报错」
   * 走成死循环（冒烟测试里实测过：一个 rid=1 的 range 请求连发了 8 次）。
   * ⚠️ connGen 必须进依赖：断线重连会换一个 LiveGuestClient 实例，旧播放器闭包里的
   * io.requestRange 指着已关闭的旧 client，send() no-op → 视频停住且没有任何提示
   * （终审 C）。代价是重建会重拉首窗，可接受。
   */
  const videoCourseId = detail && detail.entry.kind === 'video' ? detail.entry.id : null;
  useEffect(() => {
    if (!videoCourseId) return;
    const guest = guestRef.current;
    const video = videoRef.current;
    if (!guest || !video) return;
    let disposed = false;
    const id = videoCourseId;
    const setPlayErr = (msg: string) =>
      setDetail((d) => (d && d.entry.id === id ? { ...d, playErr: msg } : d));
    const player = new GuestMsePlayer(
      video,
      {
        openVideo: (vid) => guest.openVideo(vid),
        // range 请求走 guest 的帧通道发出（host 只认 video.range 帧）
        requestRange: (rid, start, len) => guest.requestRange(rid, id, start, len),
        onError: setPlayErr,
      },
      id,
    );
    playerRef.current = player;
    void player.start().catch((e) => {
      if (!disposed) setPlayErr(e instanceof Error ? e.message : String(e));
    });
    return () => {
      disposed = true;
      player.dispose();
      playerRef.current = null;
    };
    // connGen：连接换代就重建播放器（理由见上方注释）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoCourseId, connGen]);

  const seekTo = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = t;
    // 点击本身就是手势，播放不会被自动播放策略拦；被拦也无所谓（已经跳到位了）
    void v.play().catch(() => {});
  };

  const isMaterial = detail?.entry.kind === 'material';
  return (
    <PageShell title="实时链路" wide>
      {phase === 'need-code' && (
        <Banner
          variant="warning"
          testId="live-need-code"
          icon={<Sym name="link" />}
          title="链接不完整"
          description="向主机索取带配对码的链接：主机在「设置 → 实时链路」打开共享后，点「复制链接」发给你。"
        />
      )}
      {phase === 'connecting' && (
        <Banner
          variant="info"
          testId="live-connecting"
          icon={<Sym name="refresh" />}
          title={
            hostBack
              ? '主机已重连，正在重新读取…'
              : attempt === 0
                ? '正在连接主机…'
                : `连接中断，正在重连（第 ${attempt} 次）…`
          }
        />
      )}
      {phase === 'offline' && (
        <Banner
          variant="error"
          testId="live-offline"
          icon={<Sym name="error" />}
          title="主机已离线或配对码不对。主机重新打开「实时链路」后会自动恢复。"
          description={
            closeReason ||
            (detail ? '已显示的是离线前的内存镜像，不会更新；重连后自动刷新。' : '检查主机是否开着应用、链接里的配对码是否最新。')
          }
        />
      )}

      {phase === 'ready' && courses.length === 0 && (
        <EmptyState
          icon={<Sym name="video-library" />}
          title="主机还没有课程"
          description="连接时读取主机当前课程；主机新导入的课程，重连或主机重新开启共享后会出现（实时读取，不写入本机）。"
          testId="live-empty"
        />
      )}

      {courses.length > 0 && (
        <SectionCard
          title="课程"
          subtitle="实时读取主机内容，只看不写；关掉页面即焚"
          testId="card-live-courses"
        >
          <ListBox
          aria-label="主机课程"
          selectionMode="none"
          onAction={(key) => {
            const c = courses[Number(key)];
            if (c) openCourse(c);
          }}
        >
            {courses.map((c) => (
              <ListBox.Item
                key={c.id}
                id={String(courses.indexOf(c))}
                textValue={c.name}
                data-testid="live-course-item"
              >
                <span className="live-guest__row-title">{c.name}</span>
                <span className="live-guest__row-desc">{courseDesc(c)}</span>
              </ListBox.Item>
            ))}
          </ListBox>
        </SectionCard>
      )}

      {detail && (
        <SectionCard
          title={detail.entry.name}
          subtitle={
            detail.entry.kind === 'video'
              ? `${formatSize(detail.entry.size)} · ${formatDuration(detail.entry.duration)}`
              : // P1 未送上链路：别再写「只渲染正文」假装能看，正文压根没发（payloads.ts
                // 只发 meta/content/cover，content 里只有字幕与对照轨）。如实说清，比让
                // 用户点开发现一片空白好。
                'P1 未送上链路：阅读材料正文将在后续版本支持'
          }
          testId="card-live-detail"
        >
          {/* 封面：没有封面不渲染 img，按 dominantColor 铺占位底色（LQIP，
              与 Library 的 video-row__thumb-empty 同一套语义） */}
          <div
            className="live-guest__cover"
            style={detail.dominantColor ? { background: detail.dominantColor } : undefined}
          >
            {detail.coverUrl ? (
              <img
                src={detail.coverUrl}
                alt={`${detail.entry.name} 封面`}
                className="live-guest__cover-img"
                data-testid="live-cover"
              />
            ) : (
              <span className="live-guest__cover-empty" aria-hidden="true">
                <Sym name="image" />
              </span>
            )}
          </div>

          {!isMaterial && (
            <div className="live-guest__video">
              <video ref={videoRef} controls playsInline preload="metadata" data-testid="live-video" />
              {detail.playErr && (
                <div className="live-guest__error" role="alert" data-testid="live-play-error">
                  {detail.playErr}
                </div>
              )}
            </div>
          )}

          <div className="live-guest__subs-title">{isMaterial ? '内容' : '字幕'}</div>
          <ListBox
            className="live-guest__subs"
            aria-label={isMaterial ? '正文' : '字幕'}
            selectionMode="none"
            onAction={(key) => seekTo(detail.segments[Number(key)]?.start ?? 0)}
          >
            {detail.segments.map((s, i) => (
              // 文本走 children（light DOM）：e2e 与 Task 8 要读宿主 textContent
              <ListBox.Item key={i} id={String(i)} textValue={s.text} data-testid="live-subtitle-item">
                <span className="live-guest__sub-text">{s.text}</span>
              </ListBox.Item>
            ))}
          </ListBox>

          {detail.tracks.map((t, ti) => (
            <div key={ti} className="live-guest__tracks">
              <div className="live-guest__subs-title">对照轨 · {t.lanDoc || t.lang}</div>
              <ListBox
                aria-label={`对照轨 ${t.lanDoc || t.lang}`}
                selectionMode="none"
                onAction={(key) => seekTo(t.cues[Number(key)]?.start ?? 0)}
              >
                {t.cues.map((c, ci) => (
                  <ListBox.Item key={ci} id={String(ci)} textValue={c.text} data-testid="live-translation-item">
                    <span className="live-guest__sub-text live-guest__sub-text--alt">{c.text}</span>
                  </ListBox.Item>
                ))}
              </ListBox>
            </div>
          ))}
        </SectionCard>
      )}
    </PageShell>
  );
}

// ── 载荷解析（host 数据可信但形状会漂，页面不赌） ────────────────────────────

function segmentsOf(u: unknown): Segment[] {
  const rows = (u as ContentUnit | null)?.segments;
  if (!Array.isArray(rows)) return [];
  const out: Segment[] = [];
  for (const s of rows) {
    // status 0 的未转写段 text 为空：空占位行只是噪音（host 原样发，过滤是显示层的事）
    if (!s || typeof s.text !== 'string' || !s.text.trim()) continue;
    if (!Number.isFinite(s.start)) continue;
    out.push({ idx: Number(s.idx) || 0, start: s.start, end: Number(s.end) || 0, text: s.text, status: s.status === 1 ? 1 : 0 });
  }
  return out;
}

function tracksOf(u: unknown): Track[] {
  const rows = (u as ContentUnit | null)?.tracks;
  if (!Array.isArray(rows)) return [];
  const out: Track[] = [];
  for (const t of rows) {
    if (!t || !Array.isArray(t.cues)) continue;
    out.push({
      lang: String(t.lang ?? ''),
      lanDoc: String(t.lanDoc ?? ''),
      cues: t.cues.filter((c) => c && typeof c.text === 'string' && Number.isFinite(c.start)),
    });
  }
  return out.filter((t) => t.cues.length > 0);
}

/**
 * cover 单元 → data URL。
 *
 * 载荷里没有 mime（payloads.ts 的 coverUnitFromBlob 只发 videoId/w/h/ts/blobBase64），
 * 所以按 base64 前缀嗅探：封面管线默认写 WebP，编码器不支持时回退 JPEG
 * （见 db.ts 的 CoverRow 注释）。嗅探而不是写死 webp：写死的话回退成 JPEG 的封面
 * 会变成碎图。
 */
function coverUrlOf(u: unknown): string | null {
  const b64 = (u as CoverUnit | null)?.blobBase64;
  if (typeof b64 !== 'string' || !b64) return null;
  return `data:${sniffImageMime(b64)};base64,${b64}`;
}

function sniffImageMime(b64: string): string {
  // 常见图片的 base64 前缀（前 3~4 字节的编码）：
  // JPEG '/9j/'、PNG 'iVBORw0KGgo'、GIF 'R0lGO'、WebP 'UklP'（= 'RIFF'）
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b64.startsWith('R0lGO')) return 'image/gif';
  if (b64.startsWith('UklP')) return 'image/webp';
  return 'image/webp';
}

function dominantOf(u: unknown): string | null {
  const hex = (u as MetaUnit | null)?.dominantColor;
  return typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : null;
}

function courseDesc(c: IndexEntry): string {
  // fileDeleted 是本机事实里唯一进索引的字段（payloads.ts 文件头）：列表上就说清
  // 「能看内容、播不了」，别等用户点进播放器才看到报错
  if (c.fileDeleted) return '文件已删（仅内容可看）';
  const dur = formatDuration(c.duration);
  return dur ? `${formatSize(c.size)} · ${dur}` : formatSize(c.size);
}

/** 秒 → m:ss（Library 的同名函数是页内私有的，不跨页共享，这里照抄一份小的）。 */
function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}
