import { isDeepStrictEqual } from 'node:util';
import type { CloudRecords } from '../../cloud/records.js';

type Check = (value: unknown) => boolean;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text: Check = v => typeof v === 'string' && v.length <= 100000;
const label: Check = v => text(v) && String(v).trim().length > 0 && String(v).length <= 1000;
const number: Check = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer: Check = v => number(v) && Number.isSafeInteger(v);
const positive: Check = v => integer(v) && Number(v) > 0;
const timestamp: Check = v => integer(v) && Number(v) <= 8640000000000000;
const oneOf = (...values: unknown[]): Check => v => values.includes(v);
const array = (check: Check): Check => v => Array.isArray(v) && v.length <= 10000 && v.every(check);
const shape = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => v => obj(v) && Object.entries(required).every(([k, check]) => Object.hasOwn(v, k) && check(v[k])) && Object.entries(v).every(([k, value]) => (required[k] ?? optional[k])?.(value) === true);
const cue: Check = v => shape({ start: number, end: number, text })(v) && obj(v) && Number(v.end) >= Number(v.start);
const block: Check = v => {
  if (!obj(v)) return false;
  const caption = { caption: text };
  switch (v.type) {
    case 'lead': case 'para': case 'h2': case 'note': return shape({ type: text, text })(v);
    case 'list': return shape({ type: text, ordered: v => typeof v === 'boolean', items: array(text) })(v);
    case 'figure': return shape({ type: text, ts: number }, caption)(v);
    case 'table': return shape({ type: text, header: array(text), rows: array(array(text)) }, caption)(v) && (v.rows as unknown[][]).every(r => r.length === (v.header as unknown[]).length);
    default: return false;
  }
};
const json = (check: Check): Check => v => { if (!text(v)) return false; try { return check(JSON.parse(String(v))); } catch { return false; } };
const blob = shape({ $file: label }, { type: text });
const clock: Check = v => typeof v === 'string' && /^(?:\d{1,3}:)?\d{1,2}:[0-5]\d$/.test(v);
const clockSeconds = (v: unknown) => String(v).split(':').reduce((n, part) => n * 60 + Number(part), 0);
// Text-source handouts have headings without video time ranges; video outlines
// carry a complete start/end pair. Both are produced by the real pipelines.
const outlineSection: Check = v => shape({ heading: text }, { start: clock, end: clock, points: array(text) })(v) && obj(v) && (v.start === undefined && v.end === undefined || v.start !== undefined && v.end !== undefined && clockSeconds(v.end) >= clockSeconds(v.start));
const schemas: Record<string, { required: Record<string, Check>; optional?: Record<string, Check> }> = {
  videos: { required: { id: label, name: label, size: integer, mimeType: text, duration: number, createdAt: timestamp, status: oneOf('new', 'transcribing', 'transcribed', 'error') }, optional: { lastPosition: number, finished: oneOf(0, 1), pinned: oneOf(0, 1), folderId: positive, kind: oneOf('video', 'material'), materialFormat: oneOf('pdf', 'docx', 'md', 'html'), unitCount: integer, lastUnit: integer, htmlView: oneOf('raw', 'blocks'), skillOverride: shape({ pin: array(v => Number.isSafeInteger(v)), drop: array(v => Number.isSafeInteger(v)) }), fileDeleted: oneOf(1), scanned: oneOf(1), empty: oneOf(1), dominantColor: v => typeof v === 'string' && /^#[a-fA-F0-9]{6}$/.test(v), coverState: oneOf('pending', 'done', 'skipped'), biliSource: shape({ bvid: label, aid: positive, cid: positive, page: positive }) } },
  folders: { required: { id: positive, name: label, createdAt: timestamp }, optional: { parentId: positive, color: oneOf('blue', 'green', 'yellow', 'orange', 'red', 'purple', 'gray') } },
  segments: { required: { id: positive, videoId: label, idx: integer, start: number, end: number, text, status: oneOf(0, 1) }, optional: { cues: array(cue) } },
  materialBlocks: { required: { id: positive, materialId: label, idx: integer, unit: positive, unitLabel: text, text, kind: oneOf('body', 'title', 'table', 'caption') } },
  handouts: { required: { id: positive, videoId: label, createdAt: timestamp, title: label, blob, outlineJson: json(shape({ title: text, summary: text, sections: array(outlineSection) })) }, optional: { sectionsJson: json(array(shape({ heading: text, blocks: array(block) }))), usedSkills: array(text), readPos: shape({ anchor: v => typeof v === 'string' && /^(sum|h\d+|s\d+b\d+)$/.test(v), offset: v => typeof v === 'number' && Number.isFinite(v) }) } },
  cards: { required: { id: positive, videoId: label, q: label, a: label, time: number, status: oneOf(0, 1, 2), createdAt: timestamp } },
  studyDays: { required: { date: v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, seconds: v => number(v) && Number(v) <= 86400, updatedAt: timestamp } },
  // courseFiles is keyed by the course id; it has no separate videoId.
  courseFiles: { required: { id: label, fileId: label, mimeType: text, size: integer, directory: oneOf('videos', 'materials') } },
  files: { required: { id: label, blob } },
  subtitleTracks: { required: { id: positive, videoId: label, lang: label, lanDoc: label, cues: array(cue) }, optional: { primary: oneOf(0, 1) } },
  comments: { required: { id: positive, videoId: label, time: number, author: label, role: oneOf('ask', 'answer', 'note'), text, createdAt: timestamp }, optional: { parentId: positive } },
  danmakus: { required: { id: positive, videoId: label, time: number, text } },
};

export function validateStudyMutation(records: CloudRecords, owner: string, table: string, key: string | number, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const schema = schemas[table];
  if (!schema) throw new Error('table_not_available');
  const current = records.get(owner, table, key);
  if (before !== null && !obj(before) || after !== null && !obj(after)) throw new Error('invalid_business_record');
  if (!after) return;
  const known = { ...schema.required, ...schema.optional };
  for (const [field, check] of Object.entries(schema.required)) if (!Object.hasOwn(after, field) || !check(after[field])) throw new Error('invalid_business_required_field');
  for (const field of new Set([...Object.keys(current ?? {}), ...Object.keys(before ?? {}), ...Object.keys(after)])) {
    if (['__proto__', 'constructor', 'prototype'].includes(field)) throw new Error('invalid_business_field');
    if (known[field]) { if (Object.hasOwn(after, field) && !known[field](after[field])) throw new Error('invalid_business_field'); }
    // Unknown legacy fields must actually exist in storage. A fabricated
    // before cannot smuggle a new field or remove/alter a persisted one.
    else if (!current || !Object.hasOwn(current, field) || !isDeepStrictEqual(current[field], after[field]) || !Object.hasOwn(after, field)) throw new Error('invalid_business_field');
  }
  if (after[table === 'studyDays' ? 'date' : 'id'] !== key) throw new Error('invalid_record_key');
  for (const field of ['videoId', 'materialId']) {
    if (after[field] !== undefined && !records.get(owner, 'videos', String(after[field]))) throw new Error('course_not_found');
    if (current && after[field] !== current[field]) throw new Error('course_relation_immutable');
  }
  if (['files', 'courseFiles'].includes(table) && !records.get(owner, 'videos', String(after.id))) throw new Error('course_not_found');
  if (after.folderId !== undefined && !records.get(owner, 'folders', Number(after.folderId))) throw new Error('folder_not_found');
  if (table === 'folders') {
    let parent = after.parentId;
    const seen = new Set<unknown>([key]);
    while (parent !== undefined) {
      if (seen.has(parent) || seen.size > 100) throw new Error('folder_cycle');
      seen.add(parent);
      const folder = records.get(owner, 'folders', Number(parent));
      if (!folder) throw new Error('folder_not_found');
      parent = folder.parentId;
    }
  }
  if (after.start !== undefined && after.end !== undefined && Number(after.end) < Number(after.start)) throw new Error('invalid_time_range');
  if (table === 'comments' && after.parentId !== undefined) {
    const parent = records.get(owner, 'comments', Number(after.parentId));
    if (!parent || parent.videoId !== after.videoId || after.parentId === key) throw new Error('invalid_comment_parent');
  }
  if (after.blob !== undefined || table === 'courseFiles') {
    const id = table === 'courseFiles' ? after.fileId : (after.blob as Record<string, unknown>).$file;
    if (!records.ownedFile(owner, String(id))) throw new Error('file_not_found');
  }
}
