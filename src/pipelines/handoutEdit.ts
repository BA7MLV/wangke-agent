/**
 * 讲义块级编辑管线：
 * ① rewriteBlockWithLLM——单块 AI 改写（输出契约由 parseRewrittenBlock 校验）；
 * ② persistHandoutEdit——编辑落盘：由最新 IR 重建 DOCX 并写回同一行。
 *    连续编辑经串行队列合并（进行中被取代的任务直接视为完成），
 *    重建失败不丢内存状态（下次编辑带全量 IR 重试即自愈）。
 */
import { remoteTasks } from '../cloud/state';
import { runCloudTask } from '../cloud/tasks';
import { getSettings, targetOfSlot } from '../store/settings';
import { db } from '../store/db';
import { getVideoFile } from '../store/fileStore';
import { extractFramesAt } from '../media/frames';
import { buildHandoutDocx, type HandoutSection } from '../handout/docx';
import { collectFigureTimestamps, type Block } from '../handout/ir';
import type { HandoutImages } from '../handout/render';
import { rewriteBlock } from '../handout/rewrite';

/** 块的纯文本摘要（给 LLM 的上下文用） */
export function blockToText(b: Block): string {
  switch (b.type) {
    case 'lead':
    case 'para':
    case 'note':
    case 'h2':
      return b.text;
    case 'list':
      return b.items.join('；');
    case 'table':
      return [b.caption, ...b.header].filter(Boolean).join(' ');
    case 'figure':
      return b.caption ? `配图：${b.caption}` : '配图';
  }
}

/** LLM 改写单个块：失败重试一次，再失败抛错由 UI 提示 */
export async function rewriteBlockWithLLM(
  original: Block,
  instruction: string,
  ctx: { title: string; heading?: string; prev?: string; next?: string },
): Promise<Block> {
  if (remoteTasks()) return runCloudTask('handoutEdit', crypto.randomUUID(), { original, instruction, ctx });
  const target = targetOfSlot(getSettings(), 'chat');
  return rewriteBlock(target, original, instruction, ctx);
}

interface EditJob {
  sections: HandoutSection[];
  summary: string;
  done: (err?: unknown) => void;
}
const editQueues = new Map<number, { running: boolean; pending?: EditJob }>();

/** 编辑落盘（合并连续修改）：重建 DOCX + 写回 sectionsJson / outlineJson / blob */
export function persistHandoutEdit(
  handoutId: number,
  sections: HandoutSection[],
  summary: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const st = editQueues.get(handoutId) ?? { running: false };
    editQueues.set(handoutId, st);
    const job: EditJob = {
      sections,
      summary,
      done: (err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve()),
    };
    if (st.running) {
      st.pending?.done(); // 被更新的编辑取代：视作完成（其内容已包含在新 job 中）
      st.pending = job;
      return;
    }
    void runEditJob(handoutId, st, job);
  });
}

async function runEditJob(handoutId: number, st: { running: boolean; pending?: EditJob }, job: EditJob) {
  st.running = true;
  try {
    await rebuildHandoutDocx(handoutId, job.sections, job.summary);
    job.done();
  } catch (e) {
    job.done(e);
  }
  if (st.pending) {
    const next = st.pending;
    st.pending = undefined;
    await runEditJob(handoutId, st, next);
  } else {
    st.running = false;
    editQueues.delete(handoutId);
  }
}

/** 由 IR 重建 DOCX：图片优先按原视频重抽高清（1600px），失败/视频已删回退 frames 表 VL 帧 */
async function rebuildHandoutDocx(handoutId: number, sections: HandoutSection[], summary: string) {
  const row = await db.handouts.get(handoutId);
  if (!row) throw new Error('讲义不存在');
  const video = await db.videos.get(row.videoId);
  if (!video) throw new Error('视频不存在');

  const frames = await db.frames.where('videoId').equals(row.videoId).toArray();
  const images: HandoutImages = new Map();
  for (const f of frames) {
    try {
      const bmp = await createImageBitmap(f.blob);
      images.set(Math.floor(f.ts), {
        data: new Uint8Array(await f.blob.arrayBuffer()),
        width: bmp.width,
        height: bmp.height,
        caption: f.caption ?? '课程画面',
      });
      bmp.close();
    } catch {
      // 单帧解码失败：跳过（渲染层对该时间戳静默跳过）
    }
  }

  const usedTs = collectFigureTimestamps(sections);
  if (usedTs.length > 0) {
    const videoBlob = await getVideoFile(row.videoId).catch(() => null);
    if (videoBlob) {
      try {
        const hires = await extractFramesAt(videoBlob, usedTs, { maxWidth: 1600, quality: 0.92 });
        for (const [ts, frame] of hires) {
          const prev = images.get(ts);
          images.set(ts, {
            data: new Uint8Array(await frame.blob.arrayBuffer()),
            width: frame.width,
            height: frame.height,
            caption: prev?.caption ?? '课程画面',
          });
        }
      } catch {
        // 高清重抽失败：保留 VL 帧，继续
      }
    }
  }

  const created = new Date(row.createdAt);
  const blob = await buildHandoutDocx({
    title: row.title,
    courseName: video.name,
    date: `${created.getFullYear()}年${created.getMonth() + 1}月${created.getDate()}日`,
    summary,
    sections,
    images,
  });

  const outline = JSON.parse(row.outlineJson) as Record<string, unknown>;
  await db.handouts.update(handoutId, {
    blob,
    sectionsJson: JSON.stringify(sections),
    outlineJson: JSON.stringify({ ...outline, summary }),
  });
}
