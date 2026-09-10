import { useCallback, useEffect, useState } from 'react';
import { App, Button, Progress, Space, Typography } from 'antd';
import { DownloadOutlined, IdcardOutlined, UndoOutlined } from '@ant-design/icons';
import type { MediaPlayerInstance } from '@vidstack/react';
import { db, type CardRow } from '../store/db';
import { runCards, type CardsProgress } from '../pipelines/cards';
import { fmtTime } from '../utils/vtt';
import { TextSwap } from './motion';
import ModelPicker from './ModelPicker';
import SwipeDeck from './SwipeDeck';
import PersistentError from './PersistentError';
import { formatCaughtError } from '../utils/errorText';
import '../cards.css';

interface Props {
  videoId: string;
  videoName: string;
  playerRef: React.RefObject<MediaPlayerInstance | null>;
  hasSubtitles: boolean;
}

/** 导出文件名清洗（与 chatExport 同款思路：去扩展名、非法字符转 -、截断） */
function apkgFileName(videoName: string): string {
  const base = videoName
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[\\/:*?"<>|\n\r\t]+/g, '-')
    .trim();
  return `${base || 'cards'}.apkg`.slice(0, 80);
}

export default function CardsPanel({ videoId, videoName, playerRef, hasSubtitles }: Props) {
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState<CardRow[]>([]);
  /** 已判定卡片 id 栈（审核顺序），撤销用 */
  const [history, setHistory] = useState<number[]>([]);
  const [progress, setProgress] = useState<CardsProgress | null>(null);
  const [exporting, setExporting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const rs = await db.cards.where('videoId').equals(videoId).sortBy('time');
    setRows(rs);
    setHistory([]);
  }, [videoId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const seekTo = useCallback(
    (t: number) => {
      if (playerRef.current) playerRef.current.currentTime = t + 0.01;
    },
    [playerRef],
  );

  /** 判定：内存先行（动画不被 DB 往返阻塞），落库 fire-and-forget（QuizCard 同款） */
  const judge = useCallback((card: CardRow, keep: boolean) => {
    const status = keep ? 1 : 2;
    setRows((rs) => rs.map((r) => (r.id === card.id ? { ...r, status: status as 1 | 2 } : r)));
    setHistory((h) => [...h, card.id!]);
    void db.cards.update(card.id!, { status });
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      const last = h[h.length - 1];
      if (last == null) return h;
      setRows((rs) => rs.map((r) => (r.id === last ? { ...r, status: 0 as const } : r)));
      void db.cards.update(last, { status: 0 });
      return h.slice(0, -1);
    });
  }, []);

  const doGenerate = async () => {
    setErrorText(null);
    setProgress({ done: 0, total: 1, message: '准备中…' });
    try {
      const count = await runCards(videoId, setProgress);
      message.success(count > 0 ? `制卡完成，共 ${count} 张候选卡，滑动审核吧` : '生成完成：这段课程没有挖出合适的卡片');
    } catch (e) {
      const errText = formatCaughtError(e);
      setErrorText(errText);
      modal.error({
        title: '制卡失败',
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

  const start = () => {
    if (rows.length === 0) {
      void doGenerate();
      return;
    }
    // 重新生成会清空已有卡片与审核结果，需确认（弹幕无需审核故无此步）
    modal.confirm({
      title: '重新生成卡片',
      content: `将清空现有 ${rows.length} 张卡片及全部审核结果，确定继续？`,
      okText: '重新生成',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => doGenerate(),
    });
  };

  const exportApkg = async () => {
    const kept = rows.filter((r) => r.status === 1);
    if (kept.length === 0) return;
    setExporting(true);
    try {
      // sql.js（wasm ~1.2MB）懒加载：点击导出时才拉取
      const { buildApkg } = await import('../anki/apkg');
      const blob = await buildApkg(videoName, kept);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = apkgFileName(videoName);
      a.click();
      URL.revokeObjectURL(url);
      message.success(`已导出 ${kept.length} 张卡片，用 Anki 打开即可开始复习`);
    } catch (e) {
      message.error(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  const running = progress !== null;
  const pct = progress && progress.total > 1 ? Math.round((progress.done / progress.total) * 100) : undefined;
  const pending = rows.filter((r) => r.status === 0);
  const kept = rows.filter((r) => r.status === 1);
  const discarded = rows.length - pending.length - kept.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Space style={{ padding: '8px 0', flexShrink: 0 }} wrap>
        <Button
          type="primary"
          icon={<IdcardOutlined />}
          loading={running}
          onClick={start}
          disabled={!hasSubtitles}
          title={hasSubtitles ? undefined : '请先在「字幕」页生成字幕'}
        >
          {rows.length > 0 ? '重新生成卡片' : '生成卡片'}
        </Button>
        <Button
          size="small"
          icon={<DownloadOutlined />}
          disabled={kept.length === 0 || running}
          loading={exporting}
          onClick={exportApkg}
          title={kept.length > 0 ? '导出保留的卡片（Anki 全平台可导入）' : '先右滑保留一些卡片'}
        >
          导出 .apkg{kept.length > 0 ? `（${kept.length}）` : ''}
        </Button>
        <ModelPicker slot="chat" field="llmModel" />
      </Space>

      {running && progress && (
        <div style={{ padding: '4px 0 12px', flexShrink: 0 }}>
          <Progress percent={pct} size="small" status="active" />
          <TextSwap text={progress.message} style={{ fontSize: 12, color: '#888' }} />
        </div>
      )}

      <PersistentError title="制卡失败" text={errorText} onClose={() => setErrorText(null)} />

      {!hasSubtitles && rows.length === 0 && !running && (
        <div style={{ color: '#999', padding: 16, textAlign: 'center' }}>
          卡片基于字幕内容生成，请先在「字幕」页生成字幕
        </div>
      )}
      {hasSubtitles && rows.length === 0 && !running && (
        <div style={{ color: '#999', padding: 16, textAlign: 'center' }}>
          点击「生成卡片」，AI 将从字幕提炼知识点做成问答卡；右滑保留、左滑丢弃，保留的可导出到 Anki 复习
        </div>
      )}

      {pending.length > 0 && !running && (
        <SwipeDeck
          pending={pending}
          keptCount={kept.length}
          judgedCount={kept.length + discarded}
          onJudge={judge}
          onUndo={undo}
          canUndo={history.length > 0}
          onSeek={seekTo}
        />
      )}

      {pending.length === 0 && rows.length > 0 && !running && (
        <div style={{ flexShrink: 0, padding: '4px 0 8px', fontSize: 13, color: '#666' }}>
          审核完成：保留 {kept.length} · 丢弃 {discarded}
          {kept.length > 0 ? '，点「导出 .apkg」导入 Anki' : ''}
          {/* 最后一张滑错也要能反悔：审完状态撤销入口放在汇总行 */}
          <Button
            size="small"
            type="text"
            icon={<UndoOutlined />}
            disabled={history.length === 0}
            onClick={undo}
            title="撤销上一张"
            style={{ marginLeft: 8 }}
          />
        </div>
      )}

      {kept.length > 0 && (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <div style={{ fontSize: 12, color: '#999', padding: '2px 0 6px' }}>已保留（点时间戳回看视频）</div>
          {kept.map((c) => (
            <div key={c.id} className="sub-item" onClick={() => seekTo(c.time)}>
              <span style={{ color: '#1677ff', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                {fmtTime(c.time)}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>{c.q}</span>
              <Button
                size="small"
                type="text"
                danger
                style={{ flexShrink: 0 }}
                onClick={(e) => {
                  e.stopPropagation();
                  judge(c, false);
                }}
              >
                移除
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
