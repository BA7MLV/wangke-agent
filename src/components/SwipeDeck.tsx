import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CardRow } from '../store/db';
import { fmtTime } from '../utils/vtt';
import { ms } from './motion';

interface Props {
  /** 待审卡片（按时间排序），顶卡 = pending[0] */
  pending: CardRow[];
  keptCount: number;
  /** 已审总数（保留 + 丢弃），用于进度文案 */
  judgedCount: number;
  onJudge: (card: CardRow, keep: boolean) => void;
  onUndo: () => void;
  canUndo: boolean;
  onSeek: (t: number) => void;
}

/** 水平位移超过该值（px）松手即判定飞出，否则回弹 */
const FLY_THRESHOLD = 100;

/**
 * Tinder 式滑卡审核：右滑保留、左滑丢弃、点击翻面、可撤销。
 * 手势复用 EditableBlock 的约定：touchAction pan-y（垂直滚动优先）、拖拽期直接改
 * DOM transform + is-dragging 关过渡、松手按阈值判定。桌面端用按钮/键盘操作。
 */
export default function SwipeDeck({ pending, keptCount, judgedCount, onJudge, onUndo, canUndo, onSeek }: Props) {
  const top = pending[0];
  const [flipped, setFlipped] = useState(false);
  const [leaving, setLeaving] = useState<'left' | 'right' | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const keepHintRef = useRef<HTMLSpanElement>(null);
  const dropHintRef = useRef<HTMLSpanElement>(null);
  const gesture = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  /** 拖拽后的 touchend 会紧跟一个 click，用它吞掉避免误翻面 */
  const suppressClick = useRef(false);
  const flyTimer = useRef(0);

  const topId = top?.id;
  // 换卡重置翻面；卸载时清飞出定时器
  useEffect(() => {
    setFlipped(false);
  }, [topId]);
  useEffect(() => () => window.clearTimeout(flyTimer.current), []);

  /** 判定并播放飞出动画，动画结束才通知父级落库（保证动画可见） */
  const commit = (dir: 'left' | 'right') => {
    if (!top || leaving) return;
    const el = cardRef.current;
    if (el) {
      el.classList.remove('is-dragging');
      el.style.transform = ''; // 交还给 CSS 类做过渡
    }
    if (keepHintRef.current) keepHintRef.current.style.opacity = '';
    if (dropHintRef.current) dropHintRef.current.style.opacity = '';
    setLeaving(dir);
    flyTimer.current = window.setTimeout(() => {
      onJudge(top, dir === 'right');
      setLeaving(null);
    }, ms('fast', 250));
  };

  const setDragVisual = (dx: number) => {
    const el = cardRef.current;
    if (!el) return;
    el.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
    if (keepHintRef.current) keepHintRef.current.style.opacity = dx > 0 ? String(Math.min(1, dx / 90)) : '0';
    if (dropHintRef.current) dropHintRef.current.style.opacity = dx < 0 ? String(Math.min(1, -dx / 90)) : '0';
  };

  const flip = () => {
    if (!leaving) setFlipped((f) => !f);
  };

  if (!top) return null;

  return (
    <>
      <div
        className="deck"
        data-testid="swipe-deck"
        tabIndex={0}
        role="group"
        aria-label="卡片审核：右箭头保留，左箭头丢弃，空格翻面，退格撤销"
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') commit('right');
          else if (e.key === 'ArrowLeft') commit('left');
          else if (e.key === ' ') {
            e.preventDefault();
            flip();
          } else if (e.key === 'Backspace') onUndo();
        }}
      >
        {/* 底层两张仅作堆叠视觉 */}
        {pending.slice(1, 3).map((c, i) => (
          <div key={c.id} className={`deck-card deck-under-${i + 1}`} aria-hidden>
            <div className="deck-face">
              <span className="face-tag">Q</span>
              <div className="face-text">{c.q}</div>
            </div>
          </div>
        ))}

        <div
          ref={cardRef}
          className={`deck-card is-top${leaving ? ` fly-${leaving}` : ''}`}
          style={{ touchAction: 'pan-y', zIndex: 2 }}
          onTouchStart={(e) => {
            if (leaving) return;
            const t = e.touches[0];
            gesture.current = { x: t.clientX, y: t.clientY, dragging: false };
            cardRef.current?.classList.add('is-dragging');
          }}
          onTouchMove={(e) => {
            const g = gesture.current;
            if (!g || leaving) return;
            const t = e.touches[0];
            const dx = t.clientX - g.x;
            const dy = t.clientY - g.y;
            if (!g.dragging) {
              // 横向意图明确才进入拖拽；垂直优先让给滚动
              if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) g.dragging = true;
              else if (Math.abs(dy) > 8) gesture.current = null;
              else return;
            }
            if (g.dragging) setDragVisual(dx);
          }}
          onTouchEnd={(e) => {
            const g = gesture.current;
            const el = cardRef.current;
            el?.classList.remove('is-dragging');
            if (!g || !el) return;
            gesture.current = null;
            if (!g.dragging) return; // 轻点：交给 click 翻面
            suppressClick.current = true;
            const dx = e.changedTouches[0].clientX - g.x;
            if (Math.abs(dx) > FLY_THRESHOLD) commit(dx > 0 ? 'right' : 'left');
            else {
              // 未过阈值：回弹（清内联样式，基类 transition 接管）
              el.style.transform = '';
              if (keepHintRef.current) keepHintRef.current.style.opacity = '';
              if (dropHintRef.current) dropHintRef.current.style.opacity = '';
            }
          }}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            flip();
          }}
        >
          <span ref={dropHintRef} className="deck-hint drop">
            丢弃
          </span>
          <span ref={keepHintRef} className="deck-hint keep">
            保留
          </span>
          <div className={`deck-inner${flipped ? ' flipped' : ''}`}>
            <div className="deck-face front">
              <span className="face-tag">Q</span>
              <div className="face-text">{top.q}</div>
              <div className="face-tip">点击翻面看答案</div>
            </div>
            <div className="deck-face back">
              <span className="face-tag a">A</span>
              <div className="face-text">{top.a}</div>
              <div className="face-src">
                出自{' '}
                <a
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeek(top.time);
                  }}
                >
                  [{fmtTime(top.time)}]
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="deck-actions">
        <mdui-tooltip content="撤销上一张">
          <mdui-button-icon data-testid="swipe-undo" aria-label="撤销上一张" disabled={!canUndo || leaving !== null} onClick={onUndo}>
            <mdui-sym-undo />
          </mdui-button-icon>
        </mdui-tooltip>
        {/* 「丢弃」是危险语义但 MD3 的按钮没有危险色变体，靠覆盖主色令牌上错误色。
            语义不能只靠颜色，按钮文案仍然写清动作。 */}
        <mdui-button
          data-testid="swipe-drop"
          variant="outlined"
          disabled={leaving !== null}
          onClick={() => commit('left')}
          style={{ '--mdui-color-primary': 'var(--mdui-color-error)' } as CSSProperties}
        >
          <mdui-sym-close slot="icon" />
          丢弃
        </mdui-button>
        <mdui-button data-testid="swipe-swap" variant="outlined" disabled={leaving !== null} onClick={flip}>
          <mdui-sym-swap-horiz slot="icon" />
          翻面
        </mdui-button>
        {/* 「保留」沿用原来的绿色语义（MD3 规范里没有 success 色，用应用自补的令牌）。
            filled 变体的底色取 --mdui-color-primary、文字取 --mdui-color-on-primary，
            所以两个都要覆盖成绿色系。 */}
        <mdui-button
          data-testid="swipe-keep"
          variant="filled"
          disabled={leaving !== null}
          onClick={() => commit('right')}
          style={
            {
              '--mdui-color-primary': 'var(--app-color-success)',
              '--mdui-color-on-primary': 'var(--app-color-on-success)',
            } as CSSProperties
          }
        >
          <mdui-sym-check slot="icon" />
          保留
        </mdui-button>
      </div>
      <div className="deck-status" data-testid="swipe-status">
        已审 {judgedCount} · 待审 {pending.length} · 已保留 {keptCount}
      </div>
    </>
  );
}
