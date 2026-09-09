import { DefaultTooltip } from '@vidstack/react/player/layouts/default';
import { useSettings } from '../store/settings';

/**
 * 思考题弹幕开关（B 站风格「弹」字按钮），写入 settings.danmakuEnabled 持久化。
 * 经 DefaultVideoLayout 的 slots.topControlsGroupEnd 注入顶栏右端。
 */
export default function DanmakuToggleButton() {
  const enabled = useSettings((s) => s.danmakuEnabled);
  const update = useSettings((s) => s.update);
  return (
    <DefaultTooltip content={enabled ? '关闭思考题弹幕' : '开启思考题弹幕'} placement="bottom end">
      <button
        type="button"
        className="vds-button dm-toggle-btn"
        data-active={enabled || undefined}
        aria-label={enabled ? '关闭思考题弹幕' : '开启思考题弹幕'}
        aria-pressed={enabled}
        onClick={() => update({ danmakuEnabled: !enabled })}
      >
        弹
      </button>
    </DefaultTooltip>
  );
}
