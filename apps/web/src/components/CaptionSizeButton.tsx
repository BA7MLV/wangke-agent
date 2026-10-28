import { Button, Tooltip } from '@heroui/react';
import { useSettings } from '../store/settings';
import { Sym } from '../ui';

const SCALES = [
  { value: 0.8, label: '小' },
  { value: 1, label: '中' },
  { value: 1.35, label: '大' },
  { value: 1.7, label: '特大' },
] as const;

/**
 * 字幕字号循环按钮（小/中/大/特大），写入 settings.captionScale 持久化；
 * Player 页把它映射为 --media-user-font-size，Vidstack 字幕渲染器按此缩放。
 * 经 DefaultVideoLayout 的设置菜单槽位注入，不再占用画面顶部。
 *
 * HeroUI 的 isIconOnly Button：圆形、40/36px、按下 scale、焦点环都来自 HeroUI；
 * 图标是 Material Symbols 元素（跟着 font-size），尺寸在 player-enhance.css 里定。
 */
export default function CaptionSizeButton() {
  const captionScale = useSettings((s) => s.captionScale);
  const update = useSettings((s) => s.update);
  const idx = SCALES.findIndex((s) => Math.abs(s.value - captionScale) < 1e-6);
  const cur = SCALES[idx === -1 ? 1 : idx];
  const next = SCALES[((idx === -1 ? 1 : idx) + 1) % SCALES.length];

  return (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          isIconOnly
          size="sm"
          className="player-ctl player-caption-size"
          aria-label={`字幕大小：${cur.label}，点击切换为${next.label}`}
          onPress={() => update({ captionScale: next.value })}
        >
          <Sym name="format_size" />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>{`字幕大小：${cur.label}`}</Tooltip.Content>
    </Tooltip>
  );
}
