import { isDeepStrictEqual } from 'node:util';
import type { CloudRecords } from '../../cloud/records.js';

const fields: Record<string, string> = {
  videos: 'id name size mimeType duration createdAt status lastPosition finished pinned folderId kind materialFormat unitCount lastUnit htmlView skillOverride',
  folders: 'id name createdAt parentId color',
  segments: 'id videoId idx start end text status cues',
  materialBlocks: 'id materialId idx unit unitLabel text kind',
  handouts: 'id videoId createdAt title blob outlineJson sectionsJson usedSkills readPos',
  cards: 'id videoId q a time status createdAt',
  studyDays: 'date seconds updatedAt',
  courseFiles: 'id videoId fileId name mimeType size createdAt',
  files: 'id blob',
  subtitleTracks: 'id videoId lang lanDoc primary cues',
  comments: 'id videoId time author role text parentId createdAt',
  danmakus: 'id videoId time text',
};
const numeric = new Set('size duration createdAt lastPosition finished pinned folderId unitCount lastUnit parentId idx start end status time seconds updatedAt primary unit'.split(' '));
const structured = new Set('blob cues usedSkills readPos skillOverride'.split(' '));

export function validateStudyMutation(records: CloudRecords, owner: string, table: string, key: string | number, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (!fields[table]) throw new Error('table_not_available');
  if (!after) return;
  for (const [field, value] of Object.entries(after)) {
    // Preserve unfamiliar historical fields unchanged; never let the model add
    // arbitrary configuration-shaped fields through a learning mutation.
    if (before && isDeepStrictEqual(before[field], value)) continue;
    const type = structured.has(field) ? 'object' : (numeric.has(field) && !(table === 'videos' && field === 'status')) || (field === 'id' && !['videos', 'files', 'courseFiles'].includes(table)) ? 'number' : 'string';
    if (!fields[table].split(' ').includes(field) || typeof value !== type || value === null) throw new Error('invalid_business_field');
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new Error('invalid_business_number');
    if (typeof value === 'string' && value.length > 100000) throw new Error('business_text_too_large');
  }
  for (const field of ['videoId', 'materialId']) {
    if (after[field] !== undefined && !records.get(owner, 'videos', after[field] as string)) throw new Error('course_not_found');
    if (before && after[field] !== before[field]) throw new Error('course_relation_immutable');
  }
  if (after.folderId !== undefined && !records.get(owner, 'folders', after.folderId as number)) throw new Error('folder_not_found');
  if (table === 'folders' && after.parentId !== undefined) {
    let parent: unknown = after.parentId;
    const seen = new Set<unknown>([key]);
    while (parent !== undefined) {
      if (seen.has(parent) || seen.size > 100) throw new Error('folder_cycle');
      seen.add(parent);
      const folder = records.get(owner, 'folders', parent as number);
      if (!folder) throw new Error('folder_not_found');
      parent = folder.parentId;
    }
  }
  if (after.start !== undefined && after.end !== undefined && Number(after.end) < Number(after.start)) throw new Error('invalid_time_range');
  if (table === 'cards' && after.status !== undefined && ![0, 1, 2].includes(Number(after.status))) throw new Error('invalid_card_status');
  if (table === 'segments' && after.status !== undefined && ![0, 1].includes(Number(after.status))) throw new Error('invalid_segment_status');
  if (table === 'videos' && after.status !== undefined && !['new', 'transcribing', 'transcribed', 'error'].includes(String(after.status))) throw new Error('invalid_course_status');
  if (table === 'studyDays' && (typeof after.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(after.date) || Number(after.seconds) > 86400)) throw new Error('invalid_study_day');
  if (table === 'comments' && after.parentId !== undefined) {
    const parent = records.get(owner, 'comments', after.parentId as number);
    if (!parent || parent.videoId !== after.videoId || after.parentId === key) throw new Error('invalid_comment_parent');
  }
}
