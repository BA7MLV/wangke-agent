import { db, type FolderRow } from '../store/db';

export function folderAncestors(folders: FolderRow[], id: number | null): FolderRow[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const result: FolderRow[] = [];
  const seen = new Set<number>();
  while (id != null && !seen.has(id)) {
    seen.add(id);
    const folder = byId.get(id);
    if (!folder) break;
    result.unshift(folder);
    id = folder.parentId ?? null;
  }
  return result;
}

export function validFolderDrop(folders: FolderRow[], keys: string[], target: number | null) {
  if (!keys.length || (target != null && !folders.some((folder) => folder.id === target))) return false;
  const ancestors = new Set(folderAncestors(folders, target).map((folder) => folder.id));
  return keys.every((key) => key.startsWith('file:') ||
    (key.startsWith('folder:') && folders.some((folder) => folder.id === Number(key.slice(7))) && !ancestors.has(Number(key.slice(7)))));
}

/** Validate against fresh rows and commit the whole mixed selection atomically. */
export async function moveLibraryItems(keys: string[], target: number | null) {
  await db.transaction('rw', [db.folders, db.videos], async () => {
    const folders = await db.folders.toArray();
    if (!validFolderDrop(folders, keys, target)) throw new Error('不能将文件夹移入自身或子文件夹');
    const movingFolders = new Set(keys.filter((key) => key.startsWith('folder:')).map((key) => Number(key.slice(7))));
    for (const key of new Set(keys)) {
      if (key.startsWith('folder:')) {
        const id = Number(key.slice(7));
        // A selected parent already carries its selected descendants.
        const folder = folders.find((row) => row.id === id)!;
        if (folderAncestors(folders, folder.parentId ?? null).some((row) => movingFolders.has(row.id!))) continue;
        await db.folders.update(id, { parentId: target ?? undefined });
      } else {
        const id = key.slice(5);
        const video = await db.videos.get(id);
        if (!video) throw new Error('资料已不存在');
        if (folderAncestors(folders, video.folderId ?? null).some((row) => movingFolders.has(row.id!))) continue;
        await db.videos.update(id, { folderId: target ?? undefined });
      }
    }
  });
}
