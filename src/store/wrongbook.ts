import Dexie, { liveQuery } from 'dexie';
import { db } from './db';
import type { QuizQuestion } from '../harness/quiz';
import { applyAttempt, EMPTY_WRONGBOOK, migrateWrongbook, parseWrongbook, questionId, writeQuestion,
  type Attempt, type QuestionSource, type WrongQuestion } from '../study/wrongbook';
import { WRONGBOOK_FILE_NAME, WRONGBOOK_MATERIAL_ID } from '../study/wrongbookFile';
import { extractMdUnits, MD_MIME } from '../materials/md';
import { reindexMaterial, type MaterialParseResult } from '../materials/reindex';
import { useLibraryRevision } from '../pipelines/folderPlan';
import { saveMarkdownMaterial } from '../materials/markdownFile';

/** One Markdown Blob is the only source of truth; no parallel question table. */
const FILE_ID = WRONGBOOK_MATERIAL_ID;
export async function readWrongbook(): Promise<string> {
  const row = await db.files.get(FILE_ID);
  return row ? Dexie.waitFor(row.blob.text()) : EMPTY_WRONGBOOK;
}
export function observeWrongbook(next: (markdown: string) => void, error: (e: unknown) => void) {
  return liveQuery(readWrongbook).subscribe({ next, error });
}

/** Must be called inside the files/videos/materialBlocks transaction. */
async function persist(markdown: string): Promise<MaterialParseResult> {
  const blob = new Blob([markdown], { type: `${MD_MIME};charset=utf-8` });
  const material = await db.videos.get(FILE_ID);
  if (!material) {
    await db.videos.put({ id: FILE_ID, name: WRONGBOOK_FILE_NAME, kind: 'material', materialFormat: 'md',
      mimeType: MD_MIME, duration: 0, size: blob.size, status: 'new', coverState: 'pending', createdAt: Date.now() });
  }
  await db.files.put({ id: FILE_ID, blob });
  await db.videos.update(FILE_ID, { size: blob.size, fileDeleted: undefined, lastUnit: undefined });
  return reindexMaterial(FILE_ID, 'md', extractMdUnits(markdown), null);
}

async function mutate(update: (markdown: string) => string, create = false): Promise<void> {
  let changed = false;
  // IndexedDB serializes read-modify-write across tabs and commits the whole file atomically.
  await db.transaction('rw', db.files, db.videos, db.materialBlocks, async () => {
    const file = await db.files.get(FILE_ID);
    const material = await db.videos.get(FILE_ID);
    const markdown = await readWrongbook();
    const base = /<!-- wrongbook:v[12] -->/.test(markdown)
      ? migrateWrongbook(markdown) : `${markdown.trimEnd()}\n\n<!-- wrongbook:v2 -->\n`;
    const result = update(base);
    if (result !== markdown || (!material && (file || create)) || (!file && create)) {
      await persist(result);
      changed = true;
    }
  });
  if (changed) useLibraryRevision.getState().bump();
}

/** Also registers legacy archives as ordinary library materials. No new empty file on startup. */
export async function ensureWrongbookMaterial(create = false): Promise<void> {
  const row = await db.files.get(FILE_ID);
  if (!row && !create) return;
  const text = row ? await row.blob.text() : EMPTY_WRONGBOOK;
  const migrated = text.includes('<!-- wrongbook:v1 -->') ? migrateWrongbook(text) : text;
  if (migrated !== text || !await db.videos.get(FILE_ID))
    await saveMarkdownMaterial(FILE_ID, migrated, row ? text : '', WRONGBOOK_FILE_NAME);
}

/** The ordinary Markdown editor writes the same file, not an OPFS or JSON shadow copy. */
export async function saveWrongbookMarkdown(markdown: string, expectedMarkdown: string): Promise<MaterialParseResult> {
  return saveMarkdownMaterial(FILE_ID, markdown, expectedMarkdown);
}

export async function recordWrongbookAttempt(question: QuizQuestion, source: QuestionSource, attempt: Attempt, existingId?: string): Promise<void> {
  const id = existingId ?? await questionId(question, source);
  await mutate((markdown) => {
    const entry = parseWrongbook(markdown).find((q) => q.id === id);
    if (existingId && !entry) throw new Error('复习的题目已不存在，请刷新错题本。');
    const updated = applyAttempt(entry, id, question, source, attempt);
    return updated && updated !== entry ? writeQuestion(markdown, updated) : markdown;
  });
}

export async function setWrongbookStatus(id: string, status: WrongQuestion['status']): Promise<void> {
  await mutate((markdown) => {
    const entry = parseWrongbook(markdown).find((q) => q.id === id);
    if (!entry) throw new Error('错题不存在。');
    return writeQuestion(markdown, { ...entry, status });
  });
}

/** Merge without silently overwriting another device's divergent review history. */
export async function importWrongbook(incoming: string): Promise<void> {
  incoming = migrateWrongbook(incoming);
  const imported = parseWrongbook(incoming);
  await mutate((markdown) => {
    const current = parseWrongbook(markdown);
    if (!current.length && markdown === EMPTY_WRONGBOOK) return incoming;
    for (const entry of imported) {
      const old = current.find((q) => q.id === entry.id);
      if (old && JSON.stringify(old) !== JSON.stringify(entry))
        throw new Error(`题目 ${entry.id} 的记录有冲突，未导入。请保留两份文件后核对。`);
    }
    return imported.reduce((md, entry) => current.some((q) => q.id === entry.id) ? md : writeQuestion(md, entry), markdown);
  });
}
