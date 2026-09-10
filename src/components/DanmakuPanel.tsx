import { useCallback, useEffect, useState } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import { db, type DanmakuRow } from '../store/db';
import { runDanmaku, type DanmakuProgress } from '../pipelines/danmaku';
import { fmtTime } from '../utils/vtt';
import { TextSwap } from './motion';
import ModelPicker from './ModelPicker';
import PersistentError from './PersistentError';
import { formatCaughtError } from '../utils/errorText';
import { Panel, PanelBar, PanelBody, PanelProgress, PanelPlaceholder, CueRow, toast, alertDialog } from '../ui';
import './subtitle-danmaku.css';

interface Props {
  videoId: string;
  playerRef: React.RefObject<MediaPlayerInstance | null>;
  hasSubtitles: boolean;
}

export default function DanmakuPanel({ videoId, playerRef, hasSubtitles }: Props) {
  const [items, setItems] = useState<DanmakuRow[]>([]);
  const [progress, setProgress] = useState<DanmakuProgress | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const rows = await db.danmakus.where('videoId').equals(videoId).sortBy('time');
    setItems(rows);
  }, [videoId]);

  useEffect(() => {
    reload();
  }, [reload]);

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
        <mdui-button
          variant="filled"
          loading={running}
          disabled={!hasSubtitles}
          onClick={start}
          data-testid="dm-generate"
          title={hasSubtitles ? undefined : '请先在「字幕」页生成字幕'}
        >
          <mdui-sym-comment slot="icon" />
          {items.length > 0 ? '重新生成弹幕' : '生成弹幕'}
        </mdui-button>
        <ModelPicker slot="chat" field="llmModel" />
      </PanelBar>

      {running && progress && (
        <PanelProgress testId="dm-progress" percent={pct} text={<TextSwap text={progress.message} />} />
      )}

      <PersistentError title="弹幕生成失败" text={errorText} onClose={() => setErrorText(null)} />

      <PanelBody testId="dm-list">
        {!hasSubtitles && !running && (
          <PanelPlaceholder testId="dm-empty">弹幕基于字幕内容生成，请先在「字幕」页生成字幕</PanelPlaceholder>
        )}
        {hasSubtitles && items.length === 0 && !running && (
          <PanelPlaceholder testId="dm-empty">
            点击「生成弹幕」，AI 将按课程内容设计思考题，播放到对应时间点时弹在画面顶部
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
      </PanelBody>
    </Panel>
  );
}
