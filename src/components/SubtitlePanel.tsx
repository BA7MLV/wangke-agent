import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Progress, Space, Typography } from 'antd';
import { AudioOutlined, DownloadOutlined } from '@ant-design/icons';
import type { MediaPlayerInstance } from '@vidstack/react';
import { db, type SegmentRow } from '../store/db';
import { runTranscription, type TranscribeProgress } from '../pipelines/transcribe';
import { fmtTime, toSRT, toVTT, type Cue } from '../utils/vtt';
import { splitIntoCues } from '../utils/cues';
import { formatCaughtError } from '../utils/errorText';
import { TextSwap } from './motion';
import ModelPicker from './ModelPicker';
import PersistentError from './PersistentError';

interface Props {
  videoId: string;
  playerRef: React.RefObject<MediaPlayerInstance | null>;
  currentTime: number;
  onSegmentsChange: (cues: Cue[]) => void;
}

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function SubtitlePanel({ videoId, playerRef, currentTime, onSegmentsChange }: Props) {
  const { message, modal } = App.useApp();
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [progress, setProgress] = useState<TranscribeProgress | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    const rows = await db.segments.where('videoId').equals(videoId).sortBy('idx');
    setSegments(rows.filter((r) => r.status === 1 && r.text));
  }, [videoId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // 展开为展示用 cue：优先 ASR 句级时间戳（超长的再按字数细分），无则按标点+字数估算
  const cues = useMemo(
    () =>
      segments.flatMap((s) =>
        s.cues?.length
          ? s.cues.flatMap((c) => splitIntoCues(c.start, c.end, c.text))
          : splitIntoCues(s.start, s.end, s.text),
      ),
    [segments],
  );

  useEffect(() => {
    onSegmentsChange(cues);
  }, [cues, onSegmentsChange]);

  const start = async () => {
    setErrorText(null);
    setProgress({ phase: 'extract', done: 0, total: 1, message: '准备中…' });
    try {
      await runTranscription(videoId, setProgress);
      message.success('字幕生成完成');
    } catch (e) {
      const errText = formatCaughtError(e);
      setErrorText(errText);
      modal.error({
        title: '转写失败',
        width: 560,
        content: (
          <Typography.Paragraph
            copyable={{ text: errText }}
            style={{ whiteSpace: 'pre-wrap', userSelect: 'text', maxHeight: 320, overflow: 'auto' }}
          >
            {errText}
          </Typography.Paragraph>
        ),
      });
    } finally {
      setProgress(null);
      await reload();
    }
  };

  const activeIdx = cues.findIndex((c) => currentTime >= c.start && currentTime < c.end);

  // 自动滚动到当前字幕
  useEffect(() => {
    if (activeIdx < 0 || !listRef.current) return;
    const el = listRef.current.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIdx]);

  const running = progress !== null;
  const pct =
    progress?.phase === 'asr'
      ? Math.round((progress.done / Math.max(1, progress.total)) * 100)
      : progress?.phase === 'extract'
        ? Math.round(progress.done * 100)
        : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Space style={{ padding: '8px 0', flexShrink: 0 }} wrap>
        <Button type="primary" icon={<AudioOutlined />} loading={running} onClick={start}>
          {segments.length > 0 ? '重新生成字幕' : '生成字幕'}
        </Button>
        {segments.length > 0 && (
          <>
            <Button
              size="small"
              icon={<DownloadOutlined />}
              onClick={() => download('subtitles.vtt', toVTT(cues), 'text/vtt')}
            >
              VTT
            </Button>
            <Button
              size="small"
              icon={<DownloadOutlined />}
              onClick={() => download('subtitles.srt', toSRT(cues), 'text/plain')}
            >
              SRT
            </Button>
          </>
        )}
        <ModelPicker slot="asr" field="asrModel" />
      </Space>

      {running && progress && (
        <div style={{ padding: '4px 0 12px', flexShrink: 0 }}>
          <Progress percent={pct} size="small" status="active" />
          <TextSwap text={progress.message} style={{ fontSize: 12, color: '#888' }} />
        </div>
      )}

      <PersistentError title="转写失败" text={errorText} onClose={() => setErrorText(null)} />

      <div ref={listRef} style={{ flex: 1, overflow: 'auto' }}>
        {segments.length === 0 && !running && (
          <div style={{ color: '#999', padding: 16, textAlign: 'center' }}>
            还没有字幕，点击「生成字幕」开始转写
          </div>
        )}
        {cues.map((c, i) => (
          <div
            key={c.start}
            className="sub-item"
            onClick={() => {
              if (playerRef.current) playerRef.current.currentTime = c.start + 0.01;
            }}
            style={{
              background: i === activeIdx ? '#e6f4ff' : undefined,
            }}
          >
            <span style={{ color: '#1677ff', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {fmtTime(c.start)}
            </span>
            <span style={{ fontWeight: i === activeIdx ? 600 : 400 }}>{c.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
