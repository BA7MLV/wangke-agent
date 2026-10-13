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
 * 播放器）+ 底部问答面板。不复刻本地播放器的全部能力（跟读高亮、倍速面板、讲义联动……）——
 * 那要把本地 store 抽象成 source 接口，是最大的工作量风险，YAGNI。
 *
 * ## P2 接线：四件事都在这一页落地
 *
 * 1. **问答面板**（`components/LiveChatPanel.tsx`）：问的是主机上的 agent loop
 *    （凭据不过链路），流事件由 `LiveGuest` 的 `onTurn` 回调收成本页的 `turns` 状态。
 *    为什么回调在页面而不在面板里挂：`onTurn` 是 client 的**构造期**选项，而 client 由本页
 *    在 `connect()` 里建；要让面板自己订阅就得改 guest.ts 的公开方法集合，那是跨任务契约。
 * 2. **播放进度自动写回**：`timeupdate` / `seeked` / `pause` / `ended` → `guest.setPosition`
 *    （**5s 节流在 guest.ts 内部**，页面不要再自己节流一层 —— 两层节流会让最坏延迟翻倍，
 *    而进度本来就是「最后写入胜出」语义，晚一条无所谓）。
 * 3. **学习时长自动写回**：`livelink/guestStudy.ts` 的追踪器，口径与 `store/studyTime.ts`
 *    逐条对齐，切出来的「某天 N 秒」经 `study.add` op 回主机；**来宾端一个字都不写
 *    IndexedDB**（不变量 9）。为什么这件事值得做，见那个文件的头。
 * 4. **制卡候选审核**：打开面板才拉 `video:<id>:cards` 单元（host 只发待审的，理由见
 *    payloads.ts），复用主机的 `SwipeDeck`，判定经 `guest.decideCard` 走 outbox 回主机。
 *    **乐观更新且不回滚**（理由见 judgeCard 的注释），撤销是再发一条 `status: 0`。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Banner, EmptyState, PanelPlaceholder, PageShell, SectionCard } from '../ui';
import {
  LiveGuest as LiveGuestClient,
  VERSION_MISMATCH_TEXT,
  type GuestTurn,
  type IndexEntry,
} from '../livelink/guest';
import {
  startGuestStudyTracking,
  stopGuestStudyTracking,
  setGuestStudyMediaPlaying,
  markGuestStudyActive,
} from '../livelink/guestStudy';
import LiveChatPanel from '../components/LiveChatPanel';
// SwipeDeck 直接复用主机的那个组件：手势、飞出动画、键盘操作、卡片堆叠视觉都只有一份，
// 复制一份的代价是下一次改交互时来宾这边静默留在旧版（同 chat-panel 的理由）。它要的
// props 类型是 CardRow（见下面 ReviewCard 的注释），落库那份由 decideCard 那一帧负责。
import SwipeDeck from '../components/SwipeDeck';
// SwipeDeck 的样式在 cards.css（卡片堆叠 / 判定印章 / 操作行）。路由全是静态 import，
// 整包早已载入它，这行是**显式声明依赖**（把这个组件搬走时样式跟着走），不是真的加载。
import '../cards.css';
import { CLOSE_PROTOCOL_MISMATCH } from '../livelink/protocol';
import { cardsUnit } from '../livelink/payloads';
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

/** cards 单元载荷里的一张待审卡（payloads.ts 的 CardsUnitCard：只有 id/q/a/time）。 */
interface CardsUnitCard {
  id: number;
  q: string;
  a: string;
  time: number;
}

/**
 * 来宾侧的候选卡行：**结构上与 store/db 的 CardRow 完全一致，故意不 import 那个类型**。
 *
 * 两个理由：① SwipeDeck 的 props 写死了 `pending: CardRow[]`（它与主机面板共用同一个
 * 组件，两边的卡片必须长得一样才谈得上「复用」），所以本地这份要与它互相可赋值；
 * ② 本页刻意不 import `store/db` —— 那是 Dexie 的定义处，「来宾是纯内存镜像、绝不碰
 * 本机库」（不变量 9）靠的就是「这个文件里没有 db import」这个能一眼看出的事实，连类型
 * 都从那儿长出来都让人误会（同 LiveChatPanel 里的 QuizState：那处也是本地定义形状，
 * 理由逐字相同）。
 *
 * `videoId` / `createdAt` 载荷里没有（payloads.ts 不发），补齐只是为了形状完整：
 * `videoId` 是本地标注，SwipeDeck 不读；`createdAt` 主机按 `time` 排（见 host 的
 * handleUnitReq），补 0 不参与任何排序。真正写进主机库的只有 `decideCard` 那一帧。
 */
interface ReviewCard {
  id?: number;
  videoId: string;
  q: string;
  a: string;
  time: number;
  status: 0 | 1 | 2;
  createdAt: number;
}

/**
 * cards 单元的拉取现场。**`err` 与「没有卡」必须分开**：host 对一门没有候选卡的课发的就是
 * 空载荷（正常形态，见 payloads.ts），而 `err` 是拉取真的失败（unit.err / 超时 / 断链）。
 * 两者显示的话术与可做的动作完全不同 —— 把失败显示成「没有待审核的卡片」，用户会以为
 * 主机上确实一张卡都没有，而他其实什么也没读到。
 */
interface CardsState {
  loading: boolean;
  rows: ReviewCard[];
  err?: string;
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
/**
 * 「别重连了，说清楚为什么」的 close code：房间回收 / 配对码不存在 / 错误配对限流
 * （这三个由中继发，见 live-relay 的文件头），加上 **4400 版本不匹配**（由 host 发，
 * 见 protocol.ts 的 CLOSE_PROTOCOL_MISMATCH）。
 *
 * 不在表里的码按网络抖动处理：退避重连。4400 进表的理由是重连永远救不了它 —— 说这句
 * 话的主机与本页不是同一个协议版本（多半是这一页比主机旧），刷新才是修复动作，重连只会
 * 原样再来一遍。
 */
const FATAL_CLOSE_CODES = [4000, 4001, 4403, CLOSE_PROTOCOL_MISMATCH];
/**
 * close code → 中文文案。
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
  // ⚠️ 这里**引用** guest.ts 的 VERSION_MISMATCH_TEXT，不写第二份字符串：同一个故障在界面上
  // 出现两种说法，用户分不出它们其实是同一件事，而两边那句话的分歧点只有一句「刷新页面」
  // 这么关键的修复动作（guest.ts 的 VERSION_MISMATCH_TEXT 注释把这条钉成了跨任务契约）。
  // 另一条通向这句话的路（welcome 的 hostVersion 对不上）走的是 onError，那边也已经引它。
  [CLOSE_PROTOCOL_MISMATCH]: VERSION_MISMATCH_TEXT,
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
   * 当前链路客户端（只用来把它交给问答面板的 props —— ref 变更不触发重渲染，
   * 而面板要在详情打开时立刻拿到**这一代**的 client）。
   */
  const [client, setClient] = useState<LiveGuestClient | null>(null);
  /** 已发起的问答轮次快照（onTurn 收集，按发起顺序）。换课/换代时清空，见各处注释 */
  const [turns, setTurns] = useState<GuestTurn[]>([]);
  /** outbox 里待补发的 op 条数。**0 时不显示** —— 它是用户唯一能看出「数据卡住了」的信号 */
  const [pendingOps, setPendingOps] = useState(0);
  /** 版本不匹配那句（onError）。与 closeReason 分开：那一类是「连接没了」，这一类是「连接在、但对不上」 */
  const [versionError, setVersionError] = useState('');
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

  /**
   * cards 单元的现场。**null = 还没拉过**（面板没打开）—— 与「拉到了、里面是空的」分成
   * 两态：前者是用户还没要求看，后者是主机上确实没有候选卡，两者该说的话术不同。
   */
  const [cardsState, setCardsState] = useState<CardsState | null>(null);
  /** 本次审核的判定顺序（卡片 id 栈）。撤销取栈顶，与主机面板 CardsPanel 的 history 同款 */
  const [cardHistory, setCardHistory] = useState<number[]>([]);

  /** 连接代际：断线重连会让旧实例的回调全部作废（拿不到状态就悄悄丢，不炸） */
  const genRef = useRef(0);
  const guestRef = useRef<LiveGuestClient | null>(null);
  const playerRef = useRef<GuestMsePlayer | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timerRef = useRef<number | null>(null);
  /** 打开课程的代际：连点两门课时，旧那批 loadUnit 的结果作废 */
  const openSeqRef = useRef(0);
  const attemptRef = useRef(0);
  /** cards 拉取的代际：换课时让在途的那次 loadUnit 作废（理由见 loadCards） */
  const cardsSeqRef = useRef(0);
  /**
   * `cardHistory` 的镜像：撤销要读「上一张是哪个」，而那个值在 setState 的 updater 里
   * 拿不到（副作用不能写在 updater 里：StrictMode 会调两次，于是同一帧 op 发两遍）。
   * 单一真源仍是 state，ref 只在渲染期同步一份（同 connectRef 的写法）。
   */
  const cardHistoryRef = useRef<number[]>([]);
  cardHistoryRef.current = cardHistory;

  // connect 的重连路径要再调一次自己，而 useCallback 的自引用会让 TS 推不出类型，
  // 借一个 ref 拐弯（每次渲染同步最新闭包）。
  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    const gen = ++genRef.current;
    // 换代即清空：旧 client 的 outbox / 轮次 / 待补发数都随它一起作废（genRef 让它的
    // 回调全部打不开），留着显示只会让用户看见一个永远不动的「N 条待补发」。
    setTurns([]);
    setPendingOps(0);
    setVersionError('');
    const g = new LiveGuestClient({
      relayUrl: relay,
      code: pair,
      // 二进制帧出口： rid 未命中单元现场的视频帧 → MSE 管道
      onBinaryFrame: feedRange,
      // 待补发条数：0 时 UI 自己不显示（这一条在 guest.ts 的注释里就写明了）
      onPendingOps: (n) => {
        if (gen === genRef.current) setPendingOps(n);
      },
      /**
       * 一轮问答的状态变化。**每次给一份新副本**（guest.ts 的纪律），所以这里可以直接
       * 按 turnId 覆盖：首次见到就追加（保持发起顺序），之后再见到就地替换。
       *
       * 为什么代际判断放在最外层：断线重连后旧 client 还可能吐出最后几个回调，
       * 那些 turn 的流事件已经没人接了（host 那边那一轮也随 bye 被 abort），
       * 混进新列表就是一条永远停在「思考中…」的空气泡。
       */
      onTurn: (turn) => {
        if (gen !== genRef.current) return;
        setTurns((prev) => {
          const i = prev.findIndex((t) => t.turnId === turn.turnId);
          if (i < 0) return [...prev, turn];
          const next = prev.slice();
          next[i] = turn;
          return next;
        });
      },
      /**
       * 显式错误（当前只有版本不匹配）。**不并进 closeReason**：那一句要单独占一条
       * banner（refresh 才是修复动作，重连救不了），而 closeReason 是挂在离线 banner
       * 描述里的。两条并成一处，用户会以为「主机不在了」而去查主机有没有开共享。
       */
      onError: (msg) => {
        if (gen === genRef.current) setVersionError(msg);
      },
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
    setClient(g);
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
    //
    // ⚠️ 这条钩子**不发进度**：进度与学习时长的「尽力补发」在更里面一层
    // （guest.ts 的 IO 壳与 guestStudy.ts 各自挂了 pagehide/visibilitychange）。
    // 这里只负责 bye —— host 的在席表靠它减。
    const onPageHide = () => guestRef.current?.close();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      genRef.current++; // 让所有在途回调作废
      if (timerRef.current) window.clearTimeout(timerRef.current);
      window.removeEventListener('pagehide', onPageHide);
      guestRef.current?.close(); // 发 bye：host 的已连接设备数立刻减一
      guestRef.current = null;
      setClient(null);
      playerRef.current?.dispose();
      playerRef.current = null;
      stopGuestStudyTracking();
    };
  }, [connect, relay, pair]);

  /**
   * 学习时长追踪：与主机侧同一套判定口径，切出来的「某天 N 秒」逐条转成 `study.add` op
   * （走 outbox，离线也只入队不丢）。**来宾端不写 IndexedDB**（不变量 9）。
   *
   * 挂在 `connGen` 上而不是挂一次：断线重连会换一个 client，新 client 的 outbox 才是
   * 往哪儿发的地方；用旧 client 的引用发出去的话，那些秒数会在已关闭的连接上静默丢掉。
   * cleanup 走 `stopGuestStudyTracking`（它内部会先补发最后一段再摘定时器）。
   */
  useEffect(() => {
    const g = client;
    if (!g) return;
    return startGuestStudyTracking((slices) => {
      for (const s of slices) g.addStudy(s.date, s.seconds);
    });
    // connGen：连接换代就把追踪器绑到新 client 上（理由见上）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connGen, client]);

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
    // 换课即换会话：问答轮次是按 course 发的（chat.req 带 videoId），留着上一门的
    // 轮次会让用户在这门课里看到别的课的回答，而且「停止」会停一个不属于这门的轮次。
    setTurns([]);
    // 候选卡同理，而且比问答更危险：判定栈留着上一门的 cardId 时，「撤销」会把**A 门的
    // cardId** 发成 `card.decide`（ops.ts 的 applyCardDecide 只看 cardId 不看 videoId，
    // 于是它会把 A 门那张卡真的改回去，而用户以为自己在撤 B 门的判定）。面板回到未打开态。
    cardsSeqRef.current++; // 让在途的那次 cards 拉取作废
    setCardsState(null);
    setCardHistory([]);
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

    /**
     * 进度自动写回（`position.set` op）。
     *
     * **节流在 guest.ts 内部**（5s），页面这一层刻意不再节流：`setPosition` 每次调用只是
     * 覆盖内存里那一格（最后写入胜出），真正的发送由 guest 的 tick 与 flush 把关。
     * 页面再套一层节流的代价是「拖到 40 分钟然后关页面」那一刻的精确位置可能压根没进过
     * 那一格 —— 而那恰恰是最常见的用法。
     *
     * `force`（跳过节流立即发）用在**用户从「在动」转为「不动」的那一下**：暂停 / 拖完 /
     * 播完 / 换课 / 关页面。不 force 的只有 `timeupdate`（播放中，每秒好几次，靠节流压）。
     *
     * `finished` 口径与本机 Player.tsx 的 `setTime(time, ended)` **逐字一致**：
     * `lastPosition` 永远写真实位置（播完停在结尾），「播完后再打开从头来」由 host 侧
     * 的 finished 标记 + 读取时翻译。写成 `video.ended` 而不是「duration - 1」那种近似，
     * 理由同上：近似值会让「看没看完」在片尾附近判错。
     */
    const pushPosition = (force: boolean) => {
      if (disposed) return;
      const t = video.currentTime;
      // 时长没探到时 currentTime 是 NaN，别把垃圾写进主机（applyPosition 会回 bad-args，
      // 但那时用户已经白等了一次往返）
      if (!Number.isFinite(t) || t < 0) return;
      guest.setPosition(id, t, video.ended);
      if (force) guest.flushPosition();
    };
    const onTimeUpdate = () => pushPosition(false);
    const onSeeked = () => pushPosition(true);
    const onPause = () => {
      pushPosition(true);
      // 暂停后恢复普通空闲判定（播放中的「不判空闲」只对还在播的媒体成立）
      setGuestStudyMediaPlaying(false);
    };
    const onPlay = () => setGuestStudyMediaPlaying(true);
    const onEnded = () => {
      pushPosition(true);
      setGuestStudyMediaPlaying(false);
    };
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('pause', onPause);
    video.addEventListener('play', onPlay);
    video.addEventListener('ended', onEnded);

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
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('ended', onEnded);
      /**
       * 换课 / 换代 / 卸载：**先补发再 dispose**。
       *
       * guest.ts 的 `pendingPosition` 只有一格，而 `setPosition` 是「覆盖那一格」。
       * 不在这里 flush 掉旧课那一条，紧接着新播放器/新课程的第一条 timeupdate 就会把它
       * 顶掉 —— 表现是「刚看完第一节课，进第二节，进度条又回到第一节开头」，
       * 而且全程没有任何报错。flush 不走 outbox，秒发一帧，代价可以忽略。
       */
      guest.flushPosition();
      setGuestStudyMediaPlaying(false);
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

  // ── 制卡候选（P2）：拉 cards 单元 + 滑动审核（写回走 card.decide op） ─────────────

  /**
   * 拉这门课的待审候选卡。**打开面板时才拉**（不是跟着 openCourse 一起拉）：
   * 绝大多数来宾只看不问也不审卡，先把一份用不上的单元拉过来是白占带宽，而 unit.req
   * 在 host 侧要查一次 cards 表 + gzip + 分片（payloads.ts 的整条载荷构造）。
   *
   * 代际判断与 openCourse 的那批 loadUnit 同理：拉取期间用户换了课、点了重读，
   * 旧那次的结果一律作废（否则会出现「面板里是 A 门的卡，而详情已经是 B 门」）。
   */
  const loadCards = useCallback(async () => {
    const guest = guestRef.current;
    const courseId = detail?.entry.id;
    if (!guest || !courseId) return;
    const seq = ++cardsSeqRef.current;
    setCardsState({ loading: true, rows: [] });
    try {
      const unit = await guest.loadUnit(cardsUnit(courseId));
      if (seq !== cardsSeqRef.current) return;
      setCardsState({ loading: false, rows: reviewCardsOf(unit, courseId) });
    } catch (e) {
      if (seq !== cardsSeqRef.current) return;
      // **失败不显示成「没有卡」**：那是两种完全不同的事实（见 CardsState 的注释）
      setCardsState({ loading: false, rows: [], err: e instanceof Error ? e.message : String(e) });
    }
  }, [detail?.entry.id]);

  /**
   * 判定一张卡：内存里的镜像先改，再发一帧 `card.decide`。
   *
   * **乐观更新，落库结果不回滚到 UI**。为什么不等 ack 再改界面：滑动是连续的显式动作，
   * 等一次网络往返（家中继通常 <1s，弱网能到好几秒）会让每一次滑动都「先停一下再走」，
   * 手感发涩 —— 而这次手势要回滚的场景并不比 ack 丢失更糟：`card.decide` 走 outbox
   * （guest.ts 的三条路径之一，至少送达一次，看门狗按同 opId 原样重发），断链时排队、
   * 主机回来后自动补上；真丢了的代价是主机上少一张卡的判定，来宾重开面板就能看到
   * （它还是待审），而**界面卡住不动**的代价是用户以为程序坏了，滑动直接不敢用。
   * 这与主机面板 CardsPanel 的 `judge` 是同一套口径（那边也是内存先行 + fire-and-forget）。
   *
   * `client` 取自 guestRef 而不是 state 闭包：断线重连会换 client，页面里其它写操作
   * （进度 / 学习时长的 effect）都刻意绑在新 client 上，这里同理 —— 拿着已关闭的旧
   * client 发出去，那一帧会静默丢掉（send 的 readyState 守卫直接 return，不报错）。
   */
  const judgeCard = useCallback(
    (card: ReviewCard, keep: boolean) => {
      const id = card.id;
      const guest = guestRef.current;
      const courseId = detail?.entry.id;
      if (id == null || !guest || !courseId) return;
      const status: 1 | 2 = keep ? 1 : 2;
      setCardsState((s) =>
        s ? { ...s, rows: s.rows.map((r) => (r.id === id ? { ...r, status } : r)) } : s,
      );
      setCardHistory((h) => [...h, id]);
      guest.decideCard(courseId, id, status);
    },
    [detail?.entry.id],
  );

  /**
   * 撤销上一张：**再发一条 status:0 的 `card.decide`**，不是「发一条反向 op」。
   * 与主机面板 undo 的落库语义逐字一致（`db.cards.update(id, {status: 0})`）：op 面
   * 只有一种 op、参数里的 status 就是判定的最终值，反向 op 会让「撤销」在 outbox 里变成
   * 第二种语义的东西，而断链重发时两种都得幂等 —— 多一种语义就多一处可能漂移的地方。
   */
  const undoCard = useCallback(() => {
    const guest = guestRef.current;
    const courseId = detail?.entry.id;
    const last = cardHistoryRef.current[cardHistoryRef.current.length - 1];
    if (last == null || !guest || !courseId) return;
    cardHistoryRef.current = cardHistoryRef.current.slice(0, -1);
    setCardHistory(cardHistoryRef.current);
    setCardsState((s) =>
      s ? { ...s, rows: s.rows.map((r) => (r.id === last ? { ...r, status: 0 as const } : r)) } : s,
    );
    guest.decideCard(courseId, last, 0);
  }, [detail?.entry.id]);

  /** 待审 / 已保留 / 已审计数。候选卡单元只发待审的，判过的那几张留在 rows 里当计数 */
  const reviewRows = cardsState?.rows ?? [];
  const pendingCards = reviewRows.filter((r) => r.status === 0);
  const keptCards = reviewRows.filter((r) => r.status === 1).length;
  const judgedCards = reviewRows.length - pendingCards.length;
  /** 主机在不在线（与问答面板同一个判据）。离线时读单元只会挂到超时，见 loadCards 的注释 */
  const cardsOnline = phase === 'ready';
  return (
    <PageShell title="实时链路" wide>
      {phase === 'need-code' && (
        <Banner
          variant="warning"
          testId="live-need-code"
          icon={<mdui-sym-link />}
          title="链接不完整"
          description="向主机索取带配对码的链接：主机在「设置 → 实时链路」打开共享后，点「复制链接」发给你。"
        />
      )}
      {phase === 'connecting' && (
        <Banner
          variant="info"
          testId="live-connecting"
          icon={<mdui-sym-refresh />}
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
          icon={<mdui-sym-error />}
          title="主机已离线或配对码不对。主机重新打开「实时链路」后会自动恢复。"
          description={
            closeReason ||
            (detail ? '已显示的是离线前的内存镜像，不会更新；重连后自动刷新。' : '检查主机是否开着应用、链接里的配对码是否最新。')
          }
        />
      )}
      {/* 版本不匹配**单独**一条，且优先级高于离线那条（它可能同时为真）：
          「主机已离线」在这里是误导 —— 主机在线、配对码也对，只是两页版本不同，
          用户会去查主机有没有开共享，而那个动作对版本差一点用都没有。修复动作只有一个：
          刷新页面。 */}
      {versionError && (
        <Banner variant="error" testId="live-version-error" icon={<mdui-sym-error />} title={versionError} />
      )}

      {phase === 'ready' && courses.length === 0 && (
        <EmptyState
          icon={<mdui-sym-video-library />}
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
          <mdui-list>
            {courses.map((c) => (
              <mdui-list-item
                key={c.id}
                headline={c.name}
                description={courseDesc(c)}
                data-testid="live-course-item"
                onClick={() => openCourse(c)}
              />
            ))}
          </mdui-list>
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
                <mdui-sym-image />
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
          <mdui-list className="live-guest__subs">
            {detail.segments.map((s, i) => (
              // 文本走默认插槽（light DOM）：mdui-list-item 的 headline 属性渲染在
              // shadow DOM 里，宿主元素的 textContent 读不到（Task 8 e2e 要读文本）
              <mdui-list-item
                key={i}
                data-testid="live-subtitle-item"
                onClick={() => seekTo(s.start)}
              >
                <span className="live-guest__sub-text">{s.text}</span>
              </mdui-list-item>
            ))}
          </mdui-list>

          {detail.tracks.map((t, ti) => (
            <div key={ti} className="live-guest__tracks">
              <div className="live-guest__subs-title">对照轨 · {t.lanDoc || t.lang}</div>
              <mdui-list>
                {t.cues.map((c, ci) => (
                  <mdui-list-item
                    key={ci}
                    data-testid="live-translation-item"
                    onClick={() => seekTo(c.start)}
                  >
                    <span className="live-guest__sub-text live-guest__sub-text--alt">{c.text}</span>
                  </mdui-list-item>
                ))}
              </mdui-list>
            </div>
          ))}
        </SectionCard>
      )}

      {/*
        制卡审核：放在详情之后、提问之前（审核是「看内容」的一部分，提问是最后一步）。
        ⚠️ 复用主机的 SwipeDeck 组件，不重写手势与飞出动画（理由见 import 处）。
      */}
      {detail && (
        <SectionCard
          title="卡片审核"
          subtitle="主机为这门课生成的问答卡：右滑保留、左滑丢弃，可撤销。判定写回主机，来宾这边不留副本（重新读一次后计数从本次开始）"
          testId="card-live-cards"
          actions={
            cardsState === null ? (
              <mdui-button
                variant="filled"
                data-testid="live-cards-open"
                disabled={!cardsOnline}
                onClick={() => void loadCards()}
              >
                <mdui-sym-style slot="icon" />
                查看候选卡
              </mdui-button>
            ) : (
              // 重新读取：主机那边刚生成 / 刚审完一批时，把这一份内存镜像追平
              <mdui-button-icon
                data-testid="live-cards-reload"
                aria-label="重新读取候选卡"
                disabled={cardsState.loading || !cardsOnline}
                onClick={() => void loadCards()}
              >
                <mdui-sym-refresh />
              </mdui-button-icon>
            )
          }
        >
          {cardsState === null && (
            <PanelPlaceholder testId="live-cards-idle">
              {/* 离线时不放行读取：loadUnit 会挂在 30s 超时上（guest.ts 的 UNIT_TIMEOUT_MS），
                  用户看到的是一段没反应的「正在读取…」，而这里一句就能说清原因。 */}
              {cardsOnline
                ? '候选卡生成在主机上（播放页「卡片」）。点右上角「查看候选卡」把它读过来，滑动就能审。'
                : '主机不在线，读不到候选卡。主机回来后（页面会自动恢复）再点右上角重试。'}
            </PanelPlaceholder>
          )}
          {cardsState?.loading && <PanelPlaceholder testId="live-cards-loading">正在读取候选卡…</PanelPlaceholder>}
          {cardsState?.err && (
            <Banner
              variant="error"
              testId="live-cards-err"
              icon={<mdui-sym-error />}
              title={`候选卡没读到：${cardsState.err}`}
              description="链路刚断开或主机没在席时会出现。恢复后点右上角重新读取。"
            />
          )}
          {/* 「一张都没有」与「拉取失败」分开说：前者是主机上确实没有候选卡（正常形态，
              空载荷也是正常响应），后者是这次什么也没读到。 */}
          {cardsState && !cardsState.loading && !cardsState.err && pendingCards.length === 0 &&
            (reviewRows.length === 0 ? (
              <PanelPlaceholder testId="live-cards-empty">这门课没有待审核的卡片</PanelPlaceholder>
            ) : (
              <div className="cards-summary" data-testid="live-cards-summary">
                <span className="text-secondary">
                  {/* 「本次」是实话：候选卡单元只发待审的，所以重新读一次之后计数从 0 开始
                      （主机那边保留/丢弃的总数以主机面板为准，见 payloads.ts 的取舍）。 */}
                  本次审完：保留 {keptCards} · 丢弃 {judgedCards - keptCards}（已写回主机）
                </span>
                {/* 审完后仍要能反悔最后一张（与主机面板同款：撤销入口在汇总行而不是消失） */}
                <mdui-button-icon
                  data-testid="live-cards-undo"
                  aria-label="撤销上一张"
                  disabled={cardHistory.length === 0}
                  onClick={undoCard}
                >
                  <mdui-sym-undo />
                </mdui-button-icon>
              </div>
            ))}
          {/* 有待审卡才挂 SwipeDeck：它 `pending` 为空时 return null，留着只会挂一个空壳 */}
          {cardsState && !cardsState.loading && !cardsState.err && pendingCards.length > 0 && (
            <SwipeDeck
              pending={pendingCards}
              keptCount={keptCards}
              judgedCount={judgedCards}
              onJudge={judgeCard}
              onUndo={undoCard}
              canUndo={cardHistory.length > 0}
              // 卡片带的是字幕时间，跳播放头要用本机那个视频元素；材料课上没有播放器，
              // seekTo 在 videoRef 为空时直接返回（而材料课本来也不会有候选卡：制卡是从
              // 字幕提炼的，材料课没有字幕）
              onSeek={seekTo}
            />
          )}
        </SectionCard>
      )}

      {/*
        问答面板：放在详情卡片**之后**（而不是并排放侧栏），理由是这页的既定形态就是
        单列堆叠（PageShell 一列、卡片一张张往下），镜像页的使用姿势又以竖屏 iPad 为主 ——
        侧栏会把播放器压到不足一半宽。面板内部自己有滚动区与高度上限，所以它不会把上面的
        字幕列表顶出屏幕。
      */}
      {detail && client && (
        <SectionCard
          title="提问"
          subtitle="提问在主机上回答，答案与记录都留在主机的这门课里；来宾这边只看不写"
          testId="card-live-chat"
        >
          {/* 待补发提示。**0 时不渲染**：它是「数据卡住了」的唯一信号，一直挂着一条
              「0 条待补发」只会变成没人看的装饰（guest.ts 的 onPendingOps 注释同款口径）。 */}
          {pendingOps > 0 && (
            <div className="live-guest__pending" role="status" data-testid="live-pending-ops">
              <mdui-sym-refresh />
              <span>{pendingOps} 条操作待补发（主机回来后会自动重发）</span>
            </div>
          )}
          <LiveChatPanel
            guest={client}
            turns={turns}
            videoId={detail.entry.id}
            videoName={detail.entry.name}
            isMaterial={isMaterial}
            materialKind={detail.entry.materialFormat === 'pdf' || !detail.entry.materialFormat ? 'page' : 'para'}
            {...(isMaterial ? {} : { onSeek: seekTo })}
            online={phase === 'ready'}
            onAsk={markGuestStudyActive}
          />
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

/**
 * cards 单元 → 本地镜像的候选卡行。**逐项过形状**（与 segmentsOf / tracksOf 同款纪律：
 * host 数据可信但载荷形状会漂，页面不赌），坏项丢掉而不是把 `undefined` 渲染到卡面上。
 *
 * `status` 恒为 0：单元只发待审（payloads.ts 的不变量），拉到即待审。`videoId` /
 * `createdAt` 是补齐形状的本地字段（ReviewCard 的注释里写了理由），不发出去。
 */
function reviewCardsOf(u: unknown, videoId: string): ReviewCard[] {
  const rows = (u as { cards?: CardsUnitCard[] } | null)?.cards;
  if (!Array.isArray(rows)) return [];
  const out: ReviewCard[] = [];
  for (const c of rows) {
    // 没有正整数 id 的卡判不了（card.decide 的 cardId 要打中主机那一行），丢掉
    if (!c || typeof c.q !== 'string' || typeof c.a !== 'string') continue;
    if (!Number.isInteger(c.id) || c.id <= 0) continue;
    out.push({
      id: c.id,
      videoId,
      q: c.q,
      a: c.a,
      time: Number.isFinite(c.time) ? c.time : 0,
      status: 0,
      createdAt: 0,
    });
  }
  return out;
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
