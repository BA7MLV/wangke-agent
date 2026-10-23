import { Button, Tooltip } from '@heroui/react';
import { useSettings } from '../store/settings';

/**
 * 思考题弹幕开关（B 站风格「弹」字按钮），写入 settings.danmakuEnabled 持久化。
 * 桌面位于底栏，小屏放在顶栏。
 *
 * 换成 HeroUI 的 Button：形状（药丸）、按下 scale、焦点环、缓动都交给 HeroUI，
 * 颜色走 player-enhance.css 里给 .player-ctl 的「视频半透明白」契约；开启态由
 * data-active 触发主色填充。
 */
export default function DanmakuToggleButton() {
  const enabled = useSettings((s) => s.danmakuEnabled);
  const update = useSettings((s) => s.update);
  const label = enabled ? '关闭思考题弹幕' : '开启思考题弹幕';

  return (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          className="player-ctl player-dm-toggle"
          size="sm"
          data-active={enabled || undefined}
          aria-label={label}
          aria-pressed={enabled}
          onPress={() => update({ danmakuEnabled: !enabled })}
        >
          弹
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}
