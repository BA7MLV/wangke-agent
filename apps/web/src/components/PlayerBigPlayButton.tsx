import { Button } from '@heroui/react';
import { useMediaPlayer, useMediaState } from '@vidstack/react';
import { Sym } from '../ui/icons';

/** B 站式右下角暂停播放标记；小屏沿用布局内的中央播放键。 */
export default function PlayerBigPlayButton() {
  const player = useMediaPlayer();
  const paused = useMediaState('paused');
  const ended = useMediaState('ended');
  const canPlay = useMediaState('canPlay');

  if ((!paused && !ended) || !canPlay) return null;

  return (
    <Button
      isIconOnly
      size="lg"
      className="player-big-play"
      data-testid="player-big-play"
      aria-label={ended ? '重新播放' : '继续播放'}
      onPress={() => {
        // 把键盘焦点交给播放器：vidstack 的快捷键默认只在「播放器持有焦点」时生效
        // （keyTarget='player'），而这个按钮点完就会卸载 —— 不主动转移焦点的话，
        // 卸载引发的 focusout 会把快捷键一起关掉，用户点完播放再按空格就没反应。
        player?.el?.focus();
        void player?.play().catch(() => {});
      }}
    >
      <Sym name="play" filled className="player-big-play__icon" />
    </Button>
  );
}
