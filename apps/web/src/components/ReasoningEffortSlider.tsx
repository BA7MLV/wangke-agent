import { useCallback, useId } from 'react';
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

// Native range thumb centers travel from half a thumb inside either edge.
const position = (index: number) => {
  const progress = index / (THINKING_LEVELS.length - 1);
  return `calc(${progress * 100}% + ${0.5 - progress} * var(--reasoning-thumb-size))`;
};

/**
 * 思考深度：一条带节点刻度的横向滑块，**6 档，第一档是不思考**。
 *
 * 档位与文案取自 `THINKING_LEVELS`（在 API 层），这里只负责画 —— 档位表是功能契约，
 * 纯逻辑测试要能钉住它，所以不放在组件里。
 *
 * 用原生 `<input type="range">` 做交互与无障碍（键盘左右键、屏幕阅读器），
 * `step={1}` 保证松手后落回最近节点。胶囊轨道与原生 thumb 使用同一组几何参数。
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
  const depth = Math.max(0, index) / (THINKING_LEVELS.length - 1);
  const remaining = depth === 0 ? '100%' : index === THINKING_LEVELS.length - 1 ? '0%' : position(THINKING_LEVELS.length - 1 - Math.max(0, index));
  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const idx = Number(event.target.value);
      const next = THINKING_LEVELS[idx]?.value;
      if (next && next !== value) onChange(next);
    },
    [value, onChange],
  );

  return (
    <div className={fluid ? 'reasoning-slider reasoning-slider--fluid' : 'reasoning-slider'} data-testid="chat-effort-slider" data-disabled={disabled ? 'true' : undefined}>
      <div className="reasoning-slider__header">
        <label htmlFor={inputId}>思考深度</label>
        <span className="reasoning-slider__value" aria-hidden="true">{THINKING_LEVELS[index]?.label ?? ''}</span>
      </div>
      <div className="reasoning-slider__control">
        <div className="reasoning-slider__track" aria-hidden="true">
          <div
            className="reasoning-slider__fill"
            style={{ width: depth === 0 ? '0%' : index === THINKING_LEVELS.length - 1 ? '100%' : position(Math.max(0, index)), opacity: 0.65 + depth * 0.35 }}
          />
          <div className="reasoning-slider__meteors" style={{ clipPath: `inset(0 ${remaining} 0 0 round 999px)`, opacity: meteorProfile(depth).opacity }}>
            <ReasoningMeteorTexture intensity={depth} active={!disabled} />
          </div>
          <div className="reasoning-slider__ticks">
            {THINKING_LEVELS.map((s, i) => (
              <span key={s.value} className="reasoning-slider__tick" style={{ left: position(i) }} data-filled={i <= index ? '1' : undefined} />
            ))}
          </div>
        </div>
        <input
          id={inputId}
          className="reasoning-slider__input"
          type="range"
          min={0}
          max={THINKING_LEVELS.length - 1}
          step={1}
          value={Math.max(0, index)}
          disabled={disabled}
          aria-label="思考深度"
          aria-valuetext={THINKING_LEVELS[index]?.label ?? ''}
          onChange={handleChange}
        />
      </div>
    </div>
  );
}
