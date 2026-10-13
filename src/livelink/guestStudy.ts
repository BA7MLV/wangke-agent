/**
 * 来宾侧的学习时长追踪（镜像页专用）：判定口径与 `store/studyTime.ts` **逐条对齐**，
 * 但**不落库**——它只把「某天 N 秒」交给页面，由页面转成 `study.add` op 回主机。
 *
 * ## 为什么来宾的学习时长也要回主机
 *
 * 这条链路的主要使用姿势是「主机在 Mac 上放着共享，用户拿着 iPad 看课」。学习时长记在
 * **正在学的那台设备**上才对：记在主机上等于把「我在 iPad 上看了两小时」记成「Mac 前台
 * 程序跑了两小时」，热力图立刻失真，而且用户没法在自己真正用的那台设备上看到自己的记录。
 * 落点仍然只有主机的 Dexie 库（不变量 9：guest 是只读镜像），所以本模块只负责**算**，
 * 不负责**存** —— 存的那一步是 op（`livelink/ops.ts` 的 `applyStudyAdd`，全应用唯一出口）。
 *
 * ## 为什么口径必须复用同一套纯逻辑
 *
 * 热力图（`Study` 页 / `StudyTimeCard`）是从主机库里那一张 `studyDays` 表读出来算的。
 * 如果来宾端自己判一遍「算不算学习」，同一段时间会被两种算法记账：一次在 iPad 上的学习
 * 可能在主机这边不算数（空闲阈值或心跳口径不同），热力图上就少了一格，而那格少在哪里
 * 用户根本无从查起。所以：
 *   - **纯逻辑**（`utils/studyLog.ts`）直接复用，不重写：`splitByDay` 按本地零点切天、
 *     `mergeSeconds` 同日累加、精度由 `round1` 统一；
 *   - **判定**（可见 + 未空闲 + 播放中不判空闲）照抄 `store/studyTime.ts` 的 `shouldCount`，
 *     连常量的数值都取同一个（见下面四个常量对那边的 TICK_MS / MAX_TICK_MS / FLUSH_EVERY_TICKS）。
 *
 * 唯一真正无法对齐的是**空闲阈值的主语**：主机读本机设置 `studyIdleMinutes`，来宾读不到
 * 主机设置（链路不发本机偏好，见 payloads.ts 的「字段取舍的总原则」），所以这里取那个
 * 设置的**默认值**（5 分钟）。这一条写在这里而不是藏起来：将来要把主机设置送下来，
 * 改的是这一个常量，不是整套算法。
 */

import { mergeSeconds, splitByDay, type StudyDay } from '../utils/studyLog';

/**
 * 心跳间隔。**与 store/studyTime.ts 的 `TICK_MS` 同值**：两边各写一个「差不多」的数，
 * 将来改了一处就会让两边的曲线对不齐，而那种偏差在任何界面上都看不出来。
 */
export const GUEST_STUDY_TICK_MS = 15_000;

/**
 * 单次心跳最多计入的秒数。设备睡眠 / 浏览器后台节流时定时器不触发，醒来后的
 * `now - lastTick` 可能是几小时 —— 那段时间人不在，不能补记。截断到两个心跳周期，
 * 与 `store/studyTime.ts` 的 `MAX_TICK_MS` 同一条理由、同一个数值。
 */
export const GUEST_STUDY_MAX_TICK_MS = GUEST_STUDY_TICK_MS * 2;

/**
 * 攒够几次心跳 emit 一次（15s × 4 = 1 分钟）。与主机侧的 `FLUSH_EVERY_TICKS` 同值：
 * **每一次 emit 就是一条 outbox 记录 + 一帧 + 一次 ack**，比主机写一次 IndexedDB 事务
 * 更贵，所以更需要攒着发。
 */
export const GUEST_STUDY_FLUSH_EVERY_TICKS = 4;

/**
 * 空闲阈值（毫秒）。主机侧取自设置 `studyIdleMinutes`，其默认值就是 5 分钟
 * （见 store/studyTime.ts 的 `Math.max(1, s.studyIdleMinutes || 5)`）。
 * 来宾读不到主机设置（见文件头），所以取同一个默认值。
 */
export const GUEST_STUDY_IDLE_MS = 5 * 60_000;

/**
 * 算「有操作」的输入事件。**与 store/studyTime.ts 的 `ACTIVITY_EVENTS` 逐条相同** ——
 * pointermove / wheel 覆盖「只在页面上滑动阅读」的情况，touchstart 覆盖 iPad。
 */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/** 定时器注入口（与 guest.ts 的 `GuestTimers` 同形：让时间行为能在 Node 里被精确断言） */
export interface GuestStudyTimers {
  setInterval(fn: () => void, ms: number): number;
  clearInterval(handle: number): void;
}

const GLOBAL_TIMERS: GuestStudyTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
  clearInterval: (h) => clearInterval(h),
};

export interface GuestStudyDeps {
  now?: () => number;
  timers?: GuestStudyTimers;
  /** 页面是否可见。不给就读 `document.visibilityState`（Node 里没有 document，所以可注入） */
  isVisible?: () => boolean;
  /** 挂「有操作」监听，返回解绑函数。不给就绑下面那五个 window 事件 */
  bindActivity?: (mark: () => void) => () => void;
  /**
   * 挂「页面隐藏 / 卸载」监听（隐藏或卸载时补发内存里最后一段），返回解绑函数。
   * 不给就绑 `visibilitychange→hidden` 与 `pagehide` 两个（理由见下面 start 里的注释）。
   */
  bindHidden?: (flush: () => void) => () => void;
  idleMs?: number;
  tickMs?: number;
  maxTickMs?: number;
  flushEveryTicks?: number;
}

// ── 模块级状态（刻意不进 React：每 15s 变一次，进 store 会把整页拖进无谓重渲染）──
let started = false;
let timer: number | undefined;
let timers: GuestStudyTimers = GLOBAL_TIMERS;
let now: () => number = Date.now;
let visible: () => boolean = () => true;
let emit: (slices: StudyDay[]) => void = () => {};
let bindActivity: (mark: () => void) => () => void;
let bindHidden: (flush: () => void) => () => void;
let unbindActivity: (() => void) | null = null;
let unbindHidden: (() => void) | null = null;
let limits = { idleMs: GUEST_STUDY_IDLE_MS, tickMs: GUEST_STUDY_TICK_MS, maxTickMs: GUEST_STUDY_MAX_TICK_MS, flushEvery: GUEST_STUDY_FLUSH_EVERY_TICKS };
/** 上一次心跳的时刻；计时的起点 */
let lastTick = 0;
/** 最后一次「有操作」的时刻 */
let lastActive = 0;
/** 未 emit 的秒数（日期 → 秒）。只可能有一到两个键（跨零点那一分钟） */
let pending = new Map<string, number>();
let ticksSinceFlush = 0;
/** 播放器是否正在播放（播放中不做空闲判定） */
let mediaPlaying = false;

function defaultBindActivity(mark: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, mark, { passive: true, capture: true });
  return () => {
    for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, mark, { capture: true });
  };
}

/**
 * 「页面真的要走了」的两个钩子，与 `store/studyTime.ts` 的 onVisibility/onPageHide 同款：
 *   - `visibilitychange → hidden`：切后台 / 锁屏 / iPad 切到别的 App。隐藏后定时器会被节流
 *     甚至停摆，不在这里补发就把最后这一分钟攥在内存里直到进程结束；
 *   - `pagehide`：关标签页 / bfcache 往返。React 的 cleanup 在这条路上不一定跑得到。
 */
function defaultBindHidden(flushNow: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const onVis = () => {
    if (document.visibilityState === 'hidden') flushNow();
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', flushNow);
  return () => {
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pagehide', flushNow);
  };
}

/** 此刻该不该计时。**与 store/studyTime.ts 的 shouldCount 逐条同构**，顺序也不能换。 */
function shouldCount(at: number): boolean {
  // 隐藏 / 后台一律不计
  if (!visible()) return false;
  // 正在播放：人一定在（或至少媒体在放），不按空闲判
  if (mediaPlaying) return true;
  return at - lastActive < limits.idleMs;
}

/**
 * 把内存里攒的秒数交出去。**先摘出来再 emit**：emit 期间新攒的增量留在 pending 里，
 * 不会被这一轮顺带带走（主机侧 flush 的同一纪律；那边还要处理事务失败重试，这里 emit
 * 只是入 outbox，失败不了 —— 所以只有 emit 自己抛时才需要合回去）。
 */
function flush(): void {
  if (pending.size === 0) return;
  const entries = [...pending.entries()].map(([date, seconds]) => ({ date, seconds }));
  pending = new Map();
  try {
    emit(entries);
  } catch (err) {
    for (const e of entries) mergeSeconds(pending, [e]);
    console.warn('[live-guest] 学习时长交付失败，已退回内存：', err);
  }
  ticksSinceFlush = 0;
}

function tick(): void {
  const at = now();
  if (shouldCount(at)) {
    // 下界 maxTickMs：设备睡过去的几个小时不能补记（同 MAX_TICK_MS 的理由）
    const from = Math.max(lastTick, at - limits.maxTickMs);
    const slices: StudyDay[] = splitByDay(from, at);
    if (slices.length > 0) mergeSeconds(pending, slices);
    if (++ticksSinceFlush >= limits.flushEvery) flush();
  }
  // 无论计不计时都要推进：不推进的话「空闲一段后再回来」会把整段空闲补记进去
  lastTick = at;
}

function markActive(): void {
  lastActive = now();
}

/**
 * 启动追踪。返回停止函数（页面卸载 / 连接换代时调，必须能真正停掉）。
 *
 * 重复调用是**幂等的**：第二次拿到的是同一个停止函数而不是新起一条定时器 ——
 * 与 `startStudyTracking` 同一纪律（React StrictMode 会立刻停一次再启）。
 */
export function startGuestStudyTracking(onSlices: (slices: StudyDay[]) => void, deps: GuestStudyDeps = {}): () => void {
  if (started) return stopGuestStudyTracking;
  started = true;
  emit = onSlices;
  now = deps.now ?? Date.now;
  timers = deps.timers ?? GLOBAL_TIMERS;
  visible =
    deps.isVisible ?? (() => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'));
  limits = {
    idleMs: deps.idleMs ?? GUEST_STUDY_IDLE_MS,
    tickMs: deps.tickMs ?? GUEST_STUDY_TICK_MS,
    maxTickMs: deps.maxTickMs ?? GUEST_STUDY_MAX_TICK_MS,
    flushEvery: deps.flushEveryTicks ?? GUEST_STUDY_FLUSH_EVERY_TICKS,
  };
  bindActivity = deps.bindActivity ?? defaultBindActivity;
  bindHidden = deps.bindHidden ?? defaultBindHidden;
  pending = new Map();
  ticksSinceFlush = 0;
  mediaPlaying = false;
  lastTick = now();
  lastActive = lastTick;

  unbindActivity = bindActivity(markActive);
  unbindHidden = bindHidden(flush);
  timer = timers.setInterval(tick, limits.tickMs);
  return stopGuestStudyTracking;
}

/** 停掉追踪。**先补发再摘表**：最后一分钟不能跟着定时器一起消失。 */
export function stopGuestStudyTracking(): void {
  if (!started) return;
  flush();
  started = false;
  if (timer !== undefined) timers.clearInterval(timer);
  timer = undefined;
  unbindActivity?.();
  unbindActivity = null;
  unbindHidden?.();
  unbindHidden = null;
  mediaPlaying = false;
}

/**
 * 播放页上报播放态：播放中不做空闲判定（与 `setStudyMediaPlaying` 同款理由 ——
 * 看两小时网课全程不碰屏幕，按「有操作才算」会把最核心的使用场景全记成 0）。
 * 停播 / 播完即恢复普通空闲判定。
 */
export function setGuestStudyMediaPlaying(playing: boolean): void {
  mediaPlaying = playing;
  if (playing) markActive();
}

/**
 * 页面手动打一个「有人在操作」标记。
 *
 * 存在的理由：面板里的**提问**是本模块监听的那五个原生事件覆盖不到的动作
 * （回车发送走的是 `keydown`，倒确实覆盖得到；但点「发送」按钮、点 widget 里的一下、
 * 点题卡的选项都只有 pointerdown —— 它们确实也覆盖得到）。
 * 真正覆盖不到的是**非指针动作**：widget 的 `postMessage` prompt 是 iframe 里的脚本
 * 代发的，外面一个原生事件都没有。所以这里留一个显式入口，让页面在该打的地方打。
 */
export function markGuestStudyActive(): void {
  markActive();
}