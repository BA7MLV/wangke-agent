import { useCallback, useEffect, useState } from 'react';
import { Button, Tooltip } from '@heroui/react';
import type { MediaPlayerInstance } from '@vidstack/react';
import { db, type CardRow } from '../store/db';
import { runCards, type CardsProgress } from '../pipelines/cards';
import { fmtTime } from '../utils/vtt';
import { TextSwap } from './motion';
import ModelPicker from './ModelPicker';
import SwipeDeck from './SwipeDeck';
import PersistentError from './PersistentError';
import { formatCaughtError } from '../utils/errorText';
import {
  LoadingButton,
  Panel,
  PanelBar,
  PanelProgress,
  PanelPlaceholder,
  PanelBody,
  CueSkeleton,
  SkeletonReveal,
  useSkeletonGate,
  Sym,
  toast,
  confirmDialog,
  alertDialog,
} from '../ui';
import '../cards.css';

interface Props {
  videoId: string;
  videoName: string;
  playerRef: React.RefObject<MediaPlayerInstance | null>;
  /** `null` = 字幕状态还没读到：未知时不出「请先生成字幕」 */
  hasSubtitles: boolean | null;
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
  const [rows, setRows] = useState<CardRow[]>([]);
  /** 首次读回之前为 false —— 空态只在 `loaded && 真的为空` 时出现（不变量 I1） */
  const [loaded, setLoaded] = useState(false);
  /** 已判定卡片 id 栈（审核顺序），撤销用 */
  const [history, setHistory] = useState<number[]>([]);
  const [progress, setProgress] = useState<CardsProgress | null>(null);
  const [exporting, setExporting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const rs = await db.cards.where('videoId').equals(videoId).sortBy('time');
      setRows(rs);
      setHistory([]);
    } catch (e) {
      // 读失败按「确实为空」收尾，别把界面永远留在骨架/空白上（不变量 I5）
      setErrorText(formatCaughtError(e));
    } finally {
      setLoaded(true);
    }
  }, [videoId]);

  useEffect(() => {
    // 切视频先回到「未知」态，避免拿上一门课的卡片当本课的空/满判据
    setLoaded(false);
    void reload();
  }, [reload]);

  const showSkeleton = useSkeletonGate(!loaded);

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
      toast.success(count > 0 ? `制卡完成，共 ${count} 张候选卡，滑动审核吧` : '生成完成：这段课程没有挖出合适的卡片');
    } catch (e) {
      const errText = formatCaughtError(e);
      setErrorText(errText);
      // 原 antd Modal.error 带可复制的错误详情；mdui 用 alertDialog + copyText 复制
      await alertDialog({
        headline: '制卡失败',
        description: errText,
        copyText: errText,
        confirmText: '知道了',
      });
    } finally {
      setProgress(null);
      await reload();
    }
  };

  const start = async () => {
    if (rows.length === 0) {
      void doGenerate();
      return;
    }
    // 重新生成会清空已有卡片与审核结果，需确认（弹幕无需审核故无此步）
    const ok = await confirmDialog({
      headline: '重新生成卡片',
      description: `将清空现有 ${rows.length} 张卡片及全部审核结果，确定继续？`,
      confirmText: '重新生成',
      cancelText: '取消',
      danger: true,
    });
    if (ok) void doGenerate();
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
      toast.success(`已导出 ${kept.length} 张卡片，用 Anki 打开即可开始复习`);
    } catch (e) {
      toast.error(`导出失败：${e instanceof Error ? e.message : String(e)}`);
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
    <Panel testId="panel-cards">
      <PanelBar>
        <Tooltip>
          <Tooltip.Trigger>
            <LoadingButton
              loading={running}
              variant="primary"
              data-testid="cards-generate"
              isDisabled={hasSubtitles !== true}
              onPress={start}
            >
              <Sym name="style" />
              {rows.length > 0 ? '重新生成卡片' : '生成卡片'}
            </LoadingButton>
          </Tooltip.Trigger>
          <Tooltip.Content>
            <p>{hasSubtitles ? '从字幕提炼知识点做成问答卡' : '请先在「字幕」页生成字幕'}</p>
          </Tooltip.Content>
        </Tooltip>
        <Tooltip>
          <Tooltip.Trigger>
            <LoadingButton
              loading={exporting}
              data-testid="cards-export"
              isDisabled={kept.length === 0 || running}
              onPress={exportApkg}
            >
              <Sym name="download" />
              导出 .apkg{kept.length > 0 ? `（${kept.length}）` : ''}
            </LoadingButton>
          </Tooltip.Trigger>
          <Tooltip.Content>
            <p>{kept.length > 0 ? '导出保留的卡片（Anki 全平台可导入）' : '先右滑保留一些卡片'}</p>
          </Tooltip.Content>
        </Tooltip>
        <ModelPicker slot="chat" field="llmModel" />
      </PanelBar>

      {running && progress && (
        <PanelProgress testId="cards-progress" percent={pct} text={<TextSwap text={progress.message} />} />
      )}

      <PersistentError title="制卡失败" text={errorText} onClose={() => setErrorText(null)} />

      {/* 卡片面板的四块（占位 / 滑动卡 / 汇总 / 已保留列表）同处一栏，所以骨架把**整栏**包起来：
          只包占位的话，骨架在上、滑动卡在下，数据一到骨架收走会把下面的卡片整块顶上去 ——
          正是 §四 说的「加载完再抖一下」。
          `.panel-reveal` 负责把 SkeletonReveal 接回面板的高度链（否则里面
          `.panel-body` 的 `flex: 1` 失效、已保留列表滚不动），见 cards.css。 */}
      <SkeletonReveal className="panel-reveal" show={showSkeleton} skeleton={<CueSkeleton rows={8} />}>
        {hasSubtitles === false && loaded && rows.length === 0 && !running && (
          <PanelPlaceholder>卡片基于字幕内容生成，请先在「字幕」页生成字幕</PanelPlaceholder>
        )}
        {hasSubtitles === true && loaded && rows.length === 0 && !running && (
          <PanelPlaceholder testId="cards-empty">
            点击「生成卡片」，AI 将从字幕提炼知识点做成问答卡；右滑保留、左滑丢弃，保留的可导出到 Anki 复习
          </PanelPlaceholder>
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
          <div className="cards-summary">
            <span className="text-secondary">
              审核完成：保留 {kept.length} · 丢弃 {discarded}
              {kept.length > 0 ? '，点「导出 .apkg」导入 Anki' : ''}
            </span>
            {/* 最后一张滑错也要能反悔：审完状态撤销入口放在汇总行 */}
            <Button
              isIconOnly
              variant="tertiary"
              size="sm"
              data-testid="cards-undo"
              aria-label="撤销上一张"
              isDisabled={history.length === 0}
              onPress={undo}
            >
              <Sym name="undo" />
            </Button>
          </div>
        )}

        {kept.length > 0 && (
          <PanelBody testId="cards-list-body">
            <div className="cards-list" data-testid="cards-list">
              <div className="text-secondary cards-list__caption">已保留（点时间戳回看视频）</div>
              {kept.map((c) => (
                <div key={c.id} className="sub-item cards-row" data-testid="cards-row" onClick={() => seekTo(c.time)}>
                  <button
                    type="button"
                    className="sub-item__time cards-row__seek"
                    aria-label={`跳到视频 ${fmtTime(c.time)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      seekTo(c.time);
                    }}
                  >
                    {fmtTime(c.time)}
                  </button>
                  <span className="sub-item__text" style={{ flex: '1 1 auto' }}>
                    {c.q}
                  </span>
                  {/* 不需要再手写 stopPropagation：HeroUI 的 onPress 默认就阻止冒泡
                      （想放行才调 continuePropagation()），所以点「移除」不会连带触发整行的跳转。 */}
                  <Button
                    isIconOnly
                    variant="tertiary"
                    size="sm"
                    aria-label="移除"
                    onPress={() => judge(c, false)}
                  >
                    <Sym name="close" />
                  </Button>
                </div>
              ))}
            </div>
          </PanelBody>
        )}
      </SkeletonReveal>
    </Panel>
  );
}
