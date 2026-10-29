import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerStorageStats, StorageCategoryId } from '@wangke/contracts';

interface StoragePaths { dataDir: string; dbPath: string; filesDir: string; configDir: string }
const categoryIds: StorageCategoryId[] = ['database', 'files', 'workspaces', 'system', 'other'];
const inside = (file: string, root: string) => file === root || file.startsWith(root + path.sep);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Reads metadata only. No SQLite checkpoint, file reads or shell commands. */
export async function collectStorageUsage(paths: StoragePaths): Promise<ServerStorageStats> {
  let partial = false;
  const resolve = async (file: string, required = false) => {
    try { return await fs.realpath(file); }
    catch (error) { if (required || !missing(error)) partial = true; return null; }
  };
  const [filesDir, configDir, dataDir, ...databaseFiles] = await Promise.all([
    resolve(paths.filesDir, true), resolve(paths.configDir), resolve(paths.dataDir),
    ...['', '-wal', '-shm', '-journal'].map(suffix => paths.dbPath === ':memory:'
      ? Promise.resolve(null) : resolve(paths.dbPath + suffix, suffix === '')),
  ]);
  const database = new Set(databaseFiles.filter((file): file is string => file !== null));
  const categoryFor = (file: string): StorageCategoryId => {
    if (database.has(file)) return 'database';
    if (filesDir && inside(file, path.join(filesDir, 'projects'))) return 'workspaces';
    if (filesDir && inside(file, path.join(filesDir, 'system-files'))) return 'system';
    if (filesDir && inside(file, filesDir)) return 'files';
    return 'other';
  };
  const categories = categoryIds.map(id => ({ id, bytes: 0 }));
  const totals = new Map(categories.map(category => [category.id, category]));
  const volumes = new Map<number, ServerStorageStats['volumes'][number]>();
  const seen = new Set<string>();
  const deadline = Date.now() + 10_000;
  let entries = 0;
  const limitReached = () => entries >= 200_000 || Date.now() >= deadline;

  // Specific roots first: overlaps and hard links never inflate the total.
  for (const root of [...database, filesDir, configDir, dataDir]) {
    if (!root) continue;
    const pending = [root];
    while (pending.length) {
      if (limitReached()) { partial = true; break; }
      const file = pending.pop()!;
      try {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue;
        const inode = `${stat.dev}:${stat.ino}`;
        if (seen.has(inode)) continue;
        seen.add(inode);
        const category = categoryFor(file);
        let volume = volumes.get(stat.dev);
        if (!volume) {
          let capacity: ServerStorageStats['volumes'][number]['capacity'] = null;
          try {
            const disk = await fs.statfs(file);
            if (disk.blocks > 0 && disk.bsize > 0) capacity = {
              totalBytes: disk.blocks * disk.bsize,
              usedBytes: Math.max(0, disk.blocks - disk.bfree) * disk.bsize,
              availableBytes: Math.max(0, disk.bavail) * disk.bsize,
            };
          } catch { /* Capacity can be unavailable even when file sizes are readable. */ }
          volume = { id: String(volumes.size + 1), categories: [], capacity };
          volumes.set(stat.dev, volume);
        }
        if (!volume.categories.includes(category)) volume.categories.push(category);
        if (stat.isFile()) {
          totals.get(category)!.bytes += stat.size;
          continue;
        }
        // Stream directory entries: a large workspace must not block the event
        // loop or allocate an unbounded readdir result. Never follow symlinks.
        const directory = await fs.opendir(file);
        for await (const entry of directory) {
          if (limitReached()) { partial = true; break; }
          entries++;
          if (entry.isFile() || entry.isDirectory()) pending.push(path.join(file, entry.name));
        }
      } catch (error) {
        // Concurrent deletes are normal; permission/I/O errors are not zero usage.
        if (!missing(error)) partial = true;
      }
    }
    if (limitReached()) { partial = true; break; }
  }
  return {
    totalBytes: categories.reduce((sum, category) => sum + category.bytes, 0),
    categories, volumes: [...volumes.values()], partial, measuredAt: new Date().toISOString(),
  };
}

/** Coalesce simultaneous refreshes; a later refresh always measures again. */
export function storageUsageReader(paths: StoragePaths) {
  let pending: Promise<ServerStorageStats> | undefined;
  return () => pending ??= collectStorageUsage(paths).finally(() => { pending = undefined; });
}
