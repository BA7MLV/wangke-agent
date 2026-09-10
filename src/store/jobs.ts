import { create } from 'zustand';

/**
 * 转写任务的运行时状态（内存态，不持久化）。
 *
 * 存在的理由只有一个：**任务不该跟着组件一起消失**。
 * 之前进度是 `SubtitlePanel` 的 `useState`，切走视频/回资料库就丢了，
 * 回来再点一次还会起第二份并发转写。现在任何入口（面板、资料库、启动续跑）
 * 都读同一份 job，切到哪儿进度都还在。
 */

export type JobPhase = 'queued' | 'extract' | 'vad' | 'asr' | 'done' | 'error' | 'canceled';

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

const ACTIVE_PHASES: JobPhase[] = ['queued', 'extract', 'vad', 'asr'];

export function isJobActive(job: TranscribeJob | undefined): boolean {
  return !!job && ACTIVE_PHASES.includes(job.phase);
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
