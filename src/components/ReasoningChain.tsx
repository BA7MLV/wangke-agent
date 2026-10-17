import { useEffect, useRef, useState } from 'react';
import { Disclosure } from '@heroui/react';
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
 * 起点由父组件给（`since` = 首个思考 token 的时刻，与「已思考用时」同一个源头），
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
 * 实时计时、固定视口与自动跟随仅在 `live` 启用；历史回看完整展开。
 *
 * 固定区域 + 渐隐 + 自动滚动是**成对**的：框只有 240px 高，思考链动辄上千字，
 * 不自动滚就永远只能看到最早那几行；不用渐隐收尾则看得出「下面还有」，用户才知道可以滚。
 *
 * 完成后自动收起（`useEffect` 那三行）：思考链是过程不是答案，
 * 不收起来会把真正要读的回答挤到屏幕外。
 */
export default function ReasoningChain({
  reasoning,
  active,
  since,
  elapsedMs,
}: {
  reasoning: string;
  /** 流式中且正文未出 = 还在思考（见 ChatPanel 传参处） */
  active: boolean;
  /**
   * 首个思考 token 的时刻（毫秒时间戳）：思考中实时计时的起点。
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
  const innerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const lastTop = useRef(0);
  /** `since` 缺失时的兜底起点（见 prop 注释） */
  const mountedAt = useRef(Date.now());
  /**
   * 用户有没有主动往上滚过。粘底滚动是默认行为，但一旦他自己滚回去读，
   * 每来一个 token 就把他拽回底部是纯打扰 —— 让他自己决定什么时候重新跟上。
   */
  const stickRef = useRef(true);

  // 思考结束就收起；思考开始（首帧）展开。两种情况都只在跃迁那一下跑一次。
  useEffect(() => {
    setOpen(active);
  }, [active]);

  /** 思考中且展开着：自动跟随与实时计时。 */
  const live = active && open;
  const expanded = !active && open;
  const stopStream = useReasoningStream(innerRef, live, stickRef, reasoning);

  /**
   * 渐隐的两端是**各自**开关的，不是「内容溢出就上下一起淡」：
   * 贴底时下面没有内容，底部那截渐隐只是在把最后一行抹灰，读者会以为字没显示全。
   * 直接写 dataset 而不走 state —— 这只是 paint 提示，不该每个 token 多触发一次渲染。
   */
  const syncFade = (el: HTMLDivElement) => {
    el.dataset.fadeTop = String(el.scrollTop > 4);
    el.dataset.fadeBottom = String(el.scrollHeight - el.clientHeight - el.scrollTop > 4);
    if (viewportRef.current) {
      viewportRef.current.dataset.fadeTop = el.dataset.fadeTop;
      viewportRef.current.dataset.fadeBottom = el.dataset.fadeBottom;
    }
  };

  // 自动跟随由 useReasoningStream 负责向上送；这里只同步上下渐隐。
  useEffect(() => {
    const el = innerRef.current;
    if (!el || !open) return;
    const frame = requestAnimationFrame(() => {
      lastTop.current = el.scrollTop;
      syncFade(el);
    });
    return () => cancelAnimationFrame(frame);
  }, [reasoning, live, open]);

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
      syncFade(el);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      if (live && stickRef.current) el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
      syncFade(el);
    });
    observer.observe(el);
    return () => { el.removeEventListener('scroll', onScroll); observer.disconnect(); };
  }, [live, open, stopStream]);

  // 「已完成但没记耗时」（老数据）就别硬凑一个 0.0 秒，回落到朴素标题
  const title = active
    ? '正在思考'
    : expanded && elapsedMs != null
      ? `已思考用时 ${fmtThought(elapsedMs)}`
      : '思考过程';

  return (
    <Disclosure className="reasoning-chain" data-mode={expanded ? 'expanded' : live ? 'live' : 'closed'}
      isExpanded={open} onExpandedChange={setOpen}>
      <Disclosure.Heading className="reasoning-chain__heading">
      <Disclosure.Trigger className="reasoning-chain__toggle">
        {active && <MatrixDots className="reasoning-chain__icon" />}
        <TextSwap className="reasoning-chain__title" text={title} />
        {/* 只在 live 挂：思考中一旦被收起，那行跳动的数字就该消失（见文件头注释） */}
        {live && <LiveElapsed from={since ?? mountedAt.current} />}
        <Disclosure.Indicator className="reasoning-chain__indicator" />
      </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content className="reasoning-chain__content">
        <Disclosure.Body className="reasoning-chain__panel">
        <div className="reasoning-chain__viewport" ref={viewportRef}>
          <div ref={innerRef}
            className={live ? 'reasoning-chain__body reasoning-chain__body--live t-reason' : 'reasoning-chain__body'}
            tabIndex={open ? 0 : -1} role="region" aria-label="思考过程">
            {reasoning}
          </div>
        </div>
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
