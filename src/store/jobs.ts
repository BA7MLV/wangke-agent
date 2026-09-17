import { create } from 'zustand';

/**
 * 转写任务的运行时状态（内存态，不持久化）。
 *
 * 存在的理由只有一个：**任务不该跟着组件一起消失**。
 * 之前进度是 `SubtitlePanel` 的 `useState`，切走视频/回资料库就丢了，
 * 回来再点一次还会起第二份并发转写。现在任何入口（面板、资料库、启动续跑）
 * 都读同一份 job，切到哪儿进度都还在。
 *
 * v9 起这里也承载**阅读材料的解析/建索引**（`parse` / `index` 两个 phase）：
 * 三百页 PDF 的解析要几十秒，用户在库页点了导入就走开是常态，
 * 复用同一个「任务不跟组件走」的机制最省事，也自然获得列表行的进度展示。
 */

export type JobPhase =
  | 'queued'
  | 'extract'
  | 'vad'
  | 'asr'
  /** 阅读材料：抽文本单元 → 落 materialBlocks */
  | 'parse'
  /** 阅读材料：文本块向量化 */
  | 'index'
  | 'done'
  | 'error'
  | 'canceled';

export interface TranscribeJob {
  videoId: string;
  phase: JobPhase;
  message: string;
  done: number;
  total: number;
  error?: string;
  /** 由启动时的续跑扫描发起（用于文案区分：是「继续转写」不是「重新转写」） */
  resume: boolean;
}

const ACTIVE_PHASES: JobPhase[] = ['queued', 'extract', 'vad', 'asr', 'parse', 'index'];

export function isJobActive(job: TranscribeJob | undefined): boolean {
  return !!job && ACTIVE_PHASES.includes(job.phase);
}

/** 材料解析/建索引任务（与视频转写共用一份 job 状态，但文案与入口不同） */
export function isMaterialJob(job: TranscribeJob | undefined): boolean {
  return !!job && (job.phase === 'parse' || job.phase === 'index');
}

/** 资料库行：进度条旁写细节，状态标签只写「转写中」，避免同一句出现两次 */
export function libraryJobCopy(job: TranscribeJob): { detail: string; tag: string } {
  if (job.phase === 'parse') return { detail: job.message || '解析中', tag: '解析中' };
  if (job.phase === 'index') return { detail: job.message || '建立索引中', tag: '建索引' };
  const detail =
    job.phase === 'asr'
      ? `转写中 ${job.done}/${job.total}`
      : job.phase === 'queued'
        ? '转写排队中'
        : job.message || '转写中';
  return { detail, tag: '转写中' };
}

interface JobStore {
  jobs: Record<string, TranscribeJob>;
  /** 等待中的 videoId（同一时刻只跑一个转写，避免和正在播放的视频抢 CPU） */
  queue: string[];
  activeId: string | null;
  upsert: (videoId: string, patch: Partial<TranscribeJob> & { videoId?: string }) => void;
  enqueue: (videoId: string) => void;
  drop: (videoId: string) => void;
  setActive: (videoId: string | null) => void;
}

export const useJobStore = create<JobStore>()((set) => ({
  jobs: {},
  queue: [],
  activeId: null,

  upsert: (videoId, patch) =>
    set((s) => {
      const prev = s.jobs[videoId];
      const base: TranscribeJob = prev ?? {
        videoId,
        phase: 'queued',
        message: '',
        done: 0,
        total: 0,
        resume: false,
      };
      const next: TranscribeJob = { ...base, ...patch, videoId };
      return { jobs: { ...s.jobs, [videoId]: next } };
    }),

  enqueue: (videoId) =>
    set((s) => (s.queue.includes(videoId) ? s : { queue: [...s.queue, videoId] })),

  drop: (videoId) =>
    set((s) => {
      const jobs = { ...s.jobs };
      delete jobs[videoId];
      return { jobs, queue: s.queue.filter((id) => id !== videoId) };
    }),

  setActive: (videoId) => set({ activeId: videoId }),
}));

/** 面板/列表订阅单个视频的任务（没任务时是 undefined） */
export function useTranscribeJob(videoId: string | undefined): TranscribeJob | undefined {
  return useJobStore((s) => (videoId ? s.jobs[videoId] : undefined));
}
