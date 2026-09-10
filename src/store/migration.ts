import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { db } from './db';
import { useSettings } from './settings';

/**
 * 数据迁移：导出 / 导入迁移包（不含视频本体，含讲义帧）。
 *
 * 包格式：单个 zip——
 *   manifest.json  { format: 1, dbVersion, exportedAt, counts }
 *   db.json        全部业务表（Blob/ArrayBuffer 以 base64 标记对象编码）
 *   settings.json  设置子集（不含 API Key）
 *
 * 冲突策略：videos 按 id 匹配，已存在则整条跳过（连同其子表）；
 * folders 按名字合并；skills 按 name 跳过；自增主键全部交由浏览器
 * 重新分配，旧 id 经映射重挂（sessionId / folderId / skillId）。
 * 迁入的视频置 fileDeleted: 1，沿用现有「重新导入视频本体」机制。
 *
 * 设计文档：docs/plans/2026-09-09-data-migration-design.md
 */

const FORMAT = 1;
const MANIFEST = 'manifest.json';
const DB_FILE = 'db.json';
const SETTINGS_FILE = 'settings.json';

/** 参与迁移的表 */
const TABLES = [
  'videos',
  'folders',
  'segments',
  'frames',
  'handouts',
  'chatSessions',
  'chats',
  'danmakus',
  'cards',
  'skills',
  'skillRefs',
] as const;

export interface MigrationManifest {
  format: number;
  dbVersion: number;
  exportedAt: number;
  counts: Record<string, number>;
}

// ---------- base64 ----------

function bytesToBase64(bytes: Uint8Array): string {
  // 分块避免 String.fromCharCode 大数组参数上限
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

// ---------- 行序列化 ----------

async function encodeValue(v: unknown): Promise<unknown> {
  if (v instanceof Blob) {
    const buf = new Uint8Array(await v.arrayBuffer());
    return { $blob: bytesToBase64(buf), type: v.type };
  }
  if (v instanceof ArrayBuffer) {
    return { $bin: bytesToBase64(new Uint8Array(v)) };
  }
  if (Array.isArray(v)) return Promise.all(v.map(encodeValue));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = await encodeValue(val);
    return out;
  }
  return v;
}

function decodeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeValue);
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    if (typeof rec.$blob === 'string') {
      const bytes = base64ToBytes(rec.$blob);
      return new Blob([bytes.buffer as ArrayBuffer], { type: (rec.type as string) || '' });
    }
    if (typeof rec.$bin === 'string') {
      const bytes = base64ToBytes(rec.$bin);
      return bytes.buffer as ArrayBuffer;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec)) out[k] = decodeValue(val);
    return out;
  }
  return v;
}

async function encodeRow(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await encodeValue(row)) as Record<string, unknown>;
}

function decodeRow(row: Record<string, unknown>): Record<string, unknown> {
  return decodeValue(row) as Record<string, unknown>;
}

// ---------- 导出 ----------

/** 序列化全部迁移表 + 设置，打成 zip 返回 */
export async function exportMigrationZip(onStep?: (text: string) => void): Promise<Blob> {
  onStep?.('正在读取数据库…');
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = await db.table(t).toArray();
    counts[t] = rows.length;
    data[t] = [];
    onStep?.(`正在序列化 ${t}（${rows.length} 条）…`);
    for (const row of rows) {
      data[t].push(await encodeRow(row));
    }
  }

  const s = useSettings.getState();
  const settings = {
    baseUrl: s.baseUrl,
    asrModel: s.asrModel,
    llmModel: s.llmModel,
    embedModel: s.embedModel,
    visionModel: s.visionModel,
    favorites: s.favorites,
    contextWindow: s.contextWindow,
    asrConcurrency: s.asrConcurrency,
    thinkingEnabled: s.thinkingEnabled,
    thinkingEffort: s.thinkingEffort,
    captionScale: s.captionScale,
    agentRounds: s.agentRounds,
    danmakuEnabled: s.danmakuEnabled,
    customRates: s.customRates,
  };

  const manifest: MigrationManifest = {
    format: FORMAT,
    dbVersion: db.verno,
    exportedAt: Date.now(),
    counts,
  };

  onStep?.('正在打包…');
  const zipped = zipSync(
    {
      [MANIFEST]: strToU8(JSON.stringify(manifest, null, 2)),
      [DB_FILE]: strToU8(JSON.stringify(data)),
      [SETTINGS_FILE]: strToU8(JSON.stringify(settings, null, 2)),
    },
    // STORE（level 0）：主体为 base64 后的二进制，压缩收益小且大文件
    // deflate 很慢；iPad Safari 上 CPU 比体积更宝贵
    { level: 0 },
  );
  return new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
}

// ---------- 导入 ----------

export interface MigrationPreview {
  manifest: MigrationManifest;
  /** 本库已存在、导入时将被跳过的视频数 */
  existingVideos: number;
  /** 本库当前视频总数 */
  currentVideos: number;
}

interface ParsedPackage {
  manifest: MigrationManifest;
  data: Record<string, Record<string, unknown>[]>;
  settings: Record<string, unknown> | null;
}

async function parsePackage(file: Blob): Promise<ParsedPackage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('文件不是有效的 zip 包');
  }
  if (!files[MANIFEST] || !files[DB_FILE]) {
    throw new Error('这不是网课助手迁移包（缺少 manifest.json）');
  }
  const manifest = JSON.parse(strFromU8(files[MANIFEST])) as MigrationManifest;
  if (typeof manifest.format !== 'number' || manifest.format > FORMAT) {
    throw new Error('迁移包由更新版本的应用导出，请升级后再导入');
  }
  const data = JSON.parse(strFromU8(files[DB_FILE])) as ParsedPackage['data'];
  const settings = files[SETTINGS_FILE]
    ? (JSON.parse(strFromU8(files[SETTINGS_FILE])) as Record<string, unknown>)
    : null;
  return { manifest, data, settings };
}

/** 读取迁移包并返回预览信息（供确认框展示），不写库 */
export async function previewMigrationZip(file: Blob): Promise<MigrationPreview> {
  const pkg = await parsePackage(file);
  const incomingIds = new Set((pkg.data.videos ?? []).map((v) => v.id as string));
  const existing = await db.videos.toArray();
  const existingVideos = existing.filter((v) => incomingIds.has(v.id)).length;
  return { manifest: pkg.manifest, existingVideos, currentVideos: existing.length };
}

export interface ImportResult {
  videosAdded: number;
  videosSkipped: number;
  rowsAdded: Record<string, number>;
  settingsRestored: boolean;
}

/** 执行导入（假定用户已确认） */
export async function importMigrationZip(
  file: Blob,
  opts: { restoreSettings: boolean },
  onStep?: (text: string) => void,
): Promise<ImportResult> {
  const pkg = await parsePackage(file);
  const data = pkg.data;
  const result: ImportResult = {
    videosAdded: 0,
    videosSkipped: 0,
    rowsAdded: {},
    settingsRestored: false,
  };
  const bump = (t: string, n: number) => {
    result.rowsAdded[t] = (result.rowsAdded[t] ?? 0) + n;
  };

  // 1) folders：按名字合并，建立 旧id → 新id 映射
  onStep?.('正在导入文件夹…');
  const folderIdMap = new Map<number, number>();
  const existingFolders = await db.folders.toArray();
  const folderByName = new Map(existingFolders.map((f) => [f.name, f.id!]));
  for (const raw of data.folders ?? []) {
    const row = decodeRow(raw) as { id?: number; name: string; createdAt: number };
    const oldId = row.id;
    const hit = folderByName.get(row.name);
    if (hit != null) {
      if (oldId != null) folderIdMap.set(oldId, hit);
      continue;
    }
    const rest: Record<string, unknown> = { ...row };
    delete rest.id;
    const newId = (await db.folders.add(rest as never)) as number;
    folderByName.set(row.name, newId);
    if (oldId != null) folderIdMap.set(oldId, newId);
    bump('folders', 1);
  }

  // 2) videos：按 id 跳过已存在；新视频置 fileDeleted 并重挂 folderId
  onStep?.('正在导入视频元数据…');
  const newVideoIds = new Set<string>();
  for (const raw of data.videos ?? []) {
    const row = decodeRow(raw) as { id: string; folderId?: number; lastPosition?: number; [k: string]: unknown };
    const exists = await db.videos.get(row.id);
    if (exists) {
      result.videosSkipped++;
      continue;
    }
    const folderId = row.folderId != null ? folderIdMap.get(row.folderId) : undefined;
    const clean: Record<string, unknown> = { ...row };
    // 旧播放进度对新设备无意义（视频本体缺失，从头开始）
    delete clean.lastPosition;
    delete clean.folderId;
    const out: Record<string, unknown> = { ...clean, fileDeleted: 1 };
    if (folderId != null) out.folderId = folderId;
    await db.videos.add(out as never);
    newVideoIds.add(row.id);
    bump('videos', 1);
  }
  result.videosAdded = newVideoIds.size;

  // 3) 简单子表：只跟随新视频写入，剥自增主键后 bulkAdd
  const simpleTables = ['segments', 'frames', 'handouts', 'danmakus', 'cards'] as const;
  for (const t of simpleTables) {
    const rows = data[t] ?? [];
    onStep?.(`正在导入 ${t}（${rows.length} 条）…`);
    const batch: Record<string, unknown>[] = [];
    for (const raw of rows) {
      const row = decodeRow(raw);
      if (!newVideoIds.has(row.videoId as string)) continue;
      delete row.id;
      batch.push(row);
    }
    if (batch.length) {
      await db.table(t).bulkAdd(batch);
      bump(t, batch.length);
    }
  }

  // 4) chatSessions → chats：sessionId 链经 旧id→新id 映射重挂
  onStep?.('正在导入问答会话…');
  const sessionIdMap = new Map<number, number>();
  for (const raw of data.chatSessions ?? []) {
    const row = decodeRow(raw);
    if (!newVideoIds.has(row.videoId as string)) continue;
    const oldId = row.id as number | undefined;
    delete row.id;
    const newId = (await db.chatSessions.add(row as never)) as number;
    if (oldId != null) sessionIdMap.set(oldId, newId);
    bump('chatSessions', 1);
  }
  onStep?.('正在导入聊天记录…');
  const chatBatch: Record<string, unknown>[] = [];
  for (const raw of data.chats ?? []) {
    const row = decodeRow(raw);
    if (!newVideoIds.has(row.videoId as string)) continue;
    delete row.id;
    const sid = sessionIdMap.get(row.sessionId as number);
    if (sid != null) row.sessionId = sid;
    chatBatch.push(row);
  }
  if (chatBatch.length) {
    await db.chats.bulkAdd(chatBatch as never[]);
    bump('chats', chatBatch.length);
  }

  // 5) skills / skillRefs：按 name 跳过（内置技能永远跳过），skillId 重挂
  onStep?.('正在导入技能…');
  const existingSkills = await db.skills.toArray();
  const skillByName = new Map(existingSkills.map((s) => [s.name, s.id!]));
  const skillIdMap = new Map<number, number>();
  for (const raw of data.skills ?? []) {
    const row = decodeRow(raw) as { id?: number; name: string; builtin?: 0 | 1 };
    const oldId = row.id;
    if (row.builtin === 1 || skillByName.has(row.name)) {
      if (oldId != null && skillByName.has(row.name)) skillIdMap.set(oldId, skillByName.get(row.name)!);
      continue;
    }
    const clean: Record<string, unknown> = { ...row };
    delete clean.id;
    const newId = (await db.skills.add(clean as never)) as number;
    skillByName.set(row.name, newId);
    if (oldId != null) skillIdMap.set(oldId, newId);
    bump('skills', 1);
  }
  const refBatch: Record<string, unknown>[] = [];
  for (const raw of data.skillRefs ?? []) {
    const row = decodeRow(raw);
    delete row.id;
    const sid = skillIdMap.get(row.skillId as number);
    if (sid == null) continue; // 对应技能被跳过则引用也无归属
    row.skillId = sid;
    refBatch.push(row);
  }
  if (refBatch.length) {
    await db.skillRefs.bulkAdd(refBatch as never[]);
    bump('skillRefs', refBatch.length);
  }

  // 6) 设置：勾选时覆盖（apiKey 保持本机现值，密钥不随包走）
  if (opts.restoreSettings && pkg.settings) {
    useSettings.getState().update(pkg.settings as never);
    result.settingsRestored = true;
  }

  return result;
}
