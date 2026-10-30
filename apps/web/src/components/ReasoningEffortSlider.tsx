import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { THINKING_LEVELS } from '../api/modelCaps';
import type { ThinkingLevel } from '../api/siliconflow';
import ReasoningMeteorTexture from './ReasoningMeteorTexture';
import { meteorProfile } from './reasoning-meteors';
import './reasoning-effort-slider.css';

interface Props {
  value: ThinkingLevel;
  onChange: (next: ThinkingLevel) => void;
  disabled?: boolean;
  /** 在模型面板中铺满可用宽度。 */
  fluid?: boolean;
}

const MAX_INDEX = THINKING_LEVELS.length - 1;
const clampIndex = (index: number) => Number.isFinite(index) ? Math.max(0, Math.min(MAX_INDEX, index)) : 0;

// Native range thumb centers travel from half a thumb inside either edge.
const position = (index: number) => {
  const progress = clampIndex(index) / MAX_INDEX;
  return `calc(${progress * 100}% + ${0.5 - progress} * var(--reasoning-thumb-size))`;
};

/**
 * 思考深度：一条带节点刻度的横向滑块，**6 档，第一档是不思考**。
 *
 * 档位与文案取自 `THINKING_LEVELS`（在 API 层），这里只负责画 —— 档位表是功能契约，
 * 纯逻辑测试要能钉住它，所以不放在组件里。
 *
 * 用原生 `<input type="range">` 做交互与无障碍（键盘左右键、屏幕阅读器），
 * 拖动时只更新组件内的连续预览，松手后才提交最近的六档之一，避免反复写设置。
 * 原生 thumb 负责命中几何；可视 thumb 与填充共用位置，松手时一起平滑吸附。
 *
 * 节点圆点用绝对定位叠在轨道正中，pointer-events:none 避免抢滑块的点击/拖拽。
 *
 * ⚠️ 6 档里**没有**「够不到就置灰」的逻辑：档位集逐模型不同（GLM-5.2 只声明 high/max），
 * 中间几档会映射到同一个值。这是模型真没有那么多档，不是控件坏了 —— 刻度固定显示 6 档，
 * 是为了让「这台模型能到多深」这件事在视觉上有参照物。
 */
export default function ReasoningEffortSlider({ value, onChange, disabled, fluid }: Props) {
  const inputId = useId();
  const index = THINKING_LEVELS.findIndex((s) => s.value === value);
  const max = MAX_INDEX;
  const [draft, setDraft] = useState<number | null>(null);
  const pointerId = useRef<number | null>(null);
  const visualIndex = clampIndex(draft ?? index);
  const nearestIndex = Math.round(visualIndex);
  const depth = visualIndex / max;
  const remaining = depth === 0 ? '100%' : depth === 1 ? '0%' : position(max - visualIndex);
  const cancelDrag = useCallback(() => {
    pointerId.current = null;
    setDraft(null);
  }, []);
  // A model/value change or becoming disabled must not leave an old drag active.
  useEffect(cancelDrag, [value, disabled, cancelDrag]);
  const commit = useCallback(
    (nextIndex: number) => {
      const next = THINKING_LEVELS[Math.round(clampIndex(nextIndex))]?.value;
      cancelDrag();
      if (next && next !== value) onChange(next);
    },
    [value, onChange, cancelDrag],
  );
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = clampIndex(Number(event.currentTarget.value));
    if (pointerId.current !== null) setDraft(next);
    else commit(next); // Assistive technology and other non-pointer input.
  };
  const handlePointerDown = (event: React.PointerEvent<HTMLInputElement>) => {
    if (disabled || event.button !== 0 || pointerId.current !== null) return;
    pointerId.current = event.pointerId;
    setDraft(clampIndex(Number(event.currentTarget.value)));
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLInputElement>) => {
    if (pointerId.current !== event.pointerId) return;
    commit(Number(event.currentTarget.value));
  };
  const handlePointerCancel = (event: React.PointerEvent<HTMLInputElement>) => {
    if (pointerId.current === event.pointerId) cancelDrag();
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const destinations: Partial<Record<string, number>> = {
      ArrowLeft: nearestIndex - 1, ArrowDown: nearestIndex - 1,
      ArrowRight: nearestIndex + 1, ArrowUp: nearestIndex + 1,
      PageDown: nearestIndex - 1, PageUp: nearestIndex + 1,
      Home: 0, End: max,
    };
    const next = destinations[event.key];
    if (next === undefined) return;
    event.preventDefault();
    commit(next);
  };

  return (
    <div className={fluid ? 'reasoning-slider reasoning-slider--fluid' : 'reasoning-slider'} data-testid="chat-effort-slider" data-disabled={disabled ? 'true' : undefined} data-dragging={draft !== null ? 'true' : undefined}>
      <div className="reasoning-slider__header">
        <label htmlFor={inputId}>思考深度</label>
        <span className="reasoning-slider__value" aria-hidden="true">{THINKING_LEVELS[nearestIndex]?.label ?? ''}</span>
      </div>
      <div className="reasoning-slider__control">
        <div className="reasoning-slider__track" aria-hidden="true">
          <div className="reasoning-slider__rail-clip">
            <div
              className="reasoning-slider__fill"
              style={{ width: depth === 0 ? '0%' : depth === 1 ? '100%' : position(visualIndex), opacity: 0.65 + depth * 0.35 }}
            />
            <div className="reasoning-slider__meteors" style={{ clipPath: `inset(0 ${remaining} 0 0 round 999px)`, opacity: meteorProfile(depth).opacity }}>
              <ReasoningMeteorTexture intensity={depth} active={!disabled} />
            </div>
            <div className="reasoning-slider__ticks">
              {THINKING_LEVELS.map((s, i) => (
                <span key={s.value} className="reasoning-slider__tick" style={{ left: position(i) }} data-filled={i <= nearestIndex ? '1' : undefined} />
              ))}
            </div>
          </div>
          <span className="reasoning-slider__thumb" style={{ left: position(visualIndex) }} />
        </div>
        <input
          id={inputId}
          className="reasoning-slider__input"
          type="range"
          min={0}
          max={max}
          step="any"
          value={visualIndex}
          disabled={disabled}
          aria-label="思考深度"
          aria-valuenow={nearestIndex}
          aria-valuetext={THINKING_LEVELS[nearestIndex]?.label ?? ''}
          onChange={handleChange}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handlePointerCancel}
          onBlur={cancelDrag}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
}
