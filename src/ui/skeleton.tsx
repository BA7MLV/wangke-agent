import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import './skeleton.css';

/**
 * 骨架屏闸门（skeleton gate）—— 延迟门控 + 最短停留 + 交叉淡入。
 *
 * ## 为什么不「一开始加载就出骨架」
 *
 * 本项目的数据几乎全在本机：视频在 OPFS，课程 / 字幕 / 讲义 / 学习记录都在 IndexedDB。
 * 实测（`scripts/probe-loading-latency.mjs` → `scripts/.cache/loading-latency.json`）：
 *
 * | 量测 | 结果 |
 * |---|---|
 * | IndexedDB 直读 videos 全表（冷连接） | p50 **0.3ms** |
 * | IndexedDB 直读 videos 全表（复用连接） | p50 **0.1ms**（Dexie 在 app 里是常驻连接） |
 * | 资料库有数据冷启动，「空态」可见窗口 | 64 / 65 / 94ms |
 * | 同一场景最长长任务 | 128–403ms |
 *
 * 结论很直接：**这里根本没有可等的 IO**。时间花在主线程（整包 JS 解析执行 + 首帧渲染）
 * 而不是存储上（长任务与 IDB 耗时差三个数量级）。对毫秒级的等待无条件插一屏骨架，
 * 只是把「闪一下空态」换成「闪一下骨架」—— 负收益。
 *
 * ## 阈值从哪来
 *
 * 业界的响应时间阶梯（Nielsen 的 0.1s / 1s 两条线，Material 的「延迟指示器」同口径）：
 *
 * - `0 – 100ms`：用户感觉是**瞬时**的，此时显示任何加载态都是噪声；
 * - `100ms – 1s`：感觉到延迟但注意力没断，适合上**骨架**（先把最终布局占住）；
 * - `> 1s`：需要「还在动」的持续信号。
 *
 * 落到实现上就是两条计时规则，**缺一不可**：
 *
 * 1. **延迟门控**：`busy` 在 `delayMs` 内结束 → 一个骨架都不出；
 * 2. **最短停留**：骨架一旦露脸就至少待 `minVisibleMs` —— 否则「骨架闪一下被内容顶掉」
 *    比不显示更让人烦躁（这也是骨架屏最常见的翻车方式）。
 *
 * 阈值取 `200ms` 而不是 `100ms`：这是本地 1ms 量级之上留出的余量，慢设备
 * （iPad 首次冷启动、主线程被 400ms 长任务占住）才会真正触发；快速路径上多这 100ms
 * 用户感知不到，但能挡掉大量「其实不慢」的闪烁。
 */
export const SKELETON_DELAY_MS = 200;
/** 骨架露出后的最短停留时长（与 `--reveal-dur` 同量级，避免闪回） */
export const SKELETON_MIN_VISIBLE_MS = 400;
/** 骨架淡出 / 内容淡入的重叠时长：两层必须重叠，否则中间会空一拍 */
const REVEAL_MS = 400;

export interface SkeletonGateOptions {
  /** 传 0 表示「这个加载已知一定慢，不必再等门」（如跨网络的模型列表） */
  delayMs?: number;
  minVisibleMs?: number;
}

/**
 * 延迟门控：返回「现在该不该显示骨架」。
 *
 * 计时簿记刻意放在 ref 里而不是 state：`show` 变化引起的重渲染**不能**让 effect 重跑，
 * 否则计时器会被反复重置成「再等一轮」，骨架永远不出现。
 */
export function useSkeletonGate(busy: boolean, options: SkeletonGateOptions = {}): boolean {
  const { delayMs = SKELETON_DELAY_MS, minVisibleMs = SKELETON_MIN_VISIBLE_MS } = options;
  const [show, setShow] = useState(false);
  /** 骨架露脸的时刻；`null` = 这一轮还没露过脸（快速路径就靠它保持静默） */
  const shownAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (busy) {
      // 已经在显示：别重设计时器（否则每次都「再等 delayMs」）
      if (shownAtRef.current !== null) return;
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        shownAtRef.current = Date.now();
        setShow(true);
      }, delayMs);
      return clearTimer;
    }

    // 不忙了：先取消还没烧完的延迟 —— 这条就是「快速路径一个骨架都不出」的规则
    clearTimer();
    if (shownAtRef.current === null) return;

    // 已经露过脸：补足最短停留再收
    const remain = minVisibleMs - (Date.now() - shownAtRef.current);
    if (remain <= 0) {
      shownAtRef.current = null;
      setShow(false);
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      shownAtRef.current = null;
      setShow(false);
    }, remain);
    return clearTimer;
  }, [busy, delayMs, minVisibleMs, clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return show;
}

export interface SkeletonRevealProps {
  /** 骨架是否可见（来自 `useSkeletonGate`） */
  show: boolean;
  /** 与最终内容**同形**的骨架：几何请复用真内容的类名，避免出结果时跳一下 */
  skeleton: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}

/**
 * 交叉淡入的三段：`idle` → `loading` → `revealing` → `idle`。
 * 台上「至少有一层」这条不变量靠它来守（见下面的说明）。
 */
type Phase = 'idle' | 'loading' | 'revealing';

/**
 * 骨架 → 内容的交叉淡入容器。
 *
 * 两层用 CSS Grid 叠在同一格里（`grid-area: 1/1`）而**不是** `position: absolute`
 * —— 绝对定位的两层都不参与布局，容器高度会塌成 0（`transitions.css` 的 `.t-skel`
 * 是配着固定高度的容器用的，列表这种高度不定的场景套不上）。
 *
 * ## 为什么用三段状态机、而且必须在渲染阶段同步
 *
 * ⚠️ 踩过的坑一：最早写的是「`show` 为真就挂骨架、为假就卸」，靠一个 effect 记「晚一拍卸载」。
 * 那样每条边界上都有一帧**两层都不在**：`show` 翻真的那一刻 effect 还没跑（骨架没挂上、
 * 内容又是空的），「晚一拍卸载」的那一拍也是同一回事。400ms 的交叉淡入里插一帧空白，
 * 恰好把「不闪」这件事从头破坏掉。
 *
 * ⚠️ 踩过的坑二：改成三段状态机之后，把「进 / 出」的方向判断放进了 `useEffect` ——
 * 结果**同样的那一帧又回来了**，只是换了个位置：`show` 翻真的那次渲染里 `phase` 还是
 * 上一轮的 `idle`。所以方向判断必须留在渲染阶段（见下面的代码注释），effect 只负责
 * 「淡出走完 → 收干净」这段纯计时。
 *
 * 三段是 `idle`（从没加载过，或已经收干净）/ `loading`（骨架在台上）/
 * `revealing`（两层交叉淡入，结束才回 `idle`）。台上**始终至少有一层**。
 */
export function SkeletonReveal({ show, skeleton, children, className, testId }: SkeletonRevealProps) {
  const [phase, setPhase] = useState<Phase>(show ? 'loading' : 'idle');

  // ⚠️ 这一段必须是**渲染阶段**同步，不能搬进 useEffect。
  //
  // 放进 effect 会平白多出一帧：`show` 翻真的那次渲染里 `phase` 还是旧的 `idle`，
  // 于是骨架没挂上、`children` 又是 `null`（加载中本来就什么都不写）——
  // 一帧**两层皆空**，正好把「不闪」这件事从根上破坏掉。
  //
  // React 允许在渲染中调用本组件自己的 setState：这次输出会被丢弃并立刻重渲染，
  // 半成品不会被提交，所以那一帧根本不存在。条件保证它只会收敛一次，不会死循环。
  if (show && phase !== 'loading') setPhase('loading');
  else if (!show && phase === 'loading') setPhase('revealing');

  // 淡出走完 → 收干净（此时骨架已经是 opacity 0，卸载不会再改变画面）
  useEffect(() => {
    if (phase !== 'revealing') return;
    const t = setTimeout(() => setPhase('idle'), REVEAL_MS);
    return () => clearTimeout(t);
  }, [phase]);

  const classes = ['skel-reveal', `is-${phase}`];
  if (className) classes.push(className);

  return (
    <div className={classes.join(' ')} data-testid={testId} aria-busy={phase === 'loading' || undefined}>
      {phase !== 'idle' && <div className="skel-reveal__skeleton">{skeleton}</div>}
      <div className="skel-reveal__content">{children}</div>
    </div>
  );
}
