import { remoteTasks } from '../cloud/state';
import { runCloudTask } from '../cloud/tasks';
import { getSettings, targetOfSlot } from '../store/settings';
import { db } from '../store/db';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { generateText, type TextProgress } from './textGeneration';

export type CardsProgress = TextProgress;

export async function runCards(videoId: string, onProgress: (p: CardsProgress) => void): Promise<number> {
  if (remoteTasks()) return runCloudTask('cards', `course:${videoId}`, { videoId }, onProgress);
  const video = await db.videos.get(videoId);
  if (!video) throw new Error('视频不存在');
  const segments = await db.segments.where('videoId').equals(videoId).sortBy('idx');
  await acquireWakeLock();
  try {
    const cards = await generateText('cards', video.name, segments, targetOfSlot(getSettings(), 'chat'), onProgress);
    const now = Date.now();
    await db.transaction('rw', db.cards, async () => {
      await db.cards.where('videoId').equals(videoId).delete();
      await db.cards.bulkAdd(cards.map(c => ({ videoId, ...c, status: 0 as const, createdAt: now })));
    });
    return cards.length;
  } finally { await releaseWakeLock(); }
}
