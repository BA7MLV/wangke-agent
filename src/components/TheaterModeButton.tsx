import { DefaultTooltip } from '@vidstack/react/player/layouts/default';
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
 */
export default function TheaterModeButton({ active, onToggle }: TheaterModeButtonProps) {
  const label = active ? '退出影院模式' : '影院模式';

  return (
    <DefaultTooltip content={label} placement="top">
      <button
        type="button"
        className="vds-button theater-mode-btn"
        data-active={active || undefined}
        data-testid="theater-mode-button"
        aria-label={label}
        aria-pressed={active}
        onClick={onToggle}
      >
        {/* icon-swap：影院 / 全屏两个图标叠在同一格交叉淡入淡出。
            之前是同一个 <svg> 里条件换 <path>，切换时是硬跳。
            vds-icon 留在内层 svg 上 —— 它带尺寸，只放在外层换 wrapper 会丢。 */}
        <IconSwap
          active={active ? 'b' : 'a'}
          a={
            <svg className="vds-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 5.5h18v13H3v-13Zm2 2v9h14v-9H5Zm2 1.5 10-1v8l-10-1V9Z" />
            </svg>
          }
          b={
            <svg className="vds-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 5.5h18v13H3v-13Zm2 2v9h14v-9H5Zm2 1.5h10v6H7V9Z" />
            </svg>
          }
        />
      </button>
    </DefaultTooltip>
  );
}
