import { Button } from '@heroui/react';
import { useMediaPlayer, useMediaState } from '@vidstack/react';
import { Sym } from '../ui/icons';

/**
 * 中央大播放按钮（YouTube 首帧的行为）。
 *
 * 只在**本次打开还没播过**时出现：YouTube 在「未开始播放」的画面上压一个播放键，
 * 一旦播过就撤掉（暂停时不再出现 —— 那是移动端/嵌入版的行为，桌面版没有）。
 *
 * 为什么不复用 vidstack 默认布局的 `loadButton`：那个按钮属于「加载布局」，只有把
 * `<MediaPlayer load="play">`（播前不加载媒体）时才会渲染。本项目是本地文件、`load="visible"`，
 * 改 `load` 会连带让「时长未知 / 断点续播读不到进度」并打断全部视频 e2e，代价太大。
 * 所以这里自己渲染一个，放在 `.vds-controls` 之外 —— 和 YouTube 一样，它不随控制栏显隐。
 *
 * 用 HeroUI 的圆形 isIconOnly Button（形状 / 按下 scale / 焦点环都来自 HeroUI），
 * 尺寸与配色在 player-enhance.css 的 .player-big-play 里定。
 */
export default function PlayerBigPlayButton() {
  const player = useMediaPlayer();
  const started = useMediaState('started');
  const canPlay = useMediaState('canPlay');

  // 播放过 / 还没就绪（元数据没到）都不显示，避免点了没反应
  if (started || !canPlay) return null;

  return (
    <Button
      isIconOnly
      size="lg"
      className="player-big-play"
      data-testid="player-big-play"
      aria-label="播放"
      onPress={() => {
        // 把键盘焦点交给播放器：vidstack 的快捷键默认只在「播放器持有焦点」时生效
        // （keyTarget='player'），而这个按钮点完就会卸载 —— 不主动转移焦点的话，
        // 卸载引发的 focusout 会把快捷键一起关掉，用户点完播放再按空格就没反应。
        player?.el?.focus();
        void player?.play();
      }}
    >
      <Sym name="play" filled className="player-big-play__icon" />
    </Button>
  );
}
