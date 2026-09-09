import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

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
