import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { receiveFile } from './files.js';
import { commitTask, recordMutation, taskCourseFile, taskFile, taskRows, type TaskContext } from './execution.js';

class MediaDecodeError extends Error {
  constructor() { super('媒体解码失败，无法生成封面'); }
}

/** Fixed executable/arguments: task payloads cannot supply commands, paths or network URLs. */
export function runMediaProcess(args: string[], signal: AbortSignal, options: {
  executable?: string; timeoutMs?: number; maxBytes?: number;
} = {}): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable ?? process.env.FFMPEG_PATH ?? 'ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'C' },
    });
    const buffers: Buffer[] = [];
    let size = 0, failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    const abort = () => stop(new DOMException('媒体任务已取消', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => stop(new Error('媒体处理超时')), options.timeoutMs ?? 120_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 8 * 1024 * 1024)) stop(new Error('媒体输出超出限制'));
      else buffers.push(chunk);
    });
    // Always drain stderr; don't expose host paths or arbitrary decoder output in task results.
    child.stderr.resume();
    child.on('error', error => { failure = Object.assign(new Error('无法启动 FFmpeg，请安装或配置 FFMPEG_PATH'), { cause: error }); });
    child.on('close', code => {
      clearTimeout(timeout); clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 || !size) reject(new MediaDecodeError());
      else resolve(Buffer.concat(buffers));
    });
    if (signal.aborted) abort();
  });
}

export async function executeMediaTask(context: TaskContext) {
  context.checkActive();
  const id = String(context.task.input.videoId);
  const video = context.records.get(context.owner, 'videos', id);
  if (!video) return false;
  const current = context.records.get(context.owner, 'covers', id);
  const force = (context.task.input.options as { force?: boolean } | undefined)?.force;
  if (current?.source === 'user' || (current && !force)) {
    if (video.coverState !== 'done') commitTask(context, [recordMutation('videos', id, video, { ...video, coverState: 'done' })]);
    return false;
  }
  const original = video.fileDeleted === 1 ? null : taskCourseFile(context, id);
  if (!original) {
    commitTask(context, [recordMutation('videos', id, video, { ...video, coverState: 'skipped' })]);
    return false;
  }
  const slides = taskRows(context, 'frames', 'videoId', id).filter(frame => frame.kind === 'slide' && frame.blob)
    .sort((a, b) => a.ts - b.ts);
  const slide = slides[0];
  const filename = slide ? taskFile(context, slide.blob) : original;
  const duration = Number(video.duration);
  let ts = slide ? slide.ts : Number.isFinite(duration) && duration > 0 ? Math.min(2, duration * 0.02) : 0;
  context.report({ phase: 'frames', done: 0, total: 1, message: '正在生成视频封面…' });
  const frameAt = (time: number) => runMediaProcess([
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', '268435456', '-threads', '1',
    '-protocol_whitelist', 'file,pipe',
    '-format_whitelist', 'mov,matroska,webm,avi,flv,mpegts,asf,mpeg,ogg,rm,mp3,wav,aac,flac,png_pipe,jpeg_pipe,webp_pipe',
    ...(!slide && time > 0 ? ['-ss', String(time)] : []), '-i', filename,
    '-an', '-sn', '-dn', '-filter_threads', '1',
    '-vf', `${slide ? '' : 'thumbnail=30,'}scale=w='min(480,iw)':h='min(480,ih)':force_original_aspect_ratio=decrease`,
    '-frames:v', '1', '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1',
  ], context.signal);
  let png: Buffer;
  try { png = await frameAt(ts); }
  catch (error) {
    context.checkActive();
    if (slide || ts <= 0 || !(error instanceof MediaDecodeError)) throw error;
    // Sparse recordings can contain only the initial frame; stale duration metadata
    // can also put a seek past EOF. Retry from the beginning, never via Chromium.
    ts = 0;
    png = await frameAt(ts);
  }
  context.checkActive();
  if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('媒体输出格式无效');
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  if (!w || !h || w > 480 || h > 480) throw new Error('媒体输出尺寸无效');
  const uploaded = await receiveFile(context.store, context.filesDir, context.owner, Readable.from([png]), 'video-cover.png', 'image/png', 8 * 1024 * 1024, png.length);
  context.checkActive();
  const latestVideo = context.records.get(context.owner, 'videos', id);
  const latestCover = context.records.get(context.owner, 'covers', id);
  if (!latestVideo || latestCover?.source === 'user' || latestVideo.fileDeleted === 1) return false;
  commitTask(context, [
    recordMutation('covers', id, latestCover, { videoId: id, blob: { $file: uploaded.id, type: 'image/png' },
      w, h, ts, source: slide ? 'slide' : 'auto', createdAt: Date.now() }),
    recordMutation('videos', id, latestVideo, { ...latestVideo, coverState: 'done' }),
  ]);
  context.report({ phase: 'done', done: 1, total: 1, message: '视频封面已生成' });
  return true;
}
