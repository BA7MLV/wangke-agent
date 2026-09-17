import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import { liveQuery } from 'dexie';
import { db, type SegmentRow, type SubtitleTrackRow } from '../store/db';
import { isJobActive, useJobStore, useTranscribeJob } from '../store/jobs';
import { cancelTranscription, startTranscription } from '../pipelines/transcribeQueue';
import { formatCaughtError } from '../utils/errorText';
import { fmtTime, toSRT, toVTT, type Cue } from '../utils/vtt';
import { splitIntoCues, cueKey } from '../utils/cues';
import { mergeBilingual, splitCueLines } from '../utils/bilingual';
import { TextSwap } from './motion';
import ModelPicker from './ModelPicker';
import PersistentError from './PersistentError';
import { Panel, PanelBar, PanelBody, PanelProgress, PanelPlaceholder, CueRow, useMduiEvent } from '../ui';
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
  /** B 站自带的多语言字幕（只喂显示）；空 = 这个视频没有对照字幕可选 */
  const [tracks, setTracks] = useState<SubtitleTrackRow[]>([]);
  /** 选中的「对照语言」lan；空串 = 不显示对照 */
  const [compareLang, setCompareLang] = useState('');

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

  // 对照字幕轨（B 站多语言）：切视频要重新订阅并把选择清零，避免拿上个视频的语言去配
  useEffect(() => {
    setCompareLang('');
    const sub = liveQuery(async () =>
      (await db.subtitleTracks.where('videoId').equals(videoId).toArray()).sort((a, b) =>
        a.lang.localeCompare(b.lang),
      ),
    ).subscribe({
      next: setTracks,
      error: (e) => setLoadError(formatCaughtError(e)),
    });
    return () => sub.unsubscribe();
  }, [videoId]);

  const compareSelectRef = useMduiEvent('mdui-select', 'change', (_e, el) => {
    const v = Array.isArray(el.value) ? (el.value[0] ?? '') : (el.value ?? '');
    setCompareLang(v);
  });

  // 展开为展示用 cue：优先 ASR 句级时间戳（超长的再按字数细分），无则按标点+字数估算。
  // 按段缓存结果——转写中每落一段都会重建 segments 数组，没有缓存会对全部段重跑一遍切分。
  const cacheRef = useRef(new Map<number, { sig: string; cues: Cue[] }>());
  const baseCues = useMemo(() => {
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
      return split.cues;
    });
  }, [segments]);

  /** 对照语言的展示 cue（同样按字数细分成多条） */
  const compareCues = useMemo(() => {
    const track = tracks.find((t) => t.lang === compareLang);
    if (!track) return [];
    return track.cues.flatMap((c) => splitIntoCues(c.start, c.end, c.text));
  }, [tracks, compareLang]);

  // 双语合成放在最后一步：先合并文本，再按「最终文本」算 id —— 播放器字幕轨按 id 幂等灌 cue，
  // 切换对照语言后文本变了，id 也就变了，旧 cue 会被推离时间轴（见 Player 的 syncTrack）。
  const cues = useMemo(() => {
    const merged = compareCues.length > 0 ? mergeBilingual(baseCues, compareCues) : baseCues;
    return merged.map((c, i) => ({ ...c, id: `${i}:${cueKey(c.start, c.end, c.text)}` }));
  }, [baseCues, compareCues]);

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
        {tracks.length > 0 && (
          <mdui-select
            ref={compareSelectRef}
            value={compareLang}
            data-testid="subs-compare"
            title="叠加一路对照字幕（B 站自带，同屏两行）"
          >
            <mdui-menu-item value="">无对照</mdui-menu-item>
            {tracks.map((t) => (
              <mdui-menu-item key={t.lang} value={t.lang}>
                {t.lanDoc || t.lang}
                {t.primary ? '（主）' : ''}
              </mdui-menu-item>
            ))}
          </mdui-select>
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
            // 划词提问契约：在字幕行里选中文字后，全局浮层据此知道「选的是哪一句」
            ask={{ source: 'subtitle', time: c.start, label: fmtTime(c.start) }}
            onClick={() => {
              if (playerRef.current) playerRef.current.currentTime = c.start + 0.01;
            }}
          >
            {splitCueLines(c.text).map((line, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {line}
              </Fragment>
            ))}
          </CueRow>
        ))}
      </PanelBody>
    </Panel>
  );
}
