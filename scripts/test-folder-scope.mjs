import test from 'node:test';
import assert from 'node:assert/strict';
import { folderCourseScope } from '../packages/study-core/src/utils/folderScope.ts';

const folders = [{ id: 1 }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }, { id: 4 }];
const courses = [{ id: 'root', folderId: 1 }, { id: 'child', folderId: 2 }, { id: 'deep', folderId: 3 }, { id: 'other', folderId: 4 }, { id: 'loose' }];
test('projects include all descendant courses, not just five references', () => {
  assert.deepEqual([...folderCourseScope(folders, courses, 1)], ['root', 'child', 'deep']);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: String(i), folderId: 1 }));
  assert.equal(folderCourseScope(folders, many, 1).size, 12);
});
test('no project means whole library; empty or deleted project never falls back to whole library', () => {
  assert.equal(folderCourseScope(folders, courses), null);
  assert.equal(folderCourseScope(folders, courses, 99).size, 0);
  assert.equal(folderCourseScope([{ id: 9 }], courses, 9).size, 0);
});
test('malformed legacy cycles cannot hang project traversal', () => {
  assert.deepEqual([...folderCourseScope([{ id: 1, parentId: 2 }, { id: 2, parentId: 1 }], courses, 1)], ['root', 'child']);
});
