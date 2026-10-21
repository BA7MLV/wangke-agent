import type { VideoRow } from '../store/db';

/** 稳定资源路径指向普通 Markdown 资料，不再维护另一份讲义正文或索引。 */
export function handoutFileOf(course: Pick<VideoRow, 'id' | 'name' | 'folderId'>) {
  return {
    id: `__course_handout__${encodeURIComponent(course.id)}`,
    path: `/courses/${encodeURIComponent(course.id)}/handout.md`,
    name: `${course.name.replace(/\.(?:mp4|webm|mkv|mov|pdf|docx|md|html?)$/i, '')} · 讲义.md`,
    folderId: course.folderId,
  };
}
