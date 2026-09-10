import { useEffect, useMemo, useRef, useState } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import { liveQuery } from 'dexie';
import { db, type SegmentRow } from '../store/db';
import { isJobActive, useJobStore, useTranscribeJob } from '../store/jobs';
import { cancelTranscription, startTranscription } from '../pipelines/transcribeQueue';
import { formatCaughtError } from '../utils/errorText';
import { fmtTime, toSRT, toVTT, type Cue } from '../utils/vtt';
import { splitIntoCues, cueKey } from '../utils/cues';
import { TextSwap } from './motion';
import ModelPicker from './ModelPicker';
import PersistentError from './PersistentError';
import { Panel, PanelBar, PanelBody, PanelProgress, PanelPlaceholder, CueRow } from '../ui';
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 转写任务在全局队列里跑（可能是在别的视频上启动的、也可能是刷新后续跑的），
  // 这里只订阅自己这个视频的那一份：切走再回来进度还在，重复点也不会起第二份。
  const job = useTranscribeJob(videoId);
  const running = isJobActive(job);

  // 转写进行中：每完成一段上游都会写库，这里用 liveQuery 增量跟进，不再等到最后 reload
  useEffect(() => {
    const sub = liveQuery(async () =>
      (await db.segments.where('videoId').equals(videoId).sortBy('idx')).filter((r) => r.status === 1 && !!r.text),
    ).subscribe({
      next: setSegments,
      error: (e) => setLoadError(formatCaughtError(e)),
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

  useEffect(() => {
    onRunningChange?.(running);
  }, [running, onRunningChange]);

  const start = () => startTranscription(videoId);

  const activeIdx = cues.findIndex((c) => currentTime >= c.start && currentTime < c.end);

  // 自动滚动到当前字幕
  useEffect(() => {
    if (activeIdx < 0 || !listRef.current) return;
    const el = listRef.current.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIdx]);

  const pct =
    job?.phase === 'asr'
      ? Math.round((job.done / Math.max(1, job.total)) * 100)
      : job?.phase === 'extract'
        ? Math.round(job.done * 100)
        : undefined; // 排队 / VAD：没有确定比例，走不确定态

  const errorText = job?.phase === 'error' ? (job.error ?? job.message) : loadError;

  return (
    <Panel testId="panel-subs">
      <PanelBar>
        <mdui-button variant="filled" loading={running} onClick={start} data-testid="subs-generate">
          <mdui-sym-graphic-eq slot="icon" />
          {running ? '转写中…' : segments.length > 0 ? '重新生成字幕' : '生成字幕'}
        </mdui-button>
        {running && (
          <mdui-button variant="outlined" data-testid="subs-cancel" onClick={() => cancelTranscription(videoId)}>
            <mdui-sym-close slot="icon" />
            取消
          </mdui-button>
        )}
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

      {running && job && (
        <PanelProgress
          testId="subs-progress"
          percent={pct}
          text={
            <TextSwap
              text={`${job.message}${job.phase === 'asr' && cues.length > 0 ? ` · 已可看 ${cues.length} 条` : ''}`}
            />
          }
        />
      )}

      <PersistentError
        title="转写失败"
        text={errorText}
        onClose={() => {
          setLoadError(null);
          // 转写失败的报错存在 job 里（切页面也要能看到），关掉就得把 job 一起清掉
          if (job?.phase === 'error') useJobStore.getState().drop(videoId);
        }}
      />

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
