import { useMediaRemote, useMediaState } from '@vidstack/react';

const RATES = [1, 1.5, 2, 3] as const;

/**
 * 控制栏倍速快捷按钮（网课刚需，默认布局的倍率菜单藏太深）。
 * 宽屏平铺 1x/1.5x/2x/3x；窄屏（布局 data-sm）由 CSS 折叠为单个循环按钮。
 * 经 DefaultVideoLayout 的 slots.topControlsGroupStart 注入顶栏左端。
 */
export default function RateButtons() {
  const remote = useMediaRemote();
  const rate = useMediaState('playbackRate');
  // 循环按钮：取比当前大的下一档（当前值不在档位里也能工作），最大档后回到 1x
  const nextRate = RATES.find((r) => r > rate + 1e-6) ?? RATES[0];
  return (
    <div className="rate-buttons">
      {RATES.map((r) => (
        <button
          key={r}
          type="button"
          className="vds-button rate-btn rate-btn-full"
          data-active={Math.abs(rate - r) < 1e-6 || undefined}
          aria-label={`倍速 ${r}x`}
          aria-pressed={Math.abs(rate - r) < 1e-6}
          onClick={() => remote.changePlaybackRate(r)}
        >
          {r}x
        </button>
      ))}
      <button
        type="button"
        className="vds-button rate-btn rate-btn-cycle"
        aria-label={`当前倍速 ${rate}x，点击切换为 ${nextRate}x`}
        onClick={() => remote.changePlaybackRate(nextRate)}
      >
        {rate}x
      </button>
    </div>
  );
}
