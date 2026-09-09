import { useCallback, useEffect, useState } from 'react';
import { App, Button, Progress, Space } from 'antd';
import { CommentOutlined } from '@ant-design/icons';
import type { MediaPlayerInstance } from '@vidstack/react';
import { db, type DanmakuRow } from '../store/db';
import { runDanmaku, type DanmakuProgress } from '../pipelines/danmaku';
import { fmtTime } from '../utils/vtt';
import { TextSwap } from './motion';
import ModelPicker from './ModelPicker';

interface Props {
  videoId: string;
  playerRef: React.RefObject<MediaPlayerInstance | null>;
  hasSubtitles: boolean;
}

export default function DanmakuPanel({ videoId, playerRef, hasSubtitles }: Props) {
  const { message } = App.useApp();
  const [items, setItems] = useState<DanmakuRow[]>([]);
  const [progress, setProgress] = useState<DanmakuProgress | null>(null);

  const reload = useCallback(async () => {
    const rows = await db.danmakus.where('videoId').equals(videoId).sortBy('time');
    setItems(rows);
  }, [videoId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const start = async () => {
    setProgress({ done: 0, total: 1, message: '准备中…' });
    try {
      const count = await runDanmaku(videoId, setProgress);
      message.success(count > 0 ? `弹幕生成完成，共 ${count} 条思考题` : '生成完成：这段课程没有挖出合适的思考题');
    } catch (e) {
      message.error(`弹幕生成失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProgress(null);
      await reload();
    }
  };

  const running = progress !== null;
  const pct = progress && progress.total > 1 ? Math.round((progress.done / progress.total) * 100) : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Space style={{ padding: '8px 0', flexShrink: 0 }} wrap>
        <Button
          type="primary"
          icon={<CommentOutlined />}
          loading={running}
          onClick={start}
          disabled={!hasSubtitles}
          title={hasSubtitles ? undefined : '请先在「字幕」页生成字幕'}
        >
          {items.length > 0 ? '重新生成弹幕' : '生成弹幕'}
        </Button>
        <ModelPicker slot="chat" field="llmModel" />
      </Space>

      {running && progress && (
        <div style={{ padding: '4px 0 12px', flexShrink: 0 }}>
          <Progress percent={pct} size="small" status="active" />
          <TextSwap text={progress.message} style={{ fontSize: 12, color: '#888' }} />
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {!hasSubtitles && !running && (
          <div style={{ color: '#999', padding: 16, textAlign: 'center' }}>
            弹幕基于字幕内容生成，请先在「字幕」页生成字幕
          </div>
        )}
        {hasSubtitles && items.length === 0 && !running && (
          <div style={{ color: '#999', padding: 16, textAlign: 'center' }}>
            点击「生成弹幕」，AI 将按课程内容设计思考题，播放到对应时间点时弹在画面顶部
          </div>
        )}
        {items.map((d) => (
          <div
            key={d.id}
            className="sub-item"
            onClick={() => {
              if (playerRef.current) playerRef.current.currentTime = d.time + 0.01;
            }}
          >
            <span style={{ color: '#1677ff', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {fmtTime(d.time)}
            </span>
            <span>{d.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
