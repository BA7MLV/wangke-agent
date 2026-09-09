import { FontSizeOutlined } from '@ant-design/icons';
import { DefaultTooltip } from '@vidstack/react/player/layouts/default';
import { useSettings } from '../store/settings';

const SCALES = [
  { value: 0.8, label: '小' },
  { value: 1, label: '中' },
  { value: 1.35, label: '大' },
  { value: 1.7, label: '特大' },
] as const;

/**
 * 字幕字号循环按钮（小/中/大/特大），写入 settings.captionScale 持久化；
 * Player 页把它映射为 --media-user-font-size，Vidstack 字幕渲染器按此缩放。
 * 经 DefaultVideoLayout 的 slots.topControlsGroupEnd 注入顶栏右端。
 */
export default function CaptionSizeButton() {
  const captionScale = useSettings((s) => s.captionScale);
  const update = useSettings((s) => s.update);
  const idx = SCALES.findIndex((s) => Math.abs(s.value - captionScale) < 1e-6);
  const cur = SCALES[idx === -1 ? 1 : idx];
  const next = SCALES[((idx === -1 ? 1 : idx) + 1) % SCALES.length];
  return (
    <DefaultTooltip content={`字幕大小：${cur.label}`} placement="bottom end">
      <button
        type="button"
        className="vds-button caption-size-btn"
        aria-label={`字幕大小：${cur.label}，点击切换为${next.label}`}
        onClick={() => update({ captionScale: next.value })}
      >
        <FontSizeOutlined className="vds-icon" />
      </button>
    </DefaultTooltip>
  );
}
