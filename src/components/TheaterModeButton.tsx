import { Button, Tooltip } from '@heroui/react';
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
          {/* icon-swap：影院 / 全屏两个图标叠在同一格交叉淡入淡出。
              之前是同一个 <svg> 里条件换 <path>，切换时是硬跳。 */}
          <IconSwap
            active={active ? 'b' : 'a'}
            a={
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 5.5h18v13H3v-13Zm2 2v9h14v-9H5Zm2 1.5 10-1v8l-10-1V9Z" />
              </svg>
            }
            b={
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 5.5h18v13H3v-13Zm2 2v9h14v-9H5Zm2 1.5h10v6H7V9Z" />
              </svg>
            }
          />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}
