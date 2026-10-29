import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CloudRecords } from '../cloud/records.js';
import { ProjectError } from './files.js';
import { importBotAttachments } from './attachments.js';
import type { ProjectRepository } from './repository.js';
import type { ResourceDirectory, ResourceEntry } from '@wangke/contracts/resources';

type Placement = { owner_id: string; course_id: string; project_id: string; path: string; identity: string; revision: string; source_file: string | null };
type Folder = { folder_id: number; project_id: string; path: string };
const cleanName = (name: string) => name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').replace(/^\.+$/, '_').slice(0, 70) || 'Untitled';
const join = (parent: string, name: string) => parent ? `${parent}/${name}` : name;
const formats: Record<string, string> = { md: 'md', markdown: 'md', pdf: 'pdf', docx: 'docx', html: 'html', htm: 'html' };
const video = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'flv', 'ts', 'm2ts', 'mpeg', 'mpg', 'wmv', '3gp', 'rmvb', 'rm']);
const mime: Record<string, string> = { md: 'text/markdown', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', html: 'text/html' };
const videoExtension: Record<string, string> = { 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv' };
const learningTables = ['videos', 'files', 'segments', 'subtitleTracks', 'frames', 'handouts', 'chats', 'chatSessions', 'materialBlocks', 'materialInk', 'covers', 'comments', 'danmakus', 'cards', 'courseFiles'];

/** Files are authoritative; learning records are stable IDs and derived indexes.
 * Existing project directories/grants stay in place. Legacy blobs are copied once,
 * never hard-linked or removed, and are no longer used as live editable copies. */
export class ResourceFiles {
  readonly records: CloudRecords;
  constructor(readonly projects: ProjectRepository, readonly filesDir: string) {
    this.records = new CloudRecords(projects.store);
    projects.onChange = (owner, id) => {
      const folder = this.db.prepare("SELECT folder_id FROM resource_folders WHERE owner_id=? AND project_id=? AND path='' ").get(owner, id) as { folder_id: number } | undefined;
      const row = folder && this.records.get(owner, 'folders', folder.folder_id);
      if (row) this.put(owner, 'folders', row.id, { ...row, name: projects.get(owner, id).name });
    };
  }
  private get db() { return this.projects.store.db; }
  private rows(owner: string, table: string): any[] {
    return (this.db.prepare('SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND value IS NOT NULL').all(owner, table) as { value: string }[]).map(r => JSON.parse(r.value));
  }
  private put(owner: string, table: string, key: string | number, after: Record<string, any> | null) {
    const before = this.records.get(owner, table, key);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const baseRevision = (this.db.prepare('SELECT revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, JSON.stringify(key)) as { revision: number } | undefined)?.revision;
    this.records.apply(owner, [{ id: crypto.randomUUID(), table, key, before, after, baseRevision }]);
  }
  private next(owner: string, table: string) { return this.rows(owner, table).reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1; }
  private defaultAgent(owner: string) {
    return this.projects.defaultAgent(owner);
  }
  root(owner: string) {
    return this.projects.resourceRoot(owner);
  }
  private folder(owner: string, id: number): Folder | undefined {
    return this.db.prepare('SELECT folder_id,project_id,path FROM resource_folders WHERE owner_id=? AND folder_id=?').get(owner, id) as Folder | undefined;
  }
  private folderId(owner: string, projectId: string, directory: string) {
    const existing = this.db.prepare('SELECT folder_id FROM resource_folders WHERE owner_id=? AND project_id=? AND path=?').get(owner, projectId, directory) as { folder_id: number } | undefined;
    if (existing) return existing.folder_id;
    if (!directory && projectId === this.root(owner)) return undefined;
    const parent = directory ? this.folderId(owner, projectId, path.posix.dirname(directory) === '.' ? '' : path.posix.dirname(directory)) : undefined;
    const id = this.next(owner, 'folders');
    this.put(owner, 'folders', id, { id, name: directory ? path.posix.basename(directory) : this.projects.get(owner, projectId).name, parentId: parent, createdAt: Date.now() });
    this.db.prepare('INSERT INTO resource_folders(owner_id,folder_id,project_id,path) VALUES(?,?,?,?)').run(owner, id, projectId, directory);
    return id;
  }
  private unique(projectId: string, directory: string, name: string) {
    const names = new Set(this.projects.files.list(projectId, directory).map(f => f.name));
    const ext = path.posix.extname(name), stem = name.slice(0, name.length - ext.length);
    let candidate = name, n = 2;
    while (names.has(candidate)) candidate = `${stem} (${n++})${ext}`;
    return join(directory, candidate);
  }
  placement(owner: string, id: string): Placement | undefined {
    return this.db.prepare('SELECT * FROM resource_files WHERE owner_id=? AND course_id=?').get(owner, id) as Placement | undefined;
  }
  private remember(owner: string, id: string, projectId: string, filename: string, source: string | null) {
    const opened = this.projects.files.open(projectId, filename);
    let identity: string;
    try { const stat = fs.fstatSync(opened.fd); identity = `${stat.dev}:${stat.ino}`; }
    finally { fs.closeSync(opened.fd); }
    this.db.prepare(`INSERT INTO resource_files(owner_id,course_id,project_id,path,identity,revision,source_file) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(owner_id,course_id) DO UPDATE SET project_id=excluded.project_id,path=excluded.path,identity=excluded.identity,revision=excluded.revision,source_file=excluded.source_file`)
      .run(owner, id, projectId, filename, identity, opened.revision, source);
    const previous = this.records.get(owner, 'courseFiles', id);
    const course = this.records.get(owner, 'videos', id);
    if (course) this.put(owner, 'videos', id, { ...course, name: path.posix.basename(filename).replace(/\.[^.]+$/, ''),
      folderId: this.folderId(owner, projectId, path.posix.dirname(filename) === '.' ? '' : path.posix.dirname(filename)), size: opened.size });
    this.put(owner, 'courseFiles', id, { ...previous, id, resourceProjectId: projectId, resourcePath: filename, resourceRevision: opened.revision,
      mimeType: course?.mimeType ?? previous?.mimeType ?? 'application/octet-stream', size: opened.size });
    return opened.revision;
  }
  /** Lazy, resumable migration: no startup move, no deletion of original data. */
  migrate(owner: string) {
    const root = this.root(owner);
    // Old clients remove courseFiles before marking the learning row deleted.
    // Consume that request once, using the last observed disk revision so a
    // concurrent Bot edit is never silently unlinked. Empty revision is a
    // tombstone, not a request to delete a future file at the same path.
    for (const mapped of this.db.prepare('SELECT * FROM resource_files WHERE owner_id=?').all(owner) as Placement[]) {
      const course = this.records.get(owner, 'videos', mapped.course_id);
      const reference = this.records.get(owner, 'courseFiles', mapped.course_id);
      if (course && !course.fileDeleted && reference) continue;
      if (mapped.revision) {
        this.projects.writable(owner, mapped.project_id); this.projects.assertIdle(mapped.project_id);
        try { this.projects.files.remove(mapped.project_id, mapped.path, mapped.revision); }
        catch (error) { if (!(error instanceof ProjectError) || error.status !== 404) throw error; }
      }
      this.put(owner, 'files', mapped.course_id, null);
      this.put(owner, 'courseFiles', mapped.course_id, null);
      if (course) {
        if (!course.fileDeleted) this.put(owner, 'videos', mapped.course_id, { ...course, fileDeleted: 1 });
        this.db.prepare("UPDATE resource_files SET revision='' WHERE owner_id=? AND course_id=?").run(owner, mapped.course_id);
      } else this.db.prepare('DELETE FROM resource_files WHERE owner_id=? AND course_id=?').run(owner, mapped.course_id);
    }
    const folders = new Map(this.rows(owner, 'folders').map(f => [f.id, f]));
    const visiting = new Set<number>();
    const locate = (id: number): Folder => {
      const folder = folders.get(id);
      if (!folder || visiting.has(id)) throw new ProjectError('invalid_resource_folder');
      visiting.add(id);
      const parent = folder.parentId != null && folders.has(folder.parentId) ? locate(folder.parentId) : null;
      const mapped = this.folder(owner, id);
      if (mapped) {
        if (!mapped.path) {
          // Permission scopes cannot be nested without silently changing grants.
          if (parent) throw new ProjectError('invalid_resource_folder');
          if (this.projects.get(owner, mapped.project_id).name !== folder.name) this.projects.update(owner, mapped.project_id, { name: folder.name });
        } else {
          const targetId = parent?.project_id ?? root;
          const target = join(parent?.path ?? '', path.posix.basename(mapped.path) === folder.name ? folder.name : cleanName(String(folder.name)));
          if (mapped.project_id !== targetId || mapped.path !== target) {
            this.move(owner, mapped.project_id, mapped.path, targetId, target, this.entry(mapped.project_id, mapped.path).revision);
            visiting.delete(id); return this.folder(owner, id)!;
          }
        }
        visiting.delete(id); return mapped;
      }
      // Root folders are permission/sandbox scopes; nested folders are plain directories.
      const location = parent ? { folder_id: id, project_id: parent.project_id, path: this.unique(parent.project_id, parent.path, cleanName(String(folder.name))) }
        : { folder_id: id, project_id: this.projects.create(owner, String(folder.name), this.defaultAgent(owner)).id, path: '' };
      if (parent) this.projects.files.mkdir(location.project_id, location.path);
      this.db.prepare('INSERT INTO resource_folders(owner_id,folder_id,project_id,path) VALUES(?,?,?,?)').run(owner, id, location.project_id, location.path);
      visiting.delete(id); return location;
    };
    for (const id of folders.keys()) locate(id);
    for (const course of this.rows(owner, 'videos')) {
      if (course.fileDeleted) continue;
      let mapped = this.placement(owner, course.id);
      if (mapped) {
        const parent = course.folderId != null ? this.folder(owner, course.folderId) : undefined;
        const targetId = parent?.project_id ?? root;
        const basename = path.posix.basename(mapped.path), title = basename.replace(/\.[^.]+$/, '');
        const name = course.name === title ? basename : cleanName(String(course.name)) + path.posix.extname(basename);
        const target = join(parent?.path ?? '', name);
        if (mapped.project_id !== targetId || mapped.path !== target) {
          this.move(owner, mapped.project_id, mapped.path, targetId, target, this.entry(mapped.project_id, mapped.path).revision);
          mapped = this.placement(owner, course.id);
        }
      }
      const edited = this.records.get(owner, 'files', course.id);
      const reference = this.records.get(owner, 'courseFiles', course.id);
      const sourceId = edited?.blob?.$file ?? (!mapped || !reference?.resourceProjectId ? reference?.fileId : undefined);
      if (!sourceId || mapped?.source_file === sourceId) {
        if (edited && sourceId && mapped?.source_file === sourceId) this.put(owner, 'files', course.id, null);
        continue;
      }
      const source = this.db.prepare('SELECT storage_name FROM files WHERE id=? AND owner_id=?').get(sourceId, owner) as { storage_name: string } | undefined;
      if (!source) continue;
      const sourcePath = path.resolve(this.filesDir, source.storage_name);
      if (path.dirname(sourcePath) !== path.resolve(this.filesDir) || !fs.existsSync(sourcePath)) continue;
      const location = mapped ? { project_id: mapped.project_id, path: path.posix.dirname(mapped.path) === '.' ? '' : path.posix.dirname(mapped.path) }
        : course.folderId != null ? this.folder(owner, course.folderId) : undefined;
      const projectId = location?.project_id ?? root;
      this.projects.writable(owner, projectId);
      this.projects.assertIdle(projectId);
      const originalExtension = path.extname(String(course.name)).toLowerCase();
      const extension = course.materialFormat ? `.${course.materialFormat}` : video.has(originalExtension.slice(1)) ? originalExtension
        : course.mimeType?.startsWith('video/') ? videoExtension[course.mimeType] ?? '.mp4' : '';
      const title = cleanName(String(course.name));
      const filename = mapped?.path ?? this.unique(projectId, location?.path ?? '', title.toLowerCase().endsWith(extension) ? title : title + extension);
      this.projects.files.copy(projectId, filename, sourcePath, mapped?.revision ?? null);
      this.remember(owner, course.id, projectId, filename, sourceId);
      if (edited) this.put(owner, 'files', course.id, null);
    }
    importBotAttachments(this.projects, this.filesDir, owner);
  }
  private entry(projectId: string, filename: string) {
    const parent = path.posix.dirname(filename) === '.' ? '' : path.posix.dirname(filename);
    const entry = this.projects.files.list(projectId, parent).find(f => f.path === filename);
    if (!entry) throw new ProjectError('project_file_not_found', 404);
    return entry;
  }
  private invalidate(owner: string, id: string) {
    for (const block of this.rows(owner, 'materialBlocks').filter(b => b.materialId === id)) this.put(owner, 'materialBlocks', block.id, null);
    this.put(owner, 'files', id, null);
    const row = this.records.get(owner, 'videos', id);
    if (row?.kind === 'material') this.put(owner, 'videos', id, { ...row, status: 'new', unitCount: undefined, lastUnit: undefined });
  }
  private index(owner: string, projectId: string, entry: ResourceEntry): ResourceEntry {
    if (entry.kind === 'directory') { this.folderId(owner, projectId, entry.path); return entry; }
    const ext = path.extname(entry.name).slice(1).toLowerCase(), format = formats[ext];
    if (!format && !video.has(ext)) return entry;
    const identity = this.projects.files.identity(projectId, entry.path);
    // Inode identity follows external renames inside the same permission scope.
    const existing = this.db.prepare('SELECT * FROM resource_files WHERE owner_id=? AND project_id=? AND (path=? OR identity=?) ORDER BY path=? DESC LIMIT 1').get(owner, projectId, entry.path, identity, entry.path) as Placement | undefined;
    const id = existing?.course_id ?? crypto.randomUUID();
    let current = this.records.get(owner, 'videos', id);
    if (existing && existing.revision !== entry.revision) this.invalidate(owner, id);
    if (existing && existing.revision !== entry.revision) current = this.records.get(owner, 'videos', id);
    const folderId = this.folderId(owner, projectId, path.posix.dirname(entry.path) === '.' ? '' : path.posix.dirname(entry.path));
    this.put(owner, 'videos', id, { ...current, id, fileDeleted: undefined, name: entry.name.replace(/\.[^.]+$/, ''), folderId, size: entry.size,
      mimeType: format ? mime[format] : current?.mimeType ?? `video/${ext}`, duration: current?.duration ?? 0,
      createdAt: current?.createdAt ?? Date.parse(entry.updatedAt), status: existing && existing.revision !== entry.revision && format ? 'new' : current?.status ?? 'new',
      ...(format ? { kind: 'material', materialFormat: format } : {}) });
    this.remember(owner, id, projectId, entry.path, existing?.source_file ?? null);
    return { ...entry, courseId: id };
  }
  list(owner: string, projectId?: string, directory = '', archived = false): ResourceDirectory {
    this.migrate(owner);
    const rootId = this.root(owner), id = projectId ?? rootId;
    const project = this.projects.get(owner, id);
    if (process.platform !== 'linux') this.projects.assertIdle(id);
    const entries = this.projects.files.list(id, directory).map(file => this.index(owner, id, { ...file, projectId: id }));
    for (const mapped of this.db.prepare('SELECT * FROM resource_files WHERE owner_id=? AND project_id=?').all(owner, id) as Placement[]) {
      const parent = path.posix.dirname(mapped.path) === '.' ? '' : path.posix.dirname(mapped.path);
      if (parent !== directory || entries.some(entry => entry.courseId === mapped.course_id || entry.path === mapped.path)) continue;
      const course = this.records.get(owner, 'videos', mapped.course_id);
      if (course) entries.push({ name: path.posix.basename(mapped.path), path: mapped.path, projectId: id, kind: 'file', size: course.size ?? 0,
        updatedAt: new Date(course.createdAt || 0).toISOString(), revision: '', courseId: mapped.course_id, missing: true });
    }
    if (!projectId) {
      for (const scope of this.projects.list(owner).filter(p => p.id !== rootId && (archived || !p.archived))) {
        this.folderId(owner, scope.id, '');
        entries.push({ name: scope.name, path: '', projectId: scope.id, kind: 'directory', size: 0, updatedAt: scope.updatedAt, revision: scope.updatedAt, scope });
      }
      // Remote/subtitle-only courses remain reachable; no fake empty files are made.
      for (const course of this.rows(owner, 'videos').filter(c => !this.placement(owner, c.id))) {
        entries.push({ name: course.name, path: '', projectId: rootId, kind: 'file', size: course.size ?? 0, updatedAt: new Date(course.createdAt || 0).toISOString(), revision: '', courseId: course.id, missing: true });
      }
    }
    return { project: projectId ? project : null, rootId, path: directory, folderId: this.folderId(owner, id, directory), entries };
  }
  course(owner: string, id: string) {
    this.migrate(owner);
    const mapped = this.placement(owner, id);
    if (!mapped) throw new ProjectError('project_file_not_found', 404);
    this.projects.get(owner, mapped.project_id);
    if (process.platform !== 'linux') this.projects.assertIdle(mapped.project_id);
    const parent = path.posix.dirname(mapped.path) === '.' ? '' : path.posix.dirname(mapped.path);
    const file = this.projects.files.list(mapped.project_id, parent).find(f => f.path === mapped.path);
    if (!file) throw new ProjectError('project_file_not_found', 404);
    this.index(owner, mapped.project_id, { ...file, projectId: mapped.project_id });
    return mapped;
  }
  /** Playback is read-only: no migration, indexing or directory scans per seek. */
  openCourse(owner: string, id: string) {
    const course = this.records.get(owner, 'videos', id);
    const reference = this.records.get(owner, 'courseFiles', id);
    if (!course || course.fileDeleted || !reference) throw new ProjectError('project_file_not_found', 404);
    const mapped = this.placement(owner, id);
    if (mapped) {
      this.projects.get(owner, mapped.project_id);
      if (process.platform !== 'linux') this.projects.assertIdle(mapped.project_id);
      return { ...this.projects.files.open(mapped.project_id, mapped.path), mimeType: course.mimeType ?? reference.mimeType ?? 'application/octet-stream' };
    }
    // Old uploads can play before the resource library has migrated them. Never
    // fall back to the backup after a mapped resource is removed from disk.
    const edited = this.records.get(owner, 'files', id);
    const sourceId = edited?.blob?.$file ?? reference.fileId;
    const source = this.db.prepare('SELECT storage_name,mime_type FROM files WHERE id=? AND owner_id=?').get(sourceId ?? '', owner) as { storage_name: string; mime_type: string } | undefined;
    if (!source) throw new ProjectError('project_file_not_found', 404);
    const filename = path.resolve(this.filesDir, source.storage_name);
    if (path.dirname(filename) !== path.resolve(this.filesDir)) throw new ProjectError('project_file_not_found', 404);
    let fd: number;
    try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) {
      if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new ProjectError('project_file_not_found', 404);
      throw error;
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) { fs.closeSync(fd); throw new ProjectError('project_path_denied', 403); }
    return { fd, size: stat.size, revision: `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, mimeType: source.mime_type };
  }
  saveText(owner: string, id: string, text: string, expected: string) {
    const mapped = this.course(owner, id);
    this.projects.writable(owner, mapped.project_id); this.projects.assertIdle(mapped.project_id);
    const current = this.projects.files.read(mapped.project_id, mapped.path);
    if (typeof expected !== 'string' || current.text !== expected) throw new ProjectError('project_file_conflict', 409);
    this.projects.files.write(mapped.project_id, mapped.path, text, current.revision);
    this.invalidate(owner, id);
    return { revision: this.remember(owner, id, mapped.project_id, mapped.path, mapped.source_file) };
  }
  /** Delete a resource and its learning records as one Resource Library action. */
  remove(owner: string, projectId: string, filename: string, expected: string) {
    this.migrate(owner);
    this.projects.writable(owner, projectId); this.projects.assertIdle(projectId);
    const placement = this.db.prepare('SELECT * FROM resource_files WHERE owner_id=? AND project_id=? AND path=?').get(owner, projectId, filename) as Placement | undefined;
    const courseId = placement?.course_id;
    const mutations: Array<{ id: string; table: string; key: string | number; before: Record<string, any>; after: null }> = [];
    if (courseId) {
      for (const table of learningTables) {
        for (const row of this.rows(owner, table)) {
          const matches = table === 'materialInk'
            ? row.materialId === courseId
            : row.id === courseId || row.videoId === courseId || row.materialId === courseId;
          if (!matches) continue;
          const key = table === 'covers' ? row.videoId : row.id;
          if (typeof key !== 'string' && typeof key !== 'number') continue;
          mutations.push({ id: crypto.randomUUID(), table, key, before: row, after: null });
        }
      }
    }
    // Validate and remove the authoritative file first. A conflict leaves all learning records intact.
    this.projects.files.remove(projectId, filename, expected);
    if (mutations.length) this.records.apply(owner, mutations);
    if (courseId) this.db.prepare('DELETE FROM resource_files WHERE owner_id=? AND course_id=?').run(owner, courseId);
  }
  move(owner: string, id: string, filename: string, targetId: string, target: string, revision: string) {
    this.projects.writable(owner, id); this.projects.writable(owner, targetId);
    this.projects.assertIdle(id); this.projects.assertIdle(targetId);
    const placements = this.db.prepare('SELECT * FROM resource_files WHERE owner_id=? AND project_id=?').all(owner, id) as Placement[];
    const folders = this.db.prepare('SELECT folder_id,project_id,path FROM resource_folders WHERE owner_id=? AND project_id=?').all(owner, id) as Folder[];
    // Tombstoned learning paths still have stable identities. Detect collisions
    // before changing the filesystem, not halfway through updating the index.
    for (const row of placements.filter(row => row.path === filename || row.path.startsWith(`${filename}/`))) {
      const existing = this.db.prepare('SELECT course_id FROM resource_files WHERE owner_id=? AND project_id=? AND path=?').get(owner, targetId, target + row.path.slice(filename.length)) as { course_id: string } | undefined;
      if (existing && existing.course_id !== row.course_id) throw new ProjectError('project_file_exists', 409);
    }
    for (const folder of folders.filter(folder => folder.path === filename || folder.path.startsWith(`${filename}/`))) {
      const existing = this.db.prepare('SELECT folder_id FROM resource_folders WHERE owner_id=? AND project_id=? AND path=?').get(owner, targetId, target + folder.path.slice(filename.length)) as { folder_id: number } | undefined;
      if (existing && existing.folder_id !== folder.folder_id) throw new ProjectError('project_file_exists', 409);
    }
    this.projects.files.move(id, filename, targetId, target, revision);
    this.projects.store.transaction(() => {
      for (const folder of folders) {
        if (folder.path === filename || folder.path.startsWith(`${filename}/`)) this.db.prepare('UPDATE resource_folders SET project_id=?,path=? WHERE owner_id=? AND folder_id=?').run(targetId, target + folder.path.slice(filename.length), owner, folder.folder_id);
      }
      // Keep compatibility indexes pointing at the moved directory, never a second tree.
      for (const folder of this.db.prepare('SELECT folder_id,project_id,path FROM resource_folders WHERE owner_id=? AND project_id=?').all(owner, targetId) as Folder[]) {
        if (folder.path !== target && !folder.path.startsWith(`${target}/`)) continue;
        const row = this.records.get(owner, 'folders', folder.folder_id);
        if (row) this.put(owner, 'folders', folder.folder_id, { ...row, name: path.posix.basename(folder.path),
          parentId: this.folderId(owner, targetId, path.posix.dirname(folder.path) === '.' ? '' : path.posix.dirname(folder.path)) });
      }
      for (const row of placements) {
        if (row.path === filename || row.path.startsWith(`${filename}/`)) this.remember(owner, row.course_id, targetId, target + row.path.slice(filename.length), row.source_file);
      }
    });
  }
}
