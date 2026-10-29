/** A selected folder includes its descendants. Missing/empty folders never mean the whole library. */
export function folderCourseScope(
  folders: Array<{ id?: number; parentId?: number }>,
  courses: Array<{ id: string; folderId?: number }>,
  folderId?: number,
): Set<string> | null {
  if (folderId == null) return null;
  const children = new Map<number, number[]>();
  for (const folder of folders) {
    if (folder.id == null || folder.parentId == null) continue;
    const siblings = children.get(folder.parentId) ?? [];
    siblings.push(folder.id);
    children.set(folder.parentId, siblings);
  }
  const ids = new Set<number>();
  const pending = folders.some(folder => folder.id === folderId) ? [folderId] : [];
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    if (ids.has(id)) continue;
    ids.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return new Set(courses.filter(course => course.folderId != null && ids.has(course.folderId)).map(course => course.id));
}
