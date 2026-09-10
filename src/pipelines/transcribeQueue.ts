/**
 * 转写任务队列：全局唯一入口，负责「谁在跑、谁排队、能不能取消、刷新后怎么续」。
 *
 * 三件事：
 * 1. **幂等吸附**——同一个视频重复触发（面板点第二次、启动续跑又来一遍）不会起第二份；
 * 2. **串行**——同一时刻只转一个视频，避免抽音频/VAD 与正在播放的视频抢 CPU；
 * 3. **续跑**——启动时把上次没转完（`status='transcribing'`）的视频重新入队。
 *
 * 进度写在 `store/jobs.ts` 里，因此切视频、回资料库都不会丢。
 */
import { db } from '../store/db';
import { getVideoFile } from '../store/fileStore';
import { isJobActive, useJobStore } from '../store/jobs';
import { runTranscription, type TranscribeProgress } from './transcribe';
import { terminateExtractor } from '../media/extractClient';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { isCancel } from '../utils/cancel';
import { formatCaughtError } from '../utils/errorText';
import { toast } from '../ui';

/** 在途任务的取消标记（key = videoId） */
const signals = new Map<string, { aborted: boolean }>();

let pumping = false;

/** 触发一次转写。已在跑/已在队列则直接返回（幂等） */
export function startTranscription(videoId: string, opts: { resume?: boolean } = {}): void {
  const state = useJobStore.getState();
  if (isJobActive(state.jobs[videoId])) return; // 吸附：不重复启动
  state.upsert(videoId, {
    phase: 'queued',
    message: opts.resume ? '等待续跑…' : '排队中…',
    done: 0,
    total: 0,
    error: undefined,
    resume: !!opts.resume,
  });
  state.enqueue(videoId);
  void pump();
}

/** 取消：抽音频/VAD 阶段直接终止 Worker，ASR 阶段让在途的几个请求跑完就停 */
export function cancelTranscription(videoId: string): void {
  const job = useJobStore.getState().jobs[videoId];
  if (!isJobActive(job)) return;
  const signal = signals.get(videoId);
  if (!signal) {
    // 还没轮到它：直接出队
    dequeue(videoId);
    markCanceled(videoId);
    return;
  }
  signal.aborted = true;
  // 抽取/VAD 卡在 Worker 的密集循环里，标记管不到，只能 terminate
  if (job?.phase === 'extract' || job?.phase === 'vad') terminateExtractor();
}

function dequeue(videoId: string): void {
  useJobStore.setState((s) => ({ queue: s.queue.filter((q) => q !== videoId) }));
}

function markCanceled(videoId: string): void {
  useJobStore.getState().upsert(videoId, { phase: 'canceled', message: '已取消' });
  window.setTimeout(() => {
    if (useJobStore.getState().jobs[videoId]?.phase === 'canceled') useJobStore.getState().drop(videoId);
  }, 3000);
}

/** 串行泵：队列里有活就一直跑，跑空为止 */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  await acquireWakeLock();
  try {
    for (;;) {
      const id = useJobStore.getState().queue[0];
      if (!id) break;
      useJobStore.getState().setActive(id);
      await runOne(id);
      // 出队。job 本身留着（done/error/canceled 还要给 UI 看一会儿）
      useJobStore.setState((st) => ({ queue: st.queue.filter((q) => q !== id), activeId: null }));
    }
  } finally {
    pumping = false;
    useJobStore.getState().setActive(null);
    await releaseWakeLock();
  }
}

async function runOne(videoId: string): Promise<void> {
  const job = useJobStore.getState().jobs[videoId];
  if (!job || job.phase === 'canceled') return;

  const signal = { aborted: false };
  signals.set(videoId, signal);

  try {
    await runTranscription(
      videoId,
      (p: TranscribeProgress) => {
        if (p.phase === 'done') return;
        useJobStore.getState().upsert(videoId, {
          phase: p.phase,
          message: p.message,
          done: p.done,
          total: p.total,
        });
      },
      { signal },
    );
    useJobStore.getState().upsert(videoId, { phase: 'done', message: '字幕生成完成' });
    const row = await db.videos.get(videoId);
    toast.success(`《${row?.name ?? '视频'}》字幕生成完成`);
    // 完成态只留一小会儿，随后自动清掉（下次再点就是「重新生成」）
    window.setTimeout(() => {
      if (useJobStore.getState().jobs[videoId]?.phase === 'done') useJobStore.getState().drop(videoId);
    }, 2000);
  } catch (e) {
    if (isCancel(e) || signal.aborted) {
      await settleCanceled(videoId);
      markCanceled(videoId);
      return;
    }
    const text = formatCaughtError(e);
    useJobStore.getState().upsert(videoId, { phase: 'error', message: '转写失败', error: text });
    const row = await db.videos.get(videoId);
    toast.error(`《${row?.name ?? '视频'}》转写失败：${text}`);
  } finally {
    signals.delete(videoId);
  }
}

/** 取消后的落库：已经有完成段就当「已转写」（字幕可用），一段都没有就退回「未转写」 */
async function settleCanceled(videoId: string): Promise<void> {
  const done = await db.segments.where('videoId').equals(videoId).filter((r) => r.status === 1).count();
  await db.videos.update(videoId, { status: done > 0 ? 'transcribed' : 'new' });
}

/**
 * 启动时续跑：把上次没转完的视频重新入队。
 * 只认 `status === 'transcribing'`——它是「用户发起过且中途断了」的唯一证据，
 * 不再额外建任务表。流水线本身支持断点续做（已完成段跳过），无需其它状态。
 */
export async function resumePendingTranscriptions(): Promise<void> {
  // status 不是索引（videos 只索引了 id, createdAt），只能全表过滤；视频量级无所谓
  const rows = await db.videos.filter((v) => v.status === 'transcribing').toArray();
  let resumed = 0;
  for (const v of rows) {
    // 视频文件本体没了就没法续（可能已删文件释放空间），跳过且不改状态
    const hasFile = await getVideoFile(v.id);
    if (!hasFile) continue;
    startTranscription(v.id, { resume: true });
    resumed++;
  }
  if (resumed > 0) toast.info(`有 ${resumed} 个视频上次没转完，已在后台继续`);
}
