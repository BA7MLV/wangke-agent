import type { VideoRow } from '../store/db';

/** 与讲义一样，稳定别名只指向普通 Markdown 资料，正文不另存一份。 */
export function questionBankFileOf(course: Pick<VideoRow, 'id' | 'name' | 'folderId'>) {
  return {
    id: `__course_questions__${encodeURIComponent(course.id)}`,
    path: `/courses/${encodeURIComponent(course.id)}/questions.md`,
    name: `${course.name.replace(/\.(?:mp4|webm|mkv|mov|pdf|docx|md|html?)$/i, '')} · 题库.md`,
    folderId: course.folderId,
  };
}
