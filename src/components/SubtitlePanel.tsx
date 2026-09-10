import { useEffect, useMemo, useRef, useState } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import { liveQuery } from 'dexie';
import { db, type SegmentRow } from '../store/db';
import { runTranscription, type TranscribeProgress } from '../pipelines/transcribe';
import { fmtTime, toSRT, toVTT, type Cue } from '../utils/vtt';
import { splitIntoCues, cueKey } from '../utils/cues';
import { formatCaughtError } from '../utils/errorText';
import { TextSwap } from './motion';
import ModelPicker from './ModelPicker';
import PersistentError from './PersistentError';
import { Panel, PanelBar, PanelBody, PanelProgress, PanelPlaceholder, CueRow, toast, alertDialog } from '../ui';
import './subtitle-danmaku.css';

interface Props {
  videoId: string;
  playerRef: React.RefObject<MediaPlayerInstance | null>;
  currentTime: number;
  onSegmentsChange: (cues: Cue[]) => void;
  /** 转写是否进行中：上游据此门控讲义/弹幕/卡片（避免拿半份字幕去生成） */
  onRunningChange?: (running: boolean) => void;
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

export default function SubtitlePanel({ videoId, playerRef, currentTime, onSegmentsChange, onRunningChange }: Props) {
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [progress, setProgress] = useState<TranscribeProgress | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 转写进行中：每完成一段上游都会写库，这里用 liveQuery 增量跟进，不再等到最后 reload
  useEffect(() => {
    const sub = liveQuery(async () =>
      (await db.segments.where('videoId').equals(videoId).sortBy('idx')).filter((r) => r.status === 1 && !!r.text),
    ).subscribe({
      next: setSegments,
      error: (e) => setErrorText(formatCaughtError(e)),
    });
    return () => sub.unsubscribe();
  }, [videoId]);

  // 展开为展示用 cue：优先 ASR 句级时间戳（超长的再按字数细分），无则按标点+字数估算。
  // 按段缓存结果——转写中每落一段都会重建 segments 数组，没有缓存会对全部段重跑一遍切分。
  const cacheRef = useRef(new Map<number, { sig: string; cues: Cue[] }>());
  const cues = useMemo(() => {
    const cache = cacheRef.current;
    if (cache.size > 4000) cache.clear(); // 反复重新生成时防止无界增长
    return segments.flatMap((s, si) => {
      const key = s.id ?? si;
      const sig = `${s.start}|${s.end}|${s.text.length}|${s.cues?.length ?? 0}`;
      let split = cache.get(key);
      if (split?.sig !== sig) {
        split = {
          sig,
          cues: s.cues?.length
            ? s.cues.flatMap((c) => splitIntoCues(c.start, c.end, c.text))
            : splitIntoCues(s.start, s.end, s.text),
        };
        cache.set(key, split);
      }
      // id 供播放器字幕轨按 id 幂等灌 cue（见 Player 的 cue 同步）；内容寻址，重新转写后自然换新 id
      return split.cues.map((c, i) => ({ ...c, id: `${s.idx}:${i}:${cueKey(c.start, c.end, c.text)}` }));
    });
  }, [segments]);

  useEffect(() => {
    onSegmentsChange(cues);
  }, [cues, onSegmentsChange]);

  const running = progress !== null;
  useEffect(() => {
    onRunningChange?.(running);
  }, [running, onRunningChange]);

  const start = async () => {
    setErrorText(null);
    setProgress({ phase: 'extract', done: 0, total: 1, message: '准备中…' });
    try {
      await runTranscription(videoId, setProgress);
      toast.success('字幕生成完成');
    } catch (e) {
      const errText = formatCaughtError(e);
      setErrorText(errText);
      // 弹窗只给「知道了」+ 一键复制原文；完整报错文本会被折叠空白（主 agent 已确认取舍）
      void alertDialog({ headline: '转写失败', description: errText, copyText: errText });
    } finally {
      // 已完成段由 liveQuery 自动跟进，这里无需再 reload
      setProgress(null);
    }
  };

  const activeIdx = cues.findIndex((c) => currentTime >= c.start && currentTime < c.end);

  // 自动滚动到当前字幕
  useEffect(() => {
    if (activeIdx < 0 || !listRef.current) return;
    const el = listRef.current.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIdx]);

  const pct =
    progress?.phase === 'asr'
      ? Math.round((progress.done / Math.max(1, progress.total)) * 100)
      : progress?.phase === 'extract'
        ? Math.round(progress.done * 100)
        : undefined;

  return (
    <Panel testId="panel-subs">
      <PanelBar>
        <mdui-button variant="filled" loading={running} onClick={start} data-testid="subs-generate">
          <mdui-sym-graphic-eq slot="icon" />
          {running ? '转写中…' : segments.length > 0 ? '重新生成字幕' : '生成字幕'}
        </mdui-button>
        {segments.length > 0 && (
          <>
            <mdui-button variant="outlined" data-testid="subs-download-vtt" onClick={() => download('subtitles.vtt', toVTT(cues), 'text/vtt')}>
              <mdui-sym-download slot="icon" />
              VTT
            </mdui-button>
            <mdui-button variant="outlined" data-testid="subs-download-srt" onClick={() => download('subtitles.srt', toSRT(cues), 'text/plain')}>
              <mdui-sym-download slot="icon" />
              SRT
            </mdui-button>
          </>
        )}
        <ModelPicker slot="asr" field="asrModel" />
      </PanelBar>

      {running && progress && (
        <PanelProgress
          testId="subs-progress"
          percent={pct}
          text={
            <TextSwap
              text={`${progress.message}${progress.phase === 'asr' && cues.length > 0 ? ` · 已可看 ${cues.length} 条` : ''}`}
            />
          }
        />
      )}

      <PersistentError title="转写失败" text={errorText} onClose={() => setErrorText(null)} />

      <PanelBody bodyRef={listRef} testId="subs-list">
        {segments.length === 0 && !running && (
          <PanelPlaceholder testId="subs-empty">还没有字幕，点击「生成字幕」开始转写</PanelPlaceholder>
        )}
        {cues.map((c, i) => (
          <CueRow
            key={c.start}
            time={fmtTime(c.start)}
            active={i === activeIdx}
            testId="subs-row"
            onClick={() => {
              if (playerRef.current) playerRef.current.currentTime = c.start + 0.01;
            }}
          >
            {c.text}
          </CueRow>
        ))}
      </PanelBody>
    </Panel>
  );
}
