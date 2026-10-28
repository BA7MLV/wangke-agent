import Dexie from 'dexie';
import { db } from '../store/db';
import { getMaterialFile } from '../store/fileStore';
import { extractMdUnits, MD_MIME } from './md';
import { reindexMaterial } from './reindex';
import { useLibraryRevision } from '../pipelines/folderPlan';
import { cloud } from '../cloud/state';
import { request } from '../api/serverClient';
import { flushCloud } from '../cloud/sync';

/** Ordinary Markdown persistence shared by editor and tools; no notebook schema. */
export async function saveMarkdownMaterial(id: string, text: string, expected?: string, name?: string,
  creation?: { folderId?: number; createOnly?: boolean }) {
  const reference = cloud.enabled && !cloud.worker && await db.table('courseFiles').get(id);
  const resource = reference?.resourceProjectId ? reference : null;
  if (resource) {
    const file = await getMaterialFile(id);
    const current = file ? await file.text() : '';
    if (creation?.createOnly || (expected !== undefined && current !== expected)) throw new Error('文件已发生变化，请重新打开后再编辑。');
    await request(`/resources/courses/${encodeURIComponent(id)}/text`, { method: 'POST', body: JSON.stringify({ text, expected: expected ?? current }) });
    await flushCloud();
  }
  const result = await db.transaction('rw', [db.files, db.videos, db.materialBlocks, db.table('courseFiles')], async () => {
    const row = await db.videos.get(id);
    if (row && (row.kind !== 'material' || row.materialFormat !== 'md')) throw new Error('只能修改 Markdown 资料。');
    const file = resource ? null : await Dexie.waitFor(getMaterialFile(id));
    if (creation?.createOnly && (row || file)) throw new Error('文件已存在，请先 read，再用 edits 修改。');
    const current = file ? await Dexie.waitFor(file.text()) : '';
    if (!resource && expected !== undefined && current !== expected) throw new Error('文件已在其他页面更新，请重新读取后再修改。');
    const blob = new Blob([text], { type: MD_MIME });
    if (!row) await db.videos.put({ id, name: name ?? id, folderId: creation?.folderId, kind: 'material', materialFormat: 'md',
      mimeType: MD_MIME, duration: 0, size: blob.size, status: 'new', coverState: 'pending', createdAt: Date.now() });
    if (!resource) await db.files.put({ id, blob });
    else await db.files.delete(id);
    await db.videos.update(id, { size: blob.size, lastUnit: undefined, fileDeleted: undefined, ...(resource ? { status: 'transcribed' as const } : {}) });
    return reindexMaterial(id, 'md', extractMdUnits(text), null);
  });
  useLibraryRevision.getState().bump();
  if (resource) await flushCloud();
  return result;
}
