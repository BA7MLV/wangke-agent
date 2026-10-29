export type StorageCategoryId = 'database' | 'files' | 'workspaces' | 'system' | 'other';

export interface ServerStorageStats {
  /** Logical file sizes, counted once per inode, including SQLite sidecars. */
  totalBytes: number;
  categories: Array<{ id: StorageCategoryId; bytes: number }>;
  /** Filesystems containing the data; never sum capacities across bind mounts. */
  volumes: Array<{
    id: string;
    categories: StorageCategoryId[];
    capacity: { totalBytes: number; usedBytes: number; availableBytes: number } | null;
  }>;
  /** Unreadable entries or a scan limit: totals are only a lower bound. */
  partial: boolean;
  measuredAt: string;
}
