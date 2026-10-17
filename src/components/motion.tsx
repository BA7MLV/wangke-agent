import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';

/**
 * 新消息入场动画的 key 跟踪（配 .t-msg-enter，见 transitions.css）。
 *
 * 只有**尾部追加**的消息才播一次上浮淡入：发出去的那条提问 + 紧跟上屏的助手占位
 * 是同批追加的，一起入场。这些情况都不播：
 *   - 首帧（整表当基线）；
 *   - 换会话（上一轮已有内容又换了 `resetKey`）；
 *   - 向上加载更早的消息（头部插入）；
 *   - 一次冒出太多条（> 3）：那是载入一整段历史，不是刚发出的一两条。
 * 草稿态首问是例外：CourseChat 的会话懒创建，`activeId` 会从 null 变成真实 id，
 * 它其实是「新建会话 + 追加两条」，要播。
 *
 * 播完 ~700ms 后把 key 移出集合、class 随之摘掉。这一步不能省：VirtualMessages
 * 会把滚出视口的消息卸载、滚回来再挂载，class 留在元素上就会让历史消息重播入场。
 *
 * 返回值是「当前正在入场的 key 集合」，调用方按它决定挂不挂 class。
 */
export function useMessageEnter(keys: string[], resetKey?: unknown): ReadonlySet<string> {
  // sig 是 keys 的内容签名：effect 依赖它而不是每次渲染都变的新数组
  const sig = keys.join('\u0001');
  const prev = useRef<{ reset?: unknown; keys: string[] } | null>(null);
  const [entering, setEntering] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const last = prev.current;
    prev.current = { reset: resetKey, keys };
    if (last === null) return;
    // 换会话：上一轮已经有内容又换了 resetKey，是整表替换，不是「新消息」。
    // 例外是草稿态首问：CourseChat 的会话是懒创建的，发第一句时 activeId 会从
    // null 变成真实 id —— 那是「新建会话」，恰恰要播入场。
    if (last.reset !== resetKey && last.reset != null) return;
    if (keys.length <= last.keys.length) return;
    if (!last.keys.every((k, i) => k === keys[i])) return;
    const fresh = keys.slice(last.keys.length);
    if (fresh.length > 3) return;
    setEntering(new Set(fresh));
    const t = window.setTimeout(() => {
      setEntering((s) => {
        const next = new Set(s);
        for (const k of fresh) next.delete(k);
        return next;
      });
    }, 700);
    return () => window.clearTimeout(t);
    // sig 已经代表了 keys 的内容，keys 不必进依赖（数组字面量每次都是新引用）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, resetKey]);

  return entering;
}

/** transitions.dev 31 的 twinkle 相位表：第 idx 个点的延迟序号（0..15）。 */
const MATRIX_TWINKLE = [7, 2, 11, 5, 14, 9, 0, 12, 3, 15, 6, 10, 13, 1, 8, 4];

/**
 * 31 Matrix dot loader — 4×4 的 2px 点阵脉冲。「待回复」用它做「正在准备」的微动效：
 * 比转圈安静，能和旁边那行 shimmer 文案并排。
 *
 * 每个点的相位序号写在 `--r` 上，延迟由 CSS 摊到一个脉冲周期里
 * （`animation-delay: calc(var(--r) * var(--matrix-cycle) / 16)`）—— 周期是语义 token，
 * 改 --matrix-cycle 时这里一个字都不用动。
 */
export function MatrixDots({ className }: { className?: string }) {
  return (
    <span className={className ? `t-matrix ${className}` : 't-matrix'} data-variant="twinkle" aria-hidden="true">
      {Array.from({ length: 16 }, (_, i) => (
        <i key={i} style={{ ['--r' as string]: MATRIX_TWINKLE.indexOf(i) }} />
      ))}
    </span>
  );
}

/**
 * 「待回复」占位：一轮提问发出后、首个 token 到达之前，助手气泡里的等待态。
 *
 * 点阵来自 transitions.dev 的 31 Matrix dot loader，文案扫光来自 15 Shimmer text ——
 * 和 ThinkLine（28 思考态）、StreamParagraph（30 流式）共用同一套 token 节奏。
 */
export function PendingReply({ label = '正在等待回复…' }: { label?: string }) {
  return (
    <span className="t-pending" role="status">
      <MatrixDots />
      <Shimmer text={label} />
    </span>
  );
}

/** 读取 :root 上的 motion token（毫秒），保持 JS 计时与 CSS 变量同步。
 *  构建压缩会把 150ms 改写成 .15s，这里兼容 s / ms 两种单位。 */
export const ms = (name: string, fb: number): number => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return fb;
  return raw.endsWith('ms') ? v : raw.endsWith('s') ? v * 1000 : v;
};

/**
 * 04 Text states swap — 状态文案原地交换（旧文上飘模糊退出，新文从下方进入）。
 * 文本完全由 JS 管理（React 只渲染首帧），prop 变化时走三段式：
 * is-exit → 换文本 + is-enter-start → reflow → 去掉 is-enter-start。
 */
export function TextSwap({
  text,
  className,
  style,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shownRef = useRef(text);
  // React 永不更新这个文本节点，避免 reconciliation 绕过动画直接改写 textContent
  const [initial] = useState(text);

  useEffect(() => {
    const el = ref.current;
    if (!el || text === shownRef.current) return;
    const dur = ms('--text-swap-dur', 150);
    el.classList.add('is-exit');
    const t = window.setTimeout(() => {
      el.textContent = text;
      shownRef.current = text;
      el.classList.remove('is-exit');
      el.classList.add('is-enter-start');
      void el.offsetHeight; // force reflow so the next change transitions
      el.classList.remove('is-enter-start');
    }, dur);
    return () => {
      clearTimeout(t);
      el.classList.remove('is-exit');
    };
  }, [text]);

  return (
    <span ref={ref} className={className ? `t-text-swap ${className}` : 't-text-swap'} style={style}>
      {initial}
    </span>
  );
}

/**
 * 28 Thinking states — agent 状态行：持有期间 shimmer，切换时旧行上飘退出、
 * 新行从下方进入。子节点全部 JS 管理（隐藏 sizer 撑住宽度，文案行绝对定位）。
 */
export function ThinkLine({
  text,
  className,
  style,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
}) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const liveRef = useRef<HTMLSpanElement | null>(null);
  const shownRef = useRef(text);
  const timersRef = useRef<number[]>([]);

  // 挂载：建 sizer + 第一行文案；卸载：清空
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const sizer = document.createElement('span');
    sizer.className = 't-think-sizer';
    sizer.setAttribute('aria-hidden', 'true');
    sizer.textContent = shownRef.current;
    const line = document.createElement('span');
    line.className = 't-think-text';
    line.textContent = shownRef.current;
    line.setAttribute('data-text', shownRef.current);
    box.append(sizer, line);
    liveRef.current = line;
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      box.innerHTML = '';
      liveRef.current = null;
    };
  }, []);

  // text 变化：旧行 is-exit，新行 is-enter-start → reflow → 释放
  useEffect(() => {
    const box = boxRef.current;
    const live = liveRef.current;
    if (!box || !live || text === shownRef.current) return;
    shownRef.current = text;
    const swap = ms('--think-swap', 150);
    const gap = ms('--think-gap', 50);
    const timers = timersRef.current;

    live.classList.add('is-exit');

    const next = document.createElement('span');
    next.className = 't-think-text is-enter-start';
    next.textContent = text;
    next.setAttribute('data-text', text);
    box.appendChild(next);
    liveRef.current = next;

    // sizer 始终持有最长状态，保证盒子宽度不在 swap 中途变化
    const sizer = box.querySelector('.t-think-sizer');
    if (sizer && text.length > (sizer.textContent?.length ?? 0)) sizer.textContent = text;

    const release = () => {
      void next.offsetWidth; // flush the enter-start rest state
      next.classList.remove('is-enter-start');
    };
    if (gap > 0) timers.push(window.setTimeout(release, gap));
    else release();

    timers.push(
      window.setTimeout(() => {
        live.remove();
      }, swap + gap),
    );
  }, [text]);

  return (
    <span
      ref={boxRef}
      className={className ? `t-think ${className}` : 't-think'}
      style={{ textAlign: 'left', ...style }}
      role="status"
    />
  );
}

/**
 * 30 Streaming text — 流式段落：把字符串子节点按词包成 .t-stream-w，
 * 每个词挂载后经 reflow 补 .is-in，经 opacity + 小模糊逐一「解析」到位。
 * 非字符串子节点（链接、代码等）原样透传。追加式流式渲染下 key 按序稳定。
 */
function StreamWord({ w }: { w: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    void el.offsetWidth; // flush the hidden rest state
    el.classList.add('is-in');
  }, []);
  return (
    <span ref={ref} className="t-stream-w">
      {w}
    </span>
  );
}

function StreamChildren({ children }: { children?: ReactNode }) {
  const out: ReactNode[] = [];
  let i = 0;
  for (const child of Array.isArray(children) ? children : [children]) {
    if (typeof child === 'string') {
      for (const piece of child.split(/(\s+)/)) {
        if (!piece) continue;
        out.push(/^\s+$/.test(piece) ? piece : <StreamWord key={i} w={piece} />);
        i++;
      }
    } else if (child != null && child !== false) {
      out.push(child);
      i++;
    }
  }
  return <>{out}</>;
}

export function StreamParagraph({ children }: { children?: ReactNode }) {
  return (
    <p className="t-stream">
      <StreamChildren>{children}</StreamChildren>
    </p>
  );
}

/**
 * 10 Success check — 完成时刻：fade + rotate + Y-bob + 描边绘制。
 * stroke-dasharray 在挂载时用 getTotalLength() 动态校准（文档推荐方式二）。
 * 挂载即出现：effect 里把 data-state 从 out 翻到 in 触发 keyframes。
 */
export function SuccessCheck({
  size = 14,
  color = '#52c41a',
  style,
}: {
  size?: number;
  color?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    const path = el?.querySelector<SVGPathElement>('svg path');
    if (!el || !path) return;
    const len = Math.ceil(path.getTotalLength()) + 1;
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);
    el.setAttribute('data-state', 'in');
  }, []);

  return (
    <span
      ref={ref}
      className="t-success-check"
      data-state="out"
      aria-hidden="true"
      style={{ ['--check-y-amount' as string]: '8px', verticalAlign: '-2px', ...style }}
    >
      <svg viewBox="0 0 16 16" fill="none" width={size} height={size}>
        <path
          d="M3 8.5l3.2 3.2L13 4.5"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/**
 * 09 Icon swap — 同一格子里交叉淡入淡出两个图标（chevron ⇄ 箭头、发送 ⇄ 停止）。
 * 两个分支必须同时在 DOM 里，React 只负责按 `when` 决定哪个格子在前，
 * 真正的进出场由 .t-icon-swap 的 data-state 插值。
 *
 * `a` / `b` 是两个分支；`active` 决定当前显示哪一个。分支内容变化时
 * React 会重排，但 data-state 不变，所以动画只在 active 翻转时播放一次。
 */
export function IconSwap({
  a,
  b,
  active = 'a',
  className,
  style,
}: {
  a: ReactNode;
  b: ReactNode;
  /** 'a' 显示 a，'b' 显示 b */
  active?: 'a' | 'b';
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={className ? `t-icon-swap ${className}` : 't-icon-swap'}
      data-state={active}
      style={style}
      aria-hidden="true"
    >
      <span className="t-icon" data-icon="a">
        {a}
      </span>
      <span className="t-icon" data-icon="b">
        {b}
      </span>
    </span>
  );
}

/**
 * 02 Number pop-in — 数字变化时逐位重新入场（带模糊与位移）。
 * 数字串由 JS 拆成 .t-digit，末两位打 data-stagger 让它们依次滞后；
 * 重放走「去 class → 换内容 → reflow → 加 class」四步。
 *
 * `text` 变化才重放；同一串内容重复渲染不会闪。
 */
export function NumberPop({
  text,
  className,
  style,
}: {
  text: string | number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shownRef = useRef(String(text));

  /** 铺一遍数字。animate=false 时只建 DOM 不挂 is-animating。 */
  const paint = (el: HTMLElement, str: string, animate: boolean) => {
    if (animate) el.classList.remove('is-animating');
    el.replaceChildren();
    const chars = [...str];
    chars.forEach((ch, i) => {
      const span = document.createElement('span');
      span.className = 't-digit';
      span.textContent = ch;
      if (i === chars.length - 2) span.dataset.stagger = '1';
      else if (i === chars.length - 1) span.dataset.stagger = '2';
      el.appendChild(span);
    });
    if (!animate) return;
    void el.offsetHeight; // force reflow so the animation replays
    el.classList.add('is-animating');
  };

  // 挂载：铺首帧数字，不播入场（挂载本身不是「一次更新」）
  useEffect(() => {
    const el = ref.current;
    if (el) paint(el, shownRef.current, false);
  }, []);

  // text 变化：拆位重画 → reflow → 挂 is-animating 重放入场
  useEffect(() => {
    const el = ref.current;
    const str = String(text);
    if (!el || str === shownRef.current) return;
    shownRef.current = str;
    paint(el, str, true);
  }, [text]);

  // 数字节点**完全交给 JS**：React 只输出一个空壳 span。
  // 如果这里既渲染 children 又在 effect 里 replaceChildren，两边会同时改这棵子树 ——
  // React 的 vdom 还留着旧 children，下一次重渲染就会去 patch 已经被抹掉的节点，
  // 结果是数字错乱甚至整棵组件抛错。TextSwap 早就是按这个约定写的，这里照抄。
  return <span ref={ref} className={className ? `t-digit-group ${className}` : 't-digit-group'} style={style} />;
}

/**
 * 15 Shimmer text — 「读取中…」这类占位文案的高亮扫过，纯 CSS。
 * 文案同时写进 data-text（::before 靠 attr() 复制同一串字形），
 * 所以 children 变化时两者必须一起更新。
 */
export function Shimmer({
  text,
  className,
  style,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className={className ? `t-shimmer ${className}` : 't-shimmer'} data-text={text} style={style}>
      {text}
    </span>
  );
}

/**
 * 03 Notification badge — 挂在触发器上的小角标，斜向滑入 + 弹入。
 * `count` 为 0 时收起；非 0 时弹入。触发器本身不参与动画。
 */
export function CountBadge({
  count,
  max = 99,
  className,
  style,
}: {
  count: number;
  max?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className={className ? `t-badge ${className}` : 't-badge'} data-open={count > 0} aria-hidden="true" style={style}>
      <span className="t-badge-dot">{count > max ? `${max}+` : count}</span>
    </span>
  );
}

/**
 * 21 Accordion expand — 可折叠正文。
 *
 * `t-acc-panel` 是 0fr → 1fr 的 grid 轨道，`t-acc-panel-inner` 负责裁切；
 * data-open 挂在轨道自己的 t-acc 上，所以 JS 只翻一个属性，不量高。
 *
 * 为什么正文**不能**条件渲染：轨道要能从 0fr 插值到 1fr，两层结构必须
 * 一直在 DOM 里；`{open && …}` 会让展开变成「凭空出现」，收起的动画
 * 也就无从谈起。
 *
 * `innerClassName` 挂在内层（正文自己的 max-height / overflow 滚动上限
 * 写在这里）—— padding 与滚动上限都**不能**落在 0fr 轨道上，否则收不干净。
 *
 * `innerRef` 给那些要**操纵滚动位置**的正文用（思考链要随流式续写滚到底部，
 * 见 ReasoningChain）。为什么不能靠事件委托：滚动容器就是内层这个元素本身，
 * 组件外拿不到它。事件在 t-acc 轨道上收是收不到 scroll 的 —— 滚动不冒泡。
 */
export function Collapse({
  open,
  id,
  innerClassName,
  innerRef,
  children,
}: {
  open: boolean;
  /** 给 aria-controls 用的 id */
  id?: string;
  /** 正文自己的类名（max-height / overflow 等） */
  innerClassName?: string;
  /** 正文滚动容器的 ref（要滚到底部 / 监听 scroll 时用） */
  innerRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div id={id} className="t-acc t-acc-panel" data-open={open ? 'true' : 'false'}>
      <div
        ref={innerRef}
        className={innerClassName ? `t-acc-panel-inner ${innerClassName}` : 't-acc-panel-inner'}
      >
        {children}
      </div>
    </div>
  );
}
