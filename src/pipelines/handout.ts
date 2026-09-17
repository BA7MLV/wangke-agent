import { chatOnce, textOf } from '../api/siliconflow';
import { getSettings } from '../store/settings';
import { db, type FrameRow, type SegmentRow } from '../store/db';
import { getVideoFile } from '../store/fileStore';
import { extractFrames, extractFramesAt, blobToDataURL, type ExtractedFrame } from '../media/frames';
import { PROMPTS } from '../harness/prompts';
import { buildHandoutDocx, segmentsToTranscript, type HandoutSection } from '../handout/docx';
import { parseSectionBlocks, salvageBlocks, collectFigureTimestamps, type Block } from '../handout/ir';
import { routeHandoutSkills } from '../skills/router';
import { enqueueCover } from './coverQueue';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { AdaptiveLimit, withAdaptiveRetry, adaptivePool } from '../utils/concurrency';

export interface HandoutProgress {
  phase: 'frames' | 'captions' | 'outline' | 'writing' | 'docx' | 'done';
  done: number;
  total: number;
  message: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number }).status;
      if (status === 400 || status === 401 || status === 403) throw e;
      await sleep(1000 * 2 ** i + Math.random() * 500);
    }
  }
  throw lastErr;
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    }),
  );
}

function parseTimeToSec(t: string): number {
  const parts = t.trim().split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

/** 从 LLM 输出中稳健提取 JSON 对象 */
function extractJson<T>(text: string): T {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型未返回有效的 JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

interface OutlineSection {
  heading: string;
  start: string;
  end: string;
  points: string[];
}
interface Outline {
  title: string;
  summary: string;
  sections: OutlineSection[];
}

interface FrameWithCaption extends ExtractedFrame {
  caption: string;
  isSlide: boolean;
}

/** VL：描述帧内容，判断是否教学画面 */
async function captionFrame(frame: ExtractedFrame, limiter: AdaptiveLimit): Promise<FrameWithCaption> {
  const settings = getSettings();
  const dataUrl = await blobToDataURL(frame.blob);
  const msg = await withAdaptiveRetry(
    () =>
      chatOnce(settings, {
        model: settings.visionModel,
        // caption 最终截断到 120 字，300 的预留纯属浪费 TPM 配额
        max_tokens: 160,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUrl } },
              { type: 'text', text: PROMPTS.frameCaption },
            ],
          },
        ],
      }),
    limiter,
  );
  const text = textOf(msg);
  const isSlide = !text.includes('类型：无') && text.length > 8;
  const caption = text.replace(/^类型：.*$/m, '').trim().slice(0, 120) || '课程画面';
  return { ...frame, caption, isSlide };
}

/**
 * 讲义生成流水线：抽帧 → VL 理解 → 大纲 → 分节写作 → DOCX。
 * 前提：字幕已生成。
 */
export async function runHandout(
  videoId: string,
  onProgress: (p: HandoutProgress) => void,
): Promise<void> {
  const settings = getSettings();
  if (!settings.apiKey) throw new Error('请先在「设置」中填写硅基流动 API Key');

  const video = await db.videos.get(videoId);
  const blob = await getVideoFile(videoId);
  if (!video || !blob) throw new Error('视频不存在');

  const segments = await db.segments.where('videoId').equals(videoId).sortBy('idx');
  const doneSegs = segments.filter((s) => s.status === 1 && s.text);
  if (doneSegs.length < 3) throw new Error('请先在「字幕」页生成字幕');

  await acquireWakeLock();
  try {
    await runHandoutInner(videoId, doneSegs, blob, video.name, onProgress);
  } finally {
    await releaseWakeLock();
  }
}

async function runHandoutInner(
  videoId: string,
  doneSegs: SegmentRow[],
  videoBlob: Blob,
  videoName: string,
  onProgress: (p: HandoutProgress) => void,
): Promise<void> {
  const settings = getSettings();

  // 1. 抽帧（间隔 25s + 阈值 16：PPT 翻页差异大仍会被抓到，滤掉讲师晃动类低信息帧，省 TPM 配额）
  const frames = await extractFrames(videoBlob, {
    interval: 25,
    diffThreshold: 16,
    onProgress: (done, total) =>
      onProgress({ phase: 'frames', done, total, message: `抽取画面 ${done}/${total}` }),
  });

  // 2. VL 理解（AIMD 自适应并发：初始 3 上限 8，贴着 TPM 限额跑，遇 429 自动降速；单帧失败兜底不中断）
  const captioned: FrameWithCaption[] = new Array(frames.length);
  const limiter = new AdaptiveLimit(3, 1, 8);
  let capDone = 0;
  await adaptivePool(frames, limiter, async (frame, i) => {
    try {
      captioned[i] = await captionFrame(frame, limiter);
    } catch {
      captioned[i] = { ...frame, caption: '课程画面', isSlide: true };
    }
    capDone++;
    onProgress({
      phase: 'captions',
      done: capDone,
      total: frames.length,
      message: `理解画面 ${capDone}/${frames.length}（并发 ${limiter.current}）`,
    });
  });
  const slides = captioned.filter((f) => f.isSlide);

  // 保存帧到 DB（供问答时查看，也给封面当素材）
  //
  // 必须**先写新的、再删旧的，且放在同一个事务里**。原先的「先 delete 再 bulkAdd」
  // 有一个真实后果：bulkAdd 之前一旦抛错（配额、中断），旧的帧已经删掉了，
  // 讲义配图和「复用 slide 帧当封面」的素材就一起永久丢失。
  await db.transaction('rw', db.frames, async () => {
    const old = await db.frames.where('videoId').equals(videoId).toArray();
    if (slides.length > 0) {
      await db.frames.bulkAdd(
        slides.map<FrameRow>((f) => ({ videoId, ts: f.ts, blob: f.blob, kind: 'slide', caption: f.caption })),
      );
    }
    // 新的写成功了才删旧的（新增的行 id 与旧的不同，不会互相误删）
    if (old.length > 0) await db.frames.bulkDelete(old.map((f) => f.id!));
  });

  // 讲义跑完，手上这批幻灯片帧比入库时自动抽的那张更贴课件首页，所以让封面重做一次
  // （`ensureCover` 会挑最早的 slide 帧，并拒绝覆盖用户手选的封面）。
  // 不 await：封面是派生资源，晚一两秒换掉没影响，队列内部串行也不会和后面的写作抢解码器。
  enqueueCover(videoId, { force: true });

  // 3. 大纲（长文本先分块摘要）
  onProgress({ phase: 'outline', done: 0, total: 1, message: '选择写作技能…' });
  let transcript = segmentsToTranscript(doneSegs);
  // 渐进式披露：元数据路由 → 只注入选中技能的正文；叠加视频级手动覆盖
  const routed = await routeHandoutSkills(videoId, videoName, transcript.slice(0, 1500));
  const skillBlock = routed.block;
  if (routed.selected.length > 0) {
    onProgress({
      phase: 'outline',
      done: 0,
      total: 1,
      message: `已选用技能：${routed.selected.map((s) => s.name).join('、')}`,
    });
  }
  if (transcript.length > 12000) {
    const chunkSize = 6000;
    const summaries: string[] = [];
    for (let i = 0; i < transcript.length; i += chunkSize) {
      const chunk = transcript.slice(i, i + chunkSize);
      const msg = await withRetry(() =>
        chatOnce(settings, {
          model: settings.llmModel,
          max_tokens: 1500,
          messages: [{ role: 'user', content: PROMPTS.chunkSummary(chunk) }],
        }),
      );
      summaries.push(textOf(msg));
      onProgress({ phase: 'outline', done: summaries.length, total: Math.ceil(transcript.length / chunkSize) + 1, message: `摘要分段素材 ${summaries.length}…` });
    }
    transcript = summaries.join('\n');
  }

  const outlineMsg = await withRetry(() =>
    chatOnce(settings, {
      model: settings.llmModel,
      max_tokens: 4000,
      messages: [{ role: 'user', content: PROMPTS.outline(transcript, videoName, skillBlock) }],
    }),
  );
  const outline = extractJson<Outline>(textOf(outlineMsg));
  if (!outline.sections?.length) throw new Error('大纲生成失败，请重试');
  outline.sections = outline.sections.slice(0, 12);

  // 4. 分节写作（并发 2）：模型输出 IR JSON，解析失败重试一次，再失败走兜底不阻塞
  const sections: HandoutSection[] = new Array(outline.sections.length);
  let writeDone = 0;
  await pool(outline.sections, 2, async (sec, i) => {
    const startSec = parseTimeToSec(sec.start);
    const endSec = parseTimeToSec(sec.end);
    const secTranscript = segmentsToTranscript(
      doneSegs.filter((s) => s.start >= startSec - 5 && s.start <= endSec + 5),
    );
    const secFrames = slides.filter((f) => f.ts >= startSec - 10 && f.ts <= endSec + 10);
    const frameNotes = secFrames
      .map((f) => `- ${fmtTimeStr(f.ts)}：${f.caption}`)
      .join('\n');
    // figure 时间戳的合法范围与配图清单保持一致（±10s 边界容差）
    const range = { startSec: Math.max(0, startSec - 10), endSec: endSec + 10 };
    const ctx = { title: outline.title || videoName, summary: outline.summary || '', skillBlock };

    let raw = '';
    let blocks: Block[] | null = null;
    for (let attempt = 0; attempt < 2 && !blocks; attempt++) {
      const msg = await withRetry(() =>
        chatOnce(settings, {
          model: settings.llmModel,
          max_tokens: 3000,
          messages: [
            {
              role: 'user',
              content: PROMPTS.section(
                sec.heading,
                sec.points ?? [],
                secTranscript || transcript.slice(0, 3000),
                frameNotes,
                ctx,
              ),
            },
          ],
        }),
      );
      raw = textOf(msg).trim();
      try {
        blocks = parseSectionBlocks(raw, range);
      } catch {
        // IR 校验失败：重试一次
      }
    }
    sections[i] = { heading: sec.heading, blocks: blocks ?? salvageBlocks(raw) };
    writeDone++;
    onProgress({ phase: 'writing', done: writeDone, total: outline.sections.length, message: `撰写章节 ${writeDone}/${outline.sections.length}` });
  });

  // 5. 组装 DOCX
  onProgress({ phase: 'docx', done: 0, total: 1, message: '排版生成 DOCX…' });
  // 注意：images 的 key 统一 floor 到整数秒——模型返回的 figure.time 经 mm:ss 解析后是整数秒，
  // 而 VL 帧 ts 是浮点（如 1.2s），不 floor 会导致渲染时 Map.get 失配丢图。
  const images = new Map<number, { data: Uint8Array; width: number; height: number; caption: string }>();
  for (const f of slides) {
    images.set(Math.floor(f.ts), {
      data: new Uint8Array(await f.blob.arrayBuffer()),
      width: f.width,
      height: f.height,
      caption: f.caption,
    });
  }

  // 讲义配图高清重抽：VL 帧为 640px/q0.75（识图折中，进文档只有约 110 DPI），
  // 对实际被引用的帧按原分辨率（1600 封顶）q0.92 重抽；失败则用 VL 帧兜底，不阻塞。
  const doneSections = sections.filter(Boolean);
  const usedTs = collectFigureTimestamps(doneSections);
  if (usedTs.length > 0) {
    onProgress({ phase: 'docx', done: 0, total: 1, message: `重抽高清配图 ${usedTs.length} 张…` });
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
      // 高清重抽失败：保留 VL 帧，继续生成
    }
  }

  const now = new Date();
  const blob = await buildHandoutDocx({
    title: outline.title || `${videoName} 学习讲义`,
    courseName: videoName,
    date: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
    summary: outline.summary || '',
    sections: doneSections,
    images,
  });

  await db.handouts.add({
    videoId,
    createdAt: Date.now(),
    title: outline.title || videoName,
    blob,
    outlineJson: JSON.stringify(outline),
    sectionsJson: JSON.stringify(doneSections),
    usedSkills: routed.selected.map((s) => s.name),
  });

  onProgress({ phase: 'done', done: 1, total: 1, message: '讲义生成完成' });
}

function fmtTimeStr(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
