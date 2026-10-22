import { Button, Tooltip } from '@heroui/react';
import { Sym } from '../ui/icons';
import { IconSwap } from './motion';

interface TheaterModeButtonProps {
  active: boolean;
  onToggle: () => void;
}

/**
 * 桌面端影院模式开关。
 *
 * 通过 DefaultVideoLayout 的 `beforeFullscreenButton` 槽位放在全屏按钮左侧，
 * 位置与 YouTube 一致；这里只负责交互，页面级布局由 Player 的状态与 theme.css 接管。
 *
 * HeroUI 的 isIconOnly Button：圆形、按下 scale、焦点环来自 HeroUI；选中态由
 * data-active 触发主色填充（见 player-enhance.css 的 .player-ctl 契约）。
 */
export default function TheaterModeButton({ active, onToggle }: TheaterModeButtonProps) {
  const label = active ? '退出影院模式' : '影院模式';

  return (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          isIconOnly
          className="player-ctl theater-mode-btn"
          data-active={active || undefined}
          data-testid="theater-mode-button"
          aria-label={label}
          aria-pressed={active}
          onPress={onToggle}
        >
          {/* 保留原有的交叉淡入淡出，只替换图标字形。 */}
          <IconSwap
            active={active ? 'b' : 'a'}
            a={<Sym name="theater" />}
            b={<Sym name="theater_exit" />}
          />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}
