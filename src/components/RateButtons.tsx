import { useCallback, useMemo } from 'react';
import { Button, ToggleButton, ToggleButtonGroup, Tooltip } from '@heroui/react';
import { useMediaRemote, useMediaState } from '@vidstack/react';
import { useSettings } from '../store/settings';
import { PRESET_RATES, formatRate, mergeRates, nextRateOf, sameRate } from '../utils/rate';

/**
 * 控制栏倍速快捷按钮（网课刚需，默认布局的倍率菜单藏太深）。
 *
 * 用 HeroUI 的 `ToggleButtonGroup` 表达「一组互斥档位」：内置 1/1.5/2/3/4x 与
 * 「设置 → 播放」里配置的自定义档位一起平铺，选中档由 HeroUI 用主色填充。
 * 窄屏（布局 data-sm）由 CSS 折叠为单个循环按钮（现有行为不变）。
 * 经 DefaultVideoLayout 的 slots.topControlsGroupStart 注入顶栏左端。
 *
 * 颜色不在这里写：HeroUI 的 Button/ToggleButton 把配色收敛到自身的 --button-* /
 * --toggle-button-* 变量，播放器作用域里统一覆盖成「视频半透明白」（见 player-enhance.css）。
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

  // 当前档位。不在档位表中（比如自定义档位被删）时为 undefined —— 此时组内无选中项，
  // 循环按钮仍能把它带回最近的一档。
  const current = rates.find((r) => sameRate(rate, r));

  return (
    <>
      <ToggleButtonGroup
        className="player-rate-group"
        size="sm"
        aria-label="播放速度"
        selectionMode="single"
        // 受控：只认落在档位表里的值。点已选中的档会给出空集，这里忽略，故不会取消选中。
        selectedKeys={current != null ? [String(current)] : []}
        onSelectionChange={(keys) => {
          const next = [...keys][0];
          if (next != null) applyRate(Number(next));
        }}
      >
        {rates.map((r) => (
          <ToggleButton
            key={r}
            id={String(r)}
            className="player-rate-btn"
            aria-label={`倍速 ${formatRate(r)}`}
          >
            {formatRate(r)}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      {/* 窄屏折叠：默认隐藏，data-sm 下与上面的组互换（见 player-enhance.css） */}
      <Tooltip>
        <Tooltip.Trigger>
          <Button
            className="player-ctl player-rate-cycle"
            size="sm"
            aria-label={`当前倍速 ${formatRate(rate)}，点击切换为 ${formatRate(nextRate)}`}
            onPress={() => applyRate(nextRate)}
          >
            {formatRate(rate)}
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content>点击切换下一档倍速</Tooltip.Content>
      </Tooltip>
    </>
  );
}
