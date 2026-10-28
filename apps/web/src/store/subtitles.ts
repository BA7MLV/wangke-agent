import { db, type SegmentRow } from './db';
import { cuesToSegments, type SubtitleBundle } from '../bilibili/subtitle';

/**
 * 导入字幕落库：主语言写 `segments`（AI 全链路用它），全部语言写 `subtitleTracks`（只喂显示）。
 * 主语言非空时把视频直接标为已转写，讲义/卡片/弹幕立刻可用。
 */
export async function saveImportedSubtitles(videoId: string, bundle: SubtitleBundle): Promise<void> {
  await db.transaction('rw', [db.videos, db.segments, db.subtitleTracks], async () => {
    await db.segments.where('videoId').equals(videoId).delete();
    if (bundle.primary) {
      const rows: SegmentRow[] = cuesToSegments(bundle.primary.cues).map((r) => ({ ...r, videoId }));
      if (rows.length > 0) await db.segments.bulkAdd(rows);
    }
    await db.subtitleTracks.where('videoId').equals(videoId).delete();
    if (bundle.tracks.length > 0) {
      await db.subtitleTracks.bulkAdd(
        bundle.tracks.map((t) => ({
          videoId,
          lang: t.lang,
          lanDoc: t.lanDoc,
          primary: t.primary,
          cues: t.cues,
        })),
      );
    }
    await db.videos.update(videoId, { status: bundle.primary ? 'transcribed' : 'new' });
  });
}
