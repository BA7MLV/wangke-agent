import type Dexie from 'dexie';
import type { Table } from 'dexie';

/** WebKit can lose its backing transaction after a tab has been suspended. */
export function isLostCloudTransaction(error: unknown): boolean {
  const seen = new Set<unknown>();
  const matches = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    try {
      const detail = value as { name?: string; message?: string; failures?: unknown[]; inner?: unknown; cause?: unknown };
      if (detail.name === 'BulkError' && detail.failures?.length) {
        // Do not retry a batch that also contains validation or constraint errors.
        return detail.failures.every(matches);
      }
      return (detail.name === 'UnknownError' && /without an in-progress transaction/i.test(detail.message ?? ''))
        || matches(detail.inner) || matches(detail.cause);
    } finally {
      seen.delete(value);
    }
  };
  return matches(error);
}

/** Only replay local database work, never network requests or other side effects. */
export async function cloudTransaction<T>(database: Dexie, tables: Table[], scope: () => Promise<T>): Promise<T> {
  const delays = [100, 400];
  for (let attempt = 0; ; attempt++) {
    try {
      return await database.transaction('rw', tables, scope);
    } catch (error) {
      if (!isLostCloudTransaction(error) || attempt >= delays.length) throw error;
      // Wait outside the rejected transaction; every retry gets a fresh transaction.
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}
