import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Disclosure } from '@heroui/react';
import { Sym } from '../ui/icons';
import { MatrixDots, TextSwap, useReasoningStream } from './motion';
import './reasoning-chain.css';

/**
 * 「已思考用时 x 秒」里的那段数字。
 *
 * 秒级给一位小数（0.8 秒不该被四舍五入成 1 秒，那是在替模型吹牛），
 * 过了一分钟才升级单位 —— 深度思考跑几分钟是常事，「3 分 12 秒」比「192 秒」好读。
 */
function fmtThought(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m} 分 ${s} 秒` : `${m} 分`;
}

/**
 * 思考**进行中**的实时用时（「已用时 3.2 秒」）。
 *
 * 为什么拆成独立组件而不是在 ReasoningChain 里 `setState`：计时每秒要跳 4 次，
 * 状态挂在父组件上就等于每 250ms 把整条思考链（动辄上千字）重渲一遍。
 * 拆出来之后，重渲的只有这一行小字。
 *
 * 起点由父组件给（`since` = 本轮启动时刻），这里表示整体「已用时」，不冒充纯思考耗时。
 * 拿不到才退化成挂载时刻 —— 差几十毫秒，总好过不显示。
 */
function LiveElapsed({ from }: { from: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="reasoning-chain__elapsed" data-testid="reasoning-elapsed">
      已用时 {fmtThought(Math.max(0, now - from))}
    </span>
  );
}

/**
 * 思考链（推理模型 reasoning_content 的流式累计值）。四个形态、四个入口：
 *
 * | 形态     | 图标 | 标题                   | 正文                       |
 * | -------- | ---- | ---------------------- | -------------------------- |
 * | 思考中   | 加载 | 正在思考 · 已用时 x 秒 | 固定区域 + 上下渐隐 + 自动滚 |
 * | 思考中·折 | 右  | 正在思考               | 收起                        |
 * | 已完成·展 | 下  | 已思考用时 x 秒（吸顶） | 全文展开，随消息列表滚动     |
 * | 已完成·折 | 右  | 思考过程               | 收起                        |
 *
 * 为什么要拆出「思考中」这个**中间态**：流式期间思考链是唯一在动的东西，
 * 它既不是「已完成可以折叠的结果」，也不是普通的正文段落。此前只有 思考中… / 思考过程 两态，
 * 中间态被硬塞进「已完成」的样式里 —— 于是限制高度的滚动框在**正文一个字都还没出**时就占住了位置，
 * 气泡迟迟不长高，用户盯着一个不动的框也不知道模型是在想还是在卡住。
 *
 * 展开交互统一交给 HeroUI Disclosure；加载状态与展开指示器分别表达生成进度和折叠状态。
 *
 * 实时用时（`LiveElapsed`）只在**思考中且展开**时出现，两个条件缺一不可：
 *
 * - 已完成不挂：那笔账归 `elapsedMs`（「首个 → 末个思考 token」），与实时计时不是同一个量
 *   （多轮 agent 里思维会中断去调工具），两处都挂就等于同一件事有两个真值。
 * - **收起不挂**：收起是「别占我地方」，而一个每 250ms 跳一下的数字恰恰最占注意力 ——
 *   既然用户已经把它折叠了，就别再让那行小字继续动。收起态留一个稳定的「正在思考」就够。
 *
 * 实时计时在思考中且展开时启用；固定视口与自动跟随仅在 `live` 启用。
 * 思考中可切换「全部展开」，退出固定视口，按全文阅读且不再自动跟随。
 *
 * 固定区域 + 渐隐 + 自动滚动是**成对**的：框只有 240px 高，思考链动辄上千字，
 * 不自动滚就永远只能看到最早那几行；不用渐隐收尾则看得出「下面还有」，用户才知道可以滚。
 *
 * 完成后默认自动收起；用户主动选择全文阅读时保留展开，避免打断阅读。
 */
export default function ReasoningChain({
  reasoning,
  active,
  since,
  elapsedMs,
  title: currentTitle,
  idleTitle = '思考过程',
  summary,
  waiting = false,
  failure,
  revision,
  children,
}: {
  reasoning: string;
  /** 整轮是否仍在运行；思考和工具之间切换不改变它，避免反复开合。 */
  active: boolean;
  /** 当前动作只替换标题，不重置原有的展开、滚动与计时。 */
  title?: string;
  idleTitle?: string;
  summary?: ReactNode;
  waiting?: boolean;
  failure?: string;
  /** 工具行的追加或结果更新也要触发跟随，不只监听思考 token。 */
  revision?: unknown;
  children?: ReactNode;
  /**
   * 本轮启动时刻（毫秒时间戳）：包含思考与工具执行的整体实时用时起点。
   *
   * 由调用方给、而不是在这里 `Date.now()`：课程助手的消息活在 store 里，
   * 切走页面再回来组件会重挂 —— 自己计时就会从 0 重新数。
   * 拿不到就退化成挂载时刻（见 `LiveElapsed`）。
   */
  since?: number;
  /**
   * 思考耗时（毫秒）：从**首个**思考 token 到**末个**（多轮 agent 里思维会中断去调工具，
   * 所以不能拿「请求发出 → 请求结束」当思考用时，那会把工具调用的时间也算进去）。
   *
   * 落库后历史消息也有；老数据没这个字段，此时展开回落到「思考过程」。
   */
  elapsedMs?: number;
}) {
  const [open, setOpen] = useState(active);
  const [full, setFull] = useState(false);
  const fullRef = useRef(false);
  const innerRef = useRef<HTMLDivElement>(null);
  const lastTop = useRef(0);
  /** `since` 缺失时的兜底起点（见 prop 注释） */
  const mountedAt = useRef(Date.now());
  /**
   * 用户有没有主动往上滚过。粘底滚动是默认行为，但一旦他自己滚回去读，
   * 每来一个 token 就把他拽回底部是纯打扰 —— 让他自己决定什么时候重新跟上。
   */
  const stickRef = useRef(true);

  // 新一轮回到实时视图；结束时保留用户主动选择的全文阅读状态。
  useEffect(() => {
    if (active) {
      fullRef.current = false;
      setFull(false);
    }
    setOpen(active || fullRef.current);
  }, [active]);

  /** 实时视图固定高度并自动跟随；全文视图交给用户滚动阅读。 */
  const live = active && open && !full;
  const expanded = open && (!active || full);
  const stopStream = useReasoningStream(innerRef, live, stickRef, reasoning, revision);

  const changeOpen = (next: boolean) => {
    // 首次点击实时预览时先展开全文；之后箭头只负责全文展开 / 收起。
    const nextOpen = live || next;
    const nextFull = active && nextOpen;
    stopStream();
    fullRef.current = nextFull;
    setFull(nextFull);
    setOpen(nextOpen);
    if (nextFull && innerRef.current) innerRef.current.scrollTop = 0;
  };

  // 用户自己滚 → 更新「还粘不粘底」。scroll 不冒泡，只能挂在滚动容器自己身上。
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollHeight - el.clientHeight - el.scrollTop < 24) stickRef.current = true;
      else if (el.scrollTop < lastTop.current - 1) {
        // 用户自己往上滚：先停掉正在跑的补间，别把他拽回底部
        stickRef.current = false;
        stopStream();
      }
      lastTop.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      if (live && stickRef.current) {
        // Disclosure can resize during an in-flight scroll tween. Cancel its
        // stale starting position before snapping, or its next frame scrolls
        // upward and is mistaken for the user opting out of follow mode.
        stopStream();
        el.scrollTop = el.scrollHeight;
      }
      lastTop.current = el.scrollTop;
    });
    observer.observe(el);
    return () => { el.removeEventListener('scroll', onScroll); observer.disconnect(); };
  }, [live, open, stopStream]);

  // 「已完成但没记耗时」（老数据）就别硬凑一个 0.0 秒，回落到朴素标题
  const title = active
    ? currentTitle ?? '正在思考'
    : waiting ? currentTitle ?? '等待你的确认'
    : expanded && elapsedMs != null
      ? `已思考用时 ${fmtThought(elapsedMs)}`
      : idleTitle;

  return (
    <Disclosure className="reasoning-chain" data-mode={expanded ? 'expanded' : live ? 'live' : 'closed'}
      data-testid="response-process" data-streaming={active || undefined}
      isExpanded={open} onExpandedChange={changeOpen}>
      {active && <span className="sr-only" role="status">{title}</span>}
      <Disclosure.Heading className="reasoning-chain__heading">
      <Disclosure.Trigger className="reasoning-chain__toggle" data-testid="response-process-toggle"
        aria-label={live ? '展开全部思考过程' : open ? '收起思考过程' : '展开思考过程'}>
        {waiting ? <Sym name="help" className="reasoning-chain__icon" aria-hidden="true" />
          : active && <MatrixDots className="reasoning-chain__icon" />}
        <TextSwap className="reasoning-chain__title" text={title} />
        {summary}
        {/* 思考中展开时保留计时，包括用户选择的全文视图。 */}
        {active && open && !waiting && <LiveElapsed from={since ?? mountedAt.current} />}
        {live
          ? <Sym name="unfold_more" className="reasoning-chain__indicator" aria-hidden="true" />
          : <Disclosure.Indicator className="reasoning-chain__indicator" />}
      </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content className="reasoning-chain__content">
        <Disclosure.Body className="reasoning-chain__panel">
        <div className="reasoning-chain__viewport">
          <div ref={innerRef}
            className={live ? 'reasoning-chain__body reasoning-chain__body--live t-reason' : 'reasoning-chain__body'}
            tabIndex={open ? 0 : -1} role="region" aria-label="思考过程">
            <div className="reasoning-chain__entries">{children ?? reasoning}</div>
          </div>
        </div>
        </Disclosure.Body>
      </Disclosure.Content>
      {failure && !open && (
        <p className="reasoning-chain__failure" role="status">
          <Sym name="error" aria-hidden="true" />
          <span>{failure}</span>
        </p>
      )}
    </Disclosure>
  );
}
