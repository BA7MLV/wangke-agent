import Dexie from 'dexie';
import { db } from '../store/db';
import { CLOUD_TABLES } from '../../packages/contracts/src/cloud';
import { saveCourseFile } from '../store/fileStore';
import { flushCloud } from './sync';
import { migratePreferences } from './preferences';

export async function migrateLocalData(progress: (message: string) => void) {
  await flushCloud();
  const prior = await db.table('_cloudMeta').get('migration');
  if (prior?.value === 'done') throw new Error('此浏览器数据已导入');
  if (!prior && (await Promise.all(Object.keys(CLOUD_TABLES).filter(t => !['skills', 'skillRefs', 'preferences', 'studyDays'].includes(t)).map(t => db.table(t).count()))).some(n => n > 0)) throw new Error('请在空的云端资料库执行首次导入，避免旧主键覆盖云端记录');
  const legacy = new Dexie('wangke');
  await legacy.open();
  try {
    await db.table('_cloudMeta').put({ id: 'migration', value: 'running' });
    await migratePreferences();
    const tables = legacy.tables.filter(t => Object.hasOwn(CLOUD_TABLES, t.name) && t.name !== 'files');
    for (const table of tables) {
      const done = await db.table('_cloudMeta').get(`migration:${table.name}`);
      if (done) continue;
      progress(`正在导入 ${table.name}…`);
      const rows = await table.toArray();
      for (let i = 0; i < rows.length; i += 100) {
        await db.table(table.name).bulkPut(rows.slice(i, i + 100));
        await flushCloud();
      }
      await db.table('_cloudMeta').put({ id: `migration:${table.name}`, value: true });
    }
    const files = new Map<string, Blob>((await legacy.table('files').toArray()).map(r => [r.id, r.blob]));
    const root = await navigator.storage?.getDirectory?.();
    for (const directory of ['videos', 'materials']) {
      const dir = await root?.getDirectoryHandle(directory).catch(() => null);
      if (!dir) continue;
      for await (const [id, handle] of (dir as any).entries()) {
        if (handle.kind === 'file' && !files.has(id)) files.set(id, await handle.getFile());
      }
    }
    let count = 0;
    const courseIds = new Set((await legacy.table('videos').toArray()).map(row => row.id));
    for (const [id, blob] of files) {
      progress(`正在上传文件 ${++count}/${files.size}`);
      if (courseIds.has(id)) {
        if (!await db.table('courseFiles').get(id)) await saveCourseFile(id, blob);
      } else if (!await db.files.get(id)) {
        // Chat attachments use files directly, rather than the course-file index.
        await db.files.put({ id, blob });
        await flushCloud();
      }
    }
    await flushCloud();
    await db.table('_cloudMeta').put({ id: 'migration', value: 'done' });
  } finally { legacy.close(); }
}
