import { db } from './db';
import { cloud } from '../cloud/state';
import { flushCloud } from '../cloud/sync';
import { apiUrl } from '../api/base';
import { getSystemMaterialFile } from '../materials/systemFiles';

/**
 * 课程文件存储层（视频 + 阅读材料共用）。
 *
 * 视频体积大（网课常 1–3GB），IndexedDB 在 Safari 上写大 Blob 极慢
 * （结构化克隆 + SQLite 落盘 + 静态加密），因此课程文件存 OPFS
 * （流式分块写入、可报进度），IndexedDB 只存元数据。
 *
 * 兼容：Safari 缺少 createWritable 时使用 Worker 同步句柄；
 * 两种写入方式均不可用时回退 IndexedDB。旧数据保留在原存储中。
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

function writeInWorker(handle: FileSystemFileHandle, blob: Blob, onProgress?: (ratio: number) => void): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./fileWriter.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(false);
      return;
    }
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        onProgress?.(data.ratio);
        return;
      }
      worker.terminate();
      if (data.type === 'done') resolve(true);
      else if (data.type === 'unsupported') resolve(false);
      else reject(new DOMException(data.message, data.name));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      worker.terminate();
      reject(new Error('文件写入进程中断，请保持页面在前台并重新导入。'));
    };
    worker.onmessageerror = () => {
      worker.terminate();
      reject(new Error('文件写入通信失败，请重新导入。'));
    };
    try {
      worker.postMessage({ handle, blob });
    } catch {
      worker.terminate();
      resolve(false);
    }
  });
}

async function saveFile(
  id: string,
  blob: Blob,
  onProgress?: (ratio: number) => void,
  dirName: string = DIR_VIDEOS,
): Promise<void> {
  if (cloud.enabled) {
    const response = await fetch(apiUrl('/api/v1/files'), { method: 'POST', credentials: 'include', headers: {
      'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(id.slice(0, 255)),
      'x-file-mime': blob.type || 'application/octet-stream',
    }, body: blob });
    if (!response.ok) throw new Error(response.status === 413 ? '文件超过服务器上传上限（默认 512 MiB）' : `上传失败（${response.status}）`);
    const file = await response.json();
    await db.transaction('rw', db.table('courseFiles'), db.files, async () => {
      await db.table('courseFiles').put({ id, fileId: file.id, mimeType: blob.type, size: blob.size, directory: dirName });
      await db.files.delete(id);
    });
    await flushCloud();
    onProgress?.(1);
    return;
  }
  const dir = await getDir(dirName);
  if (!dir) {
    await db.files.put({ id, blob });
    onProgress?.(1);
    return;
  }
  let existed = false;
  try {
    await dir.getFileHandle(id);
    existed = true;
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') throw e;
  }
  const handle = await dir.getFileHandle(id, { create: true });
  let writable: FileSystemWritableFileStream | undefined;
  try {
    let saved = false;
    if (typeof handle.createWritable === 'function') {
      try {
        writable = await handle.createWritable();
      } catch (e) {
        if ((e as DOMException).name !== 'NotSupportedError') throw e;
      }
    }
    if (writable) {
      for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
        const end = Math.min(blob.size, offset + CHUNK_SIZE);
        await writable.write(blob.slice(offset, end));
        onProgress?.(Math.min(0.99, end / blob.size));
      }
      await writable.close();
      saved = true;
    } else {
      // 已有文件用 IndexedDB 原子替换，避免同步句柄中途失败破坏旧内容。
      saved = !existed && await writeInWorker(handle, blob, onProgress);
    }
    if (saved) {
      await db.files.delete(id);
    } else {
      await db.files.put({ id, blob });
      await dir.removeEntry(id).catch(() => {});
    }
    onProgress?.(1);
  } catch (e) {
    try {
      await writable?.abort();
    } catch {
      /* 句柄可能已关闭 */
    }
    try {
      if (!existed) await dir.removeEntry(id);
    } catch {
      /* 清理半截文件失败可忽略 */
    }
    throw e;
  }
}

/** 只有持久化完成后报告 100%；配额错误不换后端盲目重试。 */
export async function saveCourseFile(
  id: string,
  blob: Blob,
  onProgress?: (ratio: number) => void,
  dirName: string = DIR_VIDEOS,
): Promise<void> {
  try {
    onProgress?.(0);
    await saveFile(id, blob, onProgress, dirName);
  } catch (error) {
    if ((error as Error).name === 'QuotaExceededError') {
      throw new DOMException('设备或浏览器存储空间不足。请删除不需要的课程或释放设备空间后，重新导入。', 'QuotaExceededError');
    }
    throw error;
  }
}

/**
 * IndexedDB 的有效副本优先，避免失败的 OPFS 空文件遮住回退数据。
 * 不在读取时迁移：读取不应触发大文件复制或与保存、删除竞争。
 */
export async function getCourseFile(id: string, dirName: string = DIR_VIDEOS): Promise<Blob | null> {
  if (cloud.enabled) {
    // Markdown edits are committed atomically with their index in files; a newer
    // editable copy takes precedence over the originally uploaded course file.
    const edited = await db.files.get(id);
    if (edited) return edited.blob;
    const file = await db.table('courseFiles').get(id);
    if (!file) return null;
    const response = await fetch(apiUrl(`/api/v1/files/${encodeURIComponent(file.fileId)}`), { credentials: 'include' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`读取服务器文件失败（${response.status}）`);
    return new Blob([await response.blob()], { type: file.mimeType });
  }
  const row = await db.files.get(id);
  if (row) return row.blob;
  const dir = await getDir(dirName);
  if (dir) {
    try {
      const handle = await dir.getFileHandle(id);
      return await handle.getFile();
    } catch (e) {
      if ((e as DOMException).name !== 'NotFoundError') throw e;
    }
  }
  return null;
}

/** 删除课程文件（OPFS 与 IndexedDB 旧数据都清） */
export async function deleteCourseFile(id: string, dirName: string = DIR_VIDEOS): Promise<void> {
  if (cloud.enabled) {
    await db.table('courseFiles').delete(id);
    await db.files.delete(id);
    await flushCloud();
    return;
  }
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

export async function getMaterialFile(id: string) {
  return getSystemMaterialFile(id) ?? getCourseFile(id, DIR_MATERIALS);
}

export function deleteMaterialFile(id: string) {
  return deleteCourseFile(id, DIR_MATERIALS);
}

/**
 * 按字节段读取课程文件（实时链路 host 侧视频流用）。
 * OPFS 的 File.slice() 天然支持随机读；IndexedDB 回退路径同样 slice。
 * 不做缓存：窗口由 guest 侧 window.ts 管，host 再缓存一份只会让内存翻倍。
 */
export async function readCourseFileRange(
  id: string,
  start: number,
  len: number,
  dirName: string = DIR_VIDEOS,
): Promise<ArrayBuffer | null> {
  const file = await getCourseFile(id, dirName);
  if (!file) return null;
  const s = Math.max(0, Math.min(file.size, start));
  const e = Math.min(file.size, s + Math.max(0, len));
  return file.slice(s, e).arrayBuffer();
}
