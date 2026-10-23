import { useEffect, useMemo, useRef } from 'react';
import { Menu, useMediaState, usePlaybackRateOptions, type MenuInstance } from '@vidstack/react';
import { useDefaultLayoutContext } from '@vidstack/react/player/layouts/default';
import { useSettings } from '../store/settings';
import { PRESET_RATES, formatRate, mergeRates } from '../utils/rate';

/** 底栏单入口倍速菜单：鼠标悬停或点击打开，键盘与触屏交给 Vidstack。 */
export default function RateButtons() {
  const rate = useMediaState('playbackRate');
  const customRates = useSettings((s) => s.customRates);
  const { isSmallLayout } = useDefaultLayoutContext();
  const rates = useMemo(() => mergeRates([0.5, 0.75, 1.25, ...PRESET_RATES], customRates), [customRates]);
  const options = usePlaybackRateOptions({ rates, normalLabel: '正常' });
  const menuRef = useRef<MenuInstance>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  return (
    <Menu.Root
      ref={menuRef}
      className="player-speed-menu"
      onPointerEnter={(event) => {
        if (event.pointerType !== 'mouse') return;
        clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => menuRef.current?.open(), 160);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') return;
        clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => menuRef.current?.close(), 180);
      }}
    >
      <Menu.Button className="vds-menu-button vds-button player-speed-trigger" disabled={options.disabled} aria-label={`播放速度：${formatRate(rate)}`}>
        {rate === 1 ? '倍速' : formatRate(rate)}
      </Menu.Button>
      <Menu.Content className="vds-menu-items player-speed-options" placement={isSmallLayout ? 'bottom end' : 'top end'} offset={8}>
        <Menu.RadioGroup value={options.selectedValue} aria-label="播放速度">
          {options.map(({ label, value, select, rate: optionRate }) => (
            <Menu.Radio
              className="vds-radio player-speed-option"
              value={value}
              key={value}
              onSelect={(event) => {
                select(event);
                menuRef.current?.close(event);
              }}
            >
              <span>{optionRate === 1 ? '1.0x 正常' : label}</span>
              <span className="player-speed-check" aria-hidden>✓</span>
            </Menu.Radio>
          ))}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  );
}
