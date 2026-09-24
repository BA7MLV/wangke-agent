import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import { db, type CommentRow } from '../store/db';
import { runComments, type CommentsProgress } from '../pipelines/comments';
import {
  COMMENT_ROLE_LABEL,
  COMMENT_SORT_LABEL,
  countComments,
  groupThreads,
  orderThreads,
  type CommentRole,
  type CommentRowLike,
  type CommentSort,
} from '../harness/comments';
import { fmtTime } from '../utils/vtt';
import { formatCaughtError } from '../utils/errorText';
import { PanelProgress, alertDialog, toast } from '../ui';
import { TextSwap } from './motion';
import ModelPicker from './ModelPicker';
import PersistentError from './PersistentError';
import './comments.css';

/** 落库后的行：`id` 由 Dexie 自增生成，取出来一定有值（这里只是把类型收窄给 groupThreads） */
type Row = CommentRow & { id: number };

interface Props {
  videoId: string;
  playerRef: React.RefObject<MediaPlayerInstance | null>;
  hasSubtitles: boolean;
  /**
   * 展开状态上报给播放页。
   *
   * 不是为了「受控组件」—— 是为了让 `.video-pane` 能加上 `--comments-open`：
   * 展开时播放器要让出高度，而这条只能由 pane 上的类来驱动（CSS 选不到前面的兄弟节点，
   * 也读不到后代里的状态）。
   */
  onOpenChange?: (open: boolean) => void;
}

/**
 * 评论区（视频下方的横向区块）。
 *
 * 与「弹幕」面板的分工见 docs/plans/2026-09-22-comments-design.md §1：
 * 弹幕是一句话飘过、无回复；这里是围绕某个时间点的多轮讨论。
 * 内容全部由 AI 生成（只读，不做点赞，见非目标）。
 */
export default function CommentsSection({ videoId, playerRef, hasSubtitles, onOpenChange }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<CommentSort>('hot');
  const [progress, setProgress] = useState<CommentsProgress | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const rs = await db.comments.where('videoId').equals(videoId).sortBy('time');
    setRows(rs.filter((r): r is Row => r.id != null));
  }, [videoId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const threads = useMemo(() => groupThreads(rows), [rows]);
  const ordered = useMemo(() => orderThreads(threads, sort), [threads, sort]);
  const stats = useMemo(() => countComments(rows), [rows]);

  /** 点时间戳跳播放器：与字幕/弹幕/卡片同一个约定（+0.01 避开边界那一帧） */
  const seek = useCallback(
    (t: number) => {
      if (playerRef.current) playerRef.current.currentTime = t + 0.01;
    },
    [playerRef],
  );

  const toggle = () => {
    setOpen((v) => {
      onOpenChange?.(!v);
      return !v;
    });
  };

  const start = async () => {
    setErrorText(null);
    setProgress({ done: 0, total: 1, message: '准备中…' });
    try {
      const { threads: n, posts } = await runComments(videoId, setProgress);
      // 生成完直接展开：点了按钮却什么也看不到，是这批面板里最容易踩的体验坑
      setOpen(true);
      onOpenChange?.(true);
      toast.success(
        n > 0 ? `讨论生成完成：${n} 串、${posts} 条发言` : '生成完成：这段课程没有挖出值得讨论的点',
      );
    } catch (e) {
      const errText = formatCaughtError(e);
      setErrorText(errText);
      void alertDialog({ headline: '讨论生成失败', description: errText, copyText: errText });
    } finally {
      setProgress(null);
      await reload();
    }
  };

  const running = progress !== null;
  const pct =
    progress && progress.total > 1 ? Math.round((progress.done / progress.total) * 100) : undefined;

  return (
    <section
      className={open ? 'comments-block comments-block--open' : 'comments-block'}
      data-testid="comments"
    >
      <button
        type="button"
        className="comments-toggle"
        data-testid="comments-toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        <mdui-sym-forum />
        <span className="comments-toggle__label">讨论区</span>
        <span className="comments-toggle__meta" data-testid="comments-count">
          {stats.threads > 0
            ? `${stats.threads} 条讨论 · ${stats.posts} 条发言`
            : hasSubtitles
              ? '还没有讨论'
              : '需先生成字幕'}
        </span>
        <mdui-sym-keyboard-arrow-down className="comments-toggle__chev" />
      </button>

      {open && (
        <div className="comments-panel">
          <div className="comments-bar">
            <mdui-button
              variant="filled"
              loading={running}
              disabled={!hasSubtitles}
              onClick={start}
              data-testid="comments-generate"
              title={hasSubtitles ? undefined : '请先在「字幕」页生成字幕'}
            >
              <mdui-sym-forum slot="icon" />
              {stats.threads > 0 ? '重新生成讨论' : '生成讨论'}
            </mdui-button>

            {stats.threads > 0 && (
              <div className="comments-sort">
                {(Object.keys(COMMENT_SORT_LABEL) as CommentSort[]).map((k) => (
                  <mdui-button
                    key={k}
                    variant={sort === k ? 'tonal' : 'text'}
                    onClick={() => setSort(k)}
                    data-testid={`comments-sort-${k}`}
                  >
                    {COMMENT_SORT_LABEL[k]}
                  </mdui-button>
                ))}
              </div>
            )}

            <div className="comments-bar__spacer" />
            <ModelPicker slot="chat" field="llmModel" />
          </div>

          {running && progress && (
            <PanelProgress testId="comments-progress" percent={pct} text={<TextSwap text={progress.message} />} />
          )}

          <PersistentError title="讨论生成失败" text={errorText} onClose={() => setErrorText(null)} />

          <div className="comments-body" data-testid="comments-list">
            {stats.threads === 0 && !running && (
              <div className="comments-placeholder" data-testid="comments-empty">
                {hasSubtitles
                  ? '点击「生成讨论」，AI 会按课程内容生成若干讨论串 —— 每串围绕一个容易栽跟头的地方，点时间戳可跳回视频'
                  : '讨论基于字幕内容生成，请先在「字幕」页生成字幕'}
              </div>
            )}

            {ordered.map((t) => (
              <div className="cmt-thread" data-testid="cmt-thread" key={t.id}>
                <CommentItem row={t} onSeek={seek} />
                {t.replies.length > 0 && (
                  <div className="cmt-replies">
                    {t.replies.map((r) => (
                      <CommentItem key={r.id} row={r} onSeek={seek} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function CommentItem({ row, onSeek }: { row: CommentRowLike; onSeek: (t: number) => void }) {
  return (
    <div className="cmt-item" data-testid="cmt-item">
      <div className="cmt-avatar" aria-hidden="true">
        {row.author.slice(0, 1)}
      </div>
      <div className="cmt-main">
        <div className="cmt-head">
          <span className="cmt-author">{row.author}</span>
          <RoleChip role={row.role} />
          <button
            type="button"
            className="cmt-time"
            data-testid="cmt-time"
            title="跳到视频对应位置"
            onClick={() => onSeek(row.time)}
          >
            {fmtTime(row.time)}
          </button>
        </div>
        <div className="cmt-text">{row.text}</div>
      </div>
    </div>
  );
}

function RoleChip({ role }: { role: CommentRole }) {
  return <span className={`cmt-role cmt-role--${role}`}>{COMMENT_ROLE_LABEL[role]}</span>;
}
