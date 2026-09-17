import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsMobile } from '../utils/useMobile';
import { cleanSelectionText, isUsableSelection } from '../materials/region';
import { useSelectionAsk, type AskSource, type Citation } from '../store/selectionAsk';
import './selection-ask.css';

/**
 * 全局选区浮层：在任意「可问答区域」里拖选文字后弹出动作条。
 *
 * ## 为什么用 DOM 属性而不是 props 驱动
 *
 * 选区可以发生在四个地方（PDF 文本层 / Word 正文 / 字幕行 / 讲义段落），
 * 它们由不同的组件渲染、层级相隔很远。如果让每个来源都往上报「我这儿被选了」，
 * 要穿透 4 条组件链。
 *
 * 改成**容器自报家门**：谁想支持划词，就在自己的 DOM 上标
 * `data-askable="pdf|docx|handout|subtitle"`（可选 `data-ask-unit` / `data-ask-label` / `data-ask-time`），
 * 浮层用 `selection.getRangeAt(0)` 反查最近的 `[data-askable]` 祖先。
 * 新增来源只要加一个属性，浮层一行不用改。
 *
 * ## 三个必须处理的时序坑
 *
 * 1. **点浮层时选区会被浏览器折叠**（mousedown 落点在选区外）→ 触发 `selectionchange` 变空
 *    → 浮层在 click 之前就自己消失了。对策：`mousedown.preventDefault()`（保住选区）+
 *    「刚点过浮层」的抑制窗口兜底触摸端。
 * 2. **移动端原生选择菜单会挡住浮层** → 移动端不用跟随选区，改成贴底固定条。
 * 3. **滚动后锚点失效** → 滚动直接收起（选区本身还在，重选成本很低）。
 */

interface Hit {
  cite: Citation;
  anchor: { x: number; y: number; below: boolean };
}

/** 浮层容器本身不吃指针事件，只有按钮吃 —— 否则它会盖住正文，让「继续滚动/继续拖选」失效 */
function readSelection(): Hit | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const start = range.startContainer;
  const el = start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement;
  const host = el?.closest?.('[data-askable]') as HTMLElement | null;
  if (!host) return null;

  const text = cleanSelectionText(sel.toString());
  if (!isUsableSelection(text)) return null;

  const ds = host.dataset;
  const r = range.getBoundingClientRect();
  const above = r.top > 92;
  return {
    cite: {
      text,
      source: (ds.askable ?? 'pdf') as AskSource,
      unit: ds.askUnit ? Number(ds.askUnit) : undefined,
      unitLabel: ds.askLabel || undefined,
      time: ds.askTime ? Number(ds.askTime) : undefined,
    },
    anchor: {
      x: Math.min(Math.max(r.left + r.width / 2, 104), window.innerWidth - 104),
      y: above ? r.top - 8 : r.bottom + 8,
      below: !above,
    },
  };
}

export default function SelectionAsk() {
  const isMobile = useIsMobile();
  const [hit, setHit] = useState<Hit | null>(null);
  /** 框选投过来的浮层请求（PDF 框选没有 DOM 选区，走 store） */
  const region = useSelectionAsk((s) => s.bar);
  const ask = useSelectionAsk((s) => s.ask);
  const hideBar = useSelectionAsk((s) => s.hideBar);
  const barRef = useRef<HTMLDivElement>(null);
  /** 刚在浮层上按下的时间：用于压掉触摸端「点浮层 → 选区被折叠」引发的误收起 */
  const insideAt = useRef(0);

  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = readSelection();
        // 选区变空时不要立刻收：可能是刚才点了浮层导致折叠（见文件头注释 1）
        if (!next && Date.now() - insideAt.current < 800) return;
        setHit(next);
      }, 140);
    };
    const onPointerDown = (e: PointerEvent) => {
      const inside = !!barRef.current && e.target instanceof Node && barRef.current.contains(e.target);
      if (inside) {
        insideAt.current = Date.now();
        return;
      }
      insideAt.current = 0;
      setHit(null);
      hideBar();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setHit(null);
      hideBar();
    };
    // 滚动后锚点就没意义了（锚点是视口坐标，不跟着走），直接收起
    const onScroll = () => {
      setHit(null);
      hideBar();
    };

    document.addEventListener('selectionchange', onChange);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [hideBar]);

  const fire = useCallback(
    (mode: 'explain' | 'compose') => {
      const cite = region?.cite ?? hit?.cite;
      if (!cite) return;
      ask(cite, mode);
      setHit(null);
      // 收起选区：失败无所谓（部分浏览器禁止程序化清除）
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        /* ignore */
      }
    },
    [region, hit, ask],
  );

  const active = region ?? hit;
  if (!active) return null;

  const pos = region ? { ...region.anchor, below: true } : hit!.anchor;
  const style = isMobile
    ? undefined
    : { left: pos.x, top: pos.y, transform: `translate(-50%, ${pos.below ? '0' : '-100%'})` };

  return (
    <div
      ref={barRef}
      className={isMobile ? 'ask-float ask-float--fixed' : 'ask-float'}
      style={style}
      data-testid="ask-float"
      role="toolbar"
      aria-label="对选中内容提问"
      // 保住选区：不这么做，按下的瞬间选区就被折叠，浮层在自己 click 之前先消失
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="ask-float__preview" title={active.cite.text}>
        {active.cite.unitLabel ? <span className="ask-float__where">{active.cite.unitLabel}</span> : null}
        <span className="ask-float__text">{active.cite.text}</span>
      </div>
      <div className="ask-float__actions">
        <mdui-button
          variant="filled"
          data-testid="ask-explain"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => fire('explain')}
        >
          <mdui-sym-lightbulb slot="icon" />
          解释这段
        </mdui-button>
        <mdui-button
          variant="outlined"
          data-testid="ask-compose"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => fire('compose')}
        >
          <mdui-sym-chat slot="icon" />
          就这段提问
        </mdui-button>
        <mdui-button-icon
          data-testid="ask-close"
          aria-label="关闭"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setHit(null);
            hideBar();
          }}
        >
          <mdui-sym-close />
        </mdui-button-icon>
      </div>
    </div>
  );
}
