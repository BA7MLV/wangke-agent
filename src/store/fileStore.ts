import { db } from './db';

/**
 * 课程文件存储层（视频 + 阅读材料共用）。
 *
 * 视频体积大（网课常 1–3GB），IndexedDB 在 Safari 上写大 Blob 极慢
 * （结构化克隆 + SQLite 落盘 + 静态加密），因此课程文件存 OPFS
 * （流式分块写入、可报进度），IndexedDB 只存元数据。
 *
 * 兼容：OPFS 不可用时回退 IndexedDB；旧版本存在 IndexedDB 里的
 * 视频在首次读取时后台懒迁移到 OPFS。
 *
 * 目录按资源类型分开（videos / materials）：既让「清空视频」这类维护操作有明确边界，
 * 也避免两类文件的 id 混在同一个目录里。
 */

const DIR_VIDEOS = 'videos';
const DIR_MATERIALS = 'materials';
const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB 一块，兼顾进度粒度与写入开销

/** 每个目录各自缓存句柄（原来只有一个目录，泛化后要按目录分桶） */
const dirPromises = new Map<string, Promise<FileSystemDirectoryHandle | null>>();
let persistRequested = false;

/** 获取 OPFS 目录；环境不支持 OPFS 时返回 null */
function getDir(name: string): Promise<FileSystemDirectoryHandle | null> {
  let p = dirPromises.get(name);
  if (!p) {
    p = (async () => {
      try {
        if (!navigator.storage?.getDirectory) return null;
        if (!persistRequested) {
          persistRequested = true;
          // 申请持久化存储，防止浏览器空间紧张时自动清理（尽力而为）
          navigator.storage.persist?.().catch(() => {});
        }
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle(name, { create: true });
      } catch {
        return null;
      }
    })();
    dirPromises.set(name, p);
  }
  return p;
}

/**
 * 保存课程文件：优先 OPFS 流式分块写入（onProgress 报 0→1）；
 * OPFS 不可用时回退 IndexedDB（无中间进度）。
 */
export async function saveCourseFile(
  id: string,
  blob: Blob,
  onProgress?: (ratio: number) => void,
  dirName: string = DIR_VIDEOS,
): Promise<void> {
  const dir = await getDir(dirName);
  if (!dir) {
    await db.files.put({ id, blob });
    onProgress?.(1);
    return;
  }
  const handle = await dir.getFileHandle(id, { create: true });
  const writable = await handle.createWritable();
  try {
    for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
      const end = Math.min(blob.size, offset + CHUNK_SIZE);
      await writable.write(blob.slice(offset, end));
      onProgress?.(blob.size > 0 ? end / blob.size : 1);
    }
    await writable.close();
  } catch (e) {
    try {
      await writable.abort();
    } catch {
      /* 句柄可能已关闭 */
    }
    try {
      await dir.removeEntry(id);
    } catch {
      /* 清理半截文件失败可忽略 */
    }
    throw e;
  }
}

/**
 * 读取课程文件：先查 OPFS；查不到再查 IndexedDB（旧数据），
 * 命中旧数据后后台懒迁移到 OPFS 并删除 IndexedDB 副本。
 */
export async function getCourseFile(id: string, dirName: string = DIR_VIDEOS): Promise<Blob | null> {
  const dir = await getDir(dirName);
  if (dir) {
    try {
      const handle = await dir.getFileHandle(id);
      return await handle.getFile();
    } catch (e) {
      if ((e as DOMException).name !== 'NotFoundError') throw e;
    }
  }
  const row = await db.files.get(id);
  if (!row) return null;
  if (dir) {
    // 懒迁移，不阻塞本次读取；失败则下次读取时再试
    void (async () => {
      try {
        await saveCourseFile(id, row.blob, undefined, dirName);
        await db.files.delete(id);
      } catch {
        /* ignore */
      }
    })();
  }
  return row.blob;
}

/** 删除课程文件（OPFS 与 IndexedDB 旧数据都清） */
export async function deleteCourseFile(id: string, dirName: string = DIR_VIDEOS): Promise<void> {
  const dir = await getDir(dirName);
  if (dir) {
    try {
      await dir.removeEntry(id);
    } catch {
      /* 文件不存在则忽略 */
    }
  }
  await db.files.delete(id);
}

// ── 视频（保留原函数名，调用点不动，减小回归面） ──────────────────────────────

export function saveVideoFile(id: string, blob: Blob, onProgress?: (ratio: number) => void) {
  return saveCourseFile(id, blob, onProgress, DIR_VIDEOS);
}

export function getVideoFile(id: string) {
  return getCourseFile(id, DIR_VIDEOS);
}

export function deleteVideoFile(id: string) {
  return deleteCourseFile(id, DIR_VIDEOS);
}

// ── 阅读材料 ────────────────────────────────────────────────────────────────

export function saveMaterialFile(id: string, blob: Blob, onProgress?: (ratio: number) => void) {
  return saveCourseFile(id, blob, onProgress, DIR_MATERIALS);
}

export function getMaterialFile(id: string) {
  return getCourseFile(id, DIR_MATERIALS);
}

export function deleteMaterialFile(id: string) {
  return deleteCourseFile(id, DIR_MATERIALS);
}
