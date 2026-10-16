import { useCallback } from 'react';
import { THINKING_LEVELS } from '../api/modelCaps';
import type { ThinkingLevel } from '../api/siliconflow';
import './reasoning-effort-slider.css';

interface Props {
  value: ThinkingLevel;
  onChange: (next: ThinkingLevel) => void;
  disabled?: boolean;
  /**
   * 铺满容器宽度（下拉面板里用），而不是工具行上那种 108px 定宽小块。
   *
   * 定宽是给工具行准备的：那一行已经并排放了模型 chip、技能、发送键，滑块再宽就换行了。
   * 进了面板之后横向空间是白给的，不铺满反而像没做完。
   */
  fluid?: boolean;
}

/**
 * 思考深度：一条带节点刻度的横向滑块，**6 档，第一档是不思考**。
 *
 * 档位与文案取自 `THINKING_LEVELS`（在 API 层），这里只负责画 —— 档位表是功能契约，
 * 纯逻辑测试要能钉住它，所以不放在组件里。
 *
 * 用原生 `<input type="range">` 做交互与无障碍（键盘左右键、屏幕阅读器），
 * 外观纯 CSS。`step={1}` 保证松手后落回最近节点。
 *
 * 节点圆点用绝对定位叠在轨道正中，pointer-events:none 避免抢滑块的点击/拖拽。
 *
 * ⚠️ 6 档里**没有**「够不到就置灰」的逻辑：档位集逐模型不同（GLM-5.2 只声明 high/max），
 * 中间几档会映射到同一个值。这是模型真没有那么多档，不是控件坏了 —— 刻度固定显示 6 档，
 * 是为了让「这台模型能到多深」这件事在视觉上有参照物。
 */
export default function ReasoningEffortSlider({ value, onChange, disabled, fluid }: Props) {
  const index = THINKING_LEVELS.findIndex((s) => s.value === value);
  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const idx = Number(event.target.value);
      const next = THINKING_LEVELS[idx]?.value;
      if (next && next !== value) onChange(next);
    },
    [value, onChange],
  );

  return (
    <div className={fluid ? 'reasoning-slider reasoning-slider--fluid' : 'reasoning-slider'} data-testid="chat-effort-slider">
      {/* 轨道容器：底色 + 已填充区（由 JS 计算宽度）+ range input + 刻度圆点 */}
      <div className="reasoning-slider__track">
        <div
          className="reasoning-slider__fill"
          style={{ width: `${(Math.max(0, index) / (THINKING_LEVELS.length - 1)) * 100}%` }}
        />
        <input
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
        {/* 六个刻度圆点：告诉用户这里是几档、能停在哪。
            `data-filled` 是给填充侧那几颗换个颜色用的（它们压在填充色上，同一个灰点在
            两种底色里必有一种看不见）；**当前档位那颗不需要「选中态」** —— 它正好被
            thumb 盖住，标了也看不见。 */}
        <div className="reasoning-slider__ticks" aria-hidden="true">
          {THINKING_LEVELS.map((s, i) => (
            <span key={s.value} className="reasoning-slider__tick" data-filled={i <= index ? '1' : undefined} />
          ))}
        </div>
      </div>
      {/* 当前档位文字：thumb 右侧的微型标签 */}
      <span className="reasoning-slider__value" aria-hidden="true">
        {THINKING_LEVELS[index]?.label ?? ''}
      </span>
    </div>
  );
}
