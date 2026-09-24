import { db } from './db';

/**
 * 存储占用统计。
 *
 * 总数用 navigator.storage.estimate()（浏览器视角的真实占用与配额，
 * Safari 按桶取整，仅供参考量级）；分类明细由应用自统计：
 * estimate() 的 usageDetails 在 Safari 上不可靠，且分不清应用内类别。
 *
 * 大表（frames / segments）用 cursor 逐条累加，
 * 避免 toArray() 一次性把图片/正文全部读进内存。
 */

export interface StorageCategory {
  key: string;
  label: string;
  bytes: number;
}

export interface StorageStats {
  /** 浏览器已用（estimate，含索引等开销）；不可用时为各分类之和 */
  usage: number;
  /** 浏览器配额；不可用时为 0 */
  quota: number;
  /** 是否已获得持久化存储（未持久化的数据可能被系统清理） */
  persisted: boolean;
  categories: StorageCategory[];
}

export async function getStorageStats(): Promise<StorageStats> {
  let videos = 0;
  let materials = 0;
  let frames = 0;
  let textBytes = 0;
  let handouts = 0;

  // 视频与阅读材料按 kind 分流：不分开的话材料体积会被算进「视频文件」，
  // 用户看着「视频占 800MB」却找不到对应的大视频，只会以为统计坏了。
  // files 表是旧版遗留的 IndexedDB 副本（OPFS 不可用时的回退），无法区分类型，仍归入视频。
  await db.videos.each((v) => {
    if (v.kind === 'material') materials += v.size;
    else videos += v.size;
  });
  await db.files.each((f) => {
    videos += f.blob.size;
  });
  await db.frames.each((f) => {
    frames += f.blob.size;
  });
  await db.segments.each((s) => {
    textBytes += s.text.length * 2; // JS 字符串按 UTF-16 估算
  });
  // B 站多语言字幕轨（对照显示用，条数与主字幕同量级）
  await db.subtitleTracks.each((t) => {
    for (const c of t.cues) textBytes += c.text.length * 2;
  });
  // 材料的文本块：与字幕同属「供检索的正文」一类
  await db.materialBlocks.each((b) => {
    textBytes += b.text.length * 2;
  });
  await db.handouts.each((h) => {
    handouts += h.blob.size;
  });

  const known = videos + materials + frames + textBytes + handouts;

  let usage = 0;
  let quota = 0;
  let persisted = false;
  try {
    const est = await navigator.storage?.estimate?.();
    usage = est?.usage ?? 0;
    quota = est?.quota ?? 0;
    persisted = (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    /* 个别浏览器接口不可用，退化为自统计总数 */
  }
  if (usage < known) usage = known;

  // usage 与已知分类的差额：IndexedDB 索引、SQLite 页、OPFS 元数据等开销
  const overhead = Math.max(0, usage - known);

  return {
    usage,
    quota,
    persisted,
    categories: [
      { key: 'videos', label: '视频文件', bytes: videos },
      { key: 'materials', label: '阅读材料', bytes: materials },
      { key: 'frames', label: '抽帧图片', bytes: frames },
      { key: 'text', label: '字幕与文本', bytes: textBytes },
      { key: 'handouts', label: '讲义文档', bytes: handouts },
      { key: 'overhead', label: '浏览器存储开销', bytes: overhead },
    ],
  };
}
