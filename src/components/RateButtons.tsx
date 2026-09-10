import { useCallback, useMemo } from 'react';
import { useMediaRemote, useMediaState } from '@vidstack/react';
import { useSettings } from '../store/settings';
import { PRESET_RATES, formatRate, mergeRates, nextRateOf, sameRate } from '../utils/rate';

/**
 * 控制栏倍速快捷按钮（网课刚需，默认布局的倍率菜单藏太深）。
 * 内置 1/1.5/2/3/4x 与「设置 → 播放」里配置的自定义档位一起平铺；
 * 窄屏（布局 data-sm）由 CSS 折叠为单个循环按钮。
 * 档位运算在 utils/rate.ts（纯函数，scripts/test-rate.mjs 覆盖）。
 * 经 DefaultVideoLayout 的 slots.topControlsGroupStart 注入顶栏左端。
 */
export default function RateButtons() {
  const remote = useMediaRemote();
  const rate = useMediaState('playbackRate');
  const customRates = useSettings((s) => s.customRates);

  // 内置档位 ∪ 自定义档位：归一 + 去重 + 升序（自定义与内置重复时不出现两个同值按钮）
  const rates = useMemo(() => mergeRates(PRESET_RATES, customRates), [customRates]);

  // 循环按钮：取比当前大的下一档（当前值不在档位里也能工作），最大档后回到最小档
  const nextRate = nextRateOf(rates, rate);

  const applyRate = useCallback((r: number) => remote.changePlaybackRate(r), [remote]);

  return (
    // 档位多于一屏时横向滚动（隐藏滚动条），不撑破顶栏
    <div className="rate-buttons">
      {rates.map((r) => (
        <button
          key={r}
          type="button"
          className="vds-button rate-btn rate-btn-full"
          data-active={sameRate(rate, r) || undefined}
          aria-label={`倍速 ${formatRate(r)}`}
          aria-pressed={sameRate(rate, r)}
          onClick={() => applyRate(r)}
        >
          {formatRate(r)}
        </button>
      ))}
      <button
        type="button"
        className="vds-button rate-btn rate-btn-cycle"
        aria-label={`当前倍速 ${formatRate(rate)}，点击切换为 ${formatRate(nextRate)}`}
        onClick={() => applyRate(nextRate)}
      >
        {formatRate(rate)}
      </button>
    </div>
  );
}
