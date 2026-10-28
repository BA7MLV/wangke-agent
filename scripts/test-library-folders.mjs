import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { db } from '../apps/web/src/store/db.ts';
import { folderAncestors, validFolderDrop, moveLibraryItems, undoLibraryMove } from '../apps/web/src/materials/libraryFolders.ts';

after(() => db.close());
test('nested mixed moves preserve descendants and reject cycles atomically', async () => {
  await db.folders.bulkAdd([
    { id: 1, name: 'A', createdAt: 1 },
    { id: 2, name: 'B', createdAt: 1 },
    { id: 3, name: 'Child', createdAt: 1, parentId: 1 },
  ]);
  await db.videos.bulkAdd([
    { id: 'inside', name: 'Inside', folderId: 3, createdAt: 1 },
    { id: 'loose', name: 'Loose', createdAt: 1 },
  ]);
  assert.deepEqual(folderAncestors(await db.folders.toArray(), 3).map((f) => f.id), [1, 3]);
  assert.equal(validFolderDrop(await db.folders.toArray(), ['folder:1'], 3), false);
  await assert.rejects(moveLibraryItems(['file:loose', 'folder:1'], 3));
  assert.equal((await db.videos.get('loose')).folderId, undefined);
  const placements = await moveLibraryItems(['folder:1', 'folder:3', 'file:inside', 'file:loose'], 2);
  assert.equal((await db.folders.get(1)).parentId, 2);
  assert.equal((await db.folders.get(3)).parentId, 1);
  assert.equal((await db.videos.get('inside')).folderId, 3);
  assert.equal((await db.videos.get('loose')).folderId, 2);
  await undoLibraryMove(placements);
  assert.equal((await db.folders.get(1)).parentId, undefined);
  assert.equal((await db.folders.get(3)).parentId, 1);
  assert.equal((await db.videos.get('inside')).folderId, 3);
  assert.equal((await db.videos.get('loose')).folderId, undefined);
  await moveLibraryItems(['folder:1', 'file:loose'], 2);
  await moveLibraryItems(['file:loose'], 3);
  await assert.rejects(undoLibraryMove(placements));
  assert.equal((await db.folders.get(1)).parentId, 2, 'failed undo must roll back its earlier writes');
  assert.equal((await db.videos.get('loose')).folderId, 3);
  await moveLibraryItems(['folder:1'], null);
  await moveLibraryItems(['file:loose'], null);
  assert.equal((await db.folders.get(1)).parentId, undefined);
  assert.equal((await db.videos.get('loose')).folderId, undefined);
  await assert.rejects(moveLibraryItems(['folder:1'], 1));
  await assert.rejects(moveLibraryItems(['file:loose'], 999));
});
