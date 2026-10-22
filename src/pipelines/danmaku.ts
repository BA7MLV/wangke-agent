import { remoteTasks } from '../cloud/state';
import { runCloudTask } from '../cloud/tasks';
import { getSettings, targetOfSlot } from '../store/settings';
import { db } from '../store/db';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { generateText, type TextProgress } from './textGeneration';

export type DanmakuProgress = TextProgress;

export async function runDanmaku(videoId: string, onProgress: (p: DanmakuProgress) => void): Promise<number> {
  if (remoteTasks()) return runCloudTask('danmaku', `course:${videoId}`, { videoId }, onProgress);
  const video = await db.videos.get(videoId);
  if (!video) throw new Error('视频不存在');
  const segments = await db.segments.where('videoId').equals(videoId).sortBy('idx');
  await acquireWakeLock();
  try {
    const items = await generateText('danmaku', video.name, segments, targetOfSlot(getSettings(), 'chat'), onProgress);
    await db.transaction('rw', db.danmakus, async () => {
      await db.danmakus.where('videoId').equals(videoId).delete();
      await db.danmakus.bulkAdd(items.map(item => ({ videoId, ...item })));
    });
    return items.length;
  } finally { await releaseWakeLock(); }
}
