import { useCallback, useEffect, useState } from 'react';
import { Tooltip } from '@heroui/react';
import type { MediaPlayerInstance } from '@vidstack/react';
import { db, type DanmakuRow } from '../store/db';
import { runDanmaku, type DanmakuProgress } from '../pipelines/danmaku';
import { fmtTime } from '../utils/vtt';
import { TextSwap } from './motion';
import ModelPicker from './ModelPicker';
import PersistentError from './PersistentError';
import { formatCaughtError } from '../utils/errorText';
import { LoadingButton, Panel, PanelBar, PanelBody, PanelProgress, PanelPlaceholder, CueRow, CueSkeleton, SkeletonReveal, useSkeletonGate, Sym, toast, alertDialog } from '../ui';
import './subtitle-danmaku.css';

interface Props {
  videoId: string;
  playerRef: React.RefObject<MediaPlayerInstance | null>;
  /** `null` = 字幕状态还没读到（见 SubtitlePanel 的 onLoadedChange）：未知时不出「请先生成字幕」 */
  hasSubtitles: boolean | null;
}

export default function DanmakuPanel({ videoId, playerRef, hasSubtitles }: Props) {
  const [items, setItems] = useState<DanmakuRow[]>([]);
  /**
   * 首次读回之前为 false —— 空态只在 `loaded && 真的为空` 时出现。
   * 判据不能是 `items.length === 0`：reload 是异步 IndexedDB 读，首帧数组必然为空，
   * 有弹幕的课程会先闪一下空态（不变量 I1）。
   */
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState<DanmakuProgress | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const rows = await db.danmakus.where('videoId').equals(videoId).sortBy('time');
      setItems(rows);
    } catch (e) {
      // 读失败按「确实为空」收尾，别把界面永远留在骨架/空白上（不变量 I5）
      setErrorText(formatCaughtError(e));
    } finally {
      setLoaded(true);
    }
  }, [videoId]);

  useEffect(() => {
    // 切视频先回到「未知」态，避免拿上一门课的弹幕列表当本课的空/满判据
    setLoaded(false);
    void reload();
  }, [reload]);

  const showSkeleton = useSkeletonGate(!loaded);

  const start = async () => {
    setErrorText(null);
    setProgress({ done: 0, total: 1, message: '准备中…' });
    try {
      const count = await runDanmaku(videoId, setProgress);
      toast.success(count > 0 ? `弹幕生成完成，共 ${count} 条思考题` : '生成完成：这段课程没有挖出合适的思考题');
    } catch (e) {
      const errText = formatCaughtError(e);
      setErrorText(errText);
      void alertDialog({ headline: '弹幕生成失败', description: errText, copyText: errText });
    } finally {
      setProgress(null);
      await reload();
    }
  };

  const running = progress !== null;
  const pct = progress && progress.total > 1 ? Math.round((progress.done / progress.total) * 100) : undefined;

  return (
    <Panel testId="panel-dm">
      <PanelBar>
        {/* HeroUI 的 Button 没有 title 属性，未生成字幕时的原因说明改用 Tooltip
            （与讲义 / 卡片面板同一套做法）。Tooltip.Trigger 落在按钮外层，
            所以按钮禁用时悬浮说明依然可读。 */}
        <Tooltip>
          <Tooltip.Trigger>
            <LoadingButton
              loading={running}
              variant="primary"
              isDisabled={hasSubtitles !== true}
              onPress={start}
              data-testid="dm-generate"
            >
              <Sym name="comment" />
              {items.length > 0 ? '重新生成弹幕' : '生成弹幕'}
            </LoadingButton>
          </Tooltip.Trigger>
          <Tooltip.Content>
            <p>{hasSubtitles ? '按课程内容设计思考题' : '请先在「字幕」页生成字幕'}</p>
          </Tooltip.Content>
        </Tooltip>
        <ModelPicker slot="chat" field="llmModel" />
      </PanelBar>

      {running && progress && (
        <PanelProgress testId="dm-progress" percent={pct} text={<TextSwap text={progress.message} />} />
      )}

      <PersistentError title="弹幕生成失败" text={errorText} onClose={() => setErrorText(null)} />

      <PanelBody testId="dm-list">
        <SkeletonReveal show={showSkeleton} skeleton={<CueSkeleton rows={8} />}>
          {hasSubtitles === false && !running && (
            <PanelPlaceholder testId="dm-empty">弹幕基于字幕内容生成，请先在「字幕」页生成字幕</PanelPlaceholder>
          )}
          {hasSubtitles === true && loaded && items.length === 0 && !running && (
            <PanelPlaceholder testId="dm-empty">
              点击「生成弹幕」，AI 将按课程内容设计思考题，播放到对应时间点会自画面右侧向左飘过
            </PanelPlaceholder>
          )}
          {items.map((d) => (
            <CueRow
              key={d.id}
              time={fmtTime(d.time)}
              testId="dm-row"
              onClick={() => {
                if (playerRef.current) playerRef.current.currentTime = d.time + 0.01;
              }}
            >
              {d.text}
            </CueRow>
          ))}
        </SkeletonReveal>
      </PanelBody>
    </Panel>
  );
}
