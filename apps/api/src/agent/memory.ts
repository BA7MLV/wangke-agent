import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import { publishBotEvent } from './events.js';
import { memoryPath, memoryName, memoryId, diaryDate } from '@wangke/contracts/system';

export interface MemoryInput { scope: 'owner' | 'bot' | 'course'; scopeId: string; kind: 'preference' | 'course_fact' | 'note' | 'diary'; content: string; source: string; sourceRevision?: string }
export type MemoryRow = { id: string; owner_id: string; scope: MemoryInput['scope']; scope_id: string; kind: MemoryInput['kind']; content: string; source: string; source_revision: string | null; revision: number; status: string; origin: string; created_at: string; updated_at: string };
export class BotMemory {
  constructor(readonly store: DatabaseStore) {}
  path(row: MemoryRow) { return this.store.systemFiles.path(row.owner_id, row.id) ?? memoryPath(row.id); }
  /** Import disk changes into the index, never repair a notebook from an old DB snapshot. */
  materialize(row: MemoryRow) {
    const resource = this.path(row), files = this.store.systemFiles;
    const known = files.entry(row.owner_id, resource);
    const disk = files.read(row.owner_id, resource);
    if (!known) {
      this.store.transaction(() => {
        files.register(row.owner_id, resource, row.id);
        // One-time migration of database-only memories, not recovery of deleted files.
        if (disk === undefined && row.status !== 'deleted') files.write(row.owner_id, resource, row.content, null);
      });
      if (disk === undefined) return row;
    }
    const deleted = disk === undefined;
    if (deleted && row.status === 'deleted' || !deleted && disk === row.content && row.status !== 'deleted') return row;
    if (!deleted && (disk.length > (row.kind === 'note' || row.kind === 'diary' ? 100000 : 8000) || !disk.trim() && row.kind !== 'note' && row.kind !== 'diary')) throw new Error('invalid_memory');
    const updated = { ...row, content: disk ?? '', status: deleted ? 'deleted' : row.status === 'deleted' ? row.kind === 'course_fact' ? 'stale' : 'active' : row.status, revision: row.revision + 1, updated_at: new Date().toISOString() };
    this.store.transaction(() => {
      this.store.db.prepare('UPDATE bot_memories SET content=?,status=?,revision=?,updated_at=? WHERE id=?').run(updated.content, updated.status, updated.revision, updated.updated_at, row.id);
      this.version(updated);
      publishBotEvent(this.store, { owner: row.owner_id, type: deleted ? 'memory.deleted' : 'memory.saved', status: 'filesystem' });
    });
    return updated;
  }
  sync(owner: string, resource?: string) {
    const id = resource ? this.store.systemFiles.entry(owner, resource)?.memory_id ?? memoryId(resource) : undefined;
    const rows = resource
      ? this.store.db.prepare('SELECT * FROM bot_memories WHERE owner_id=? AND id=?').all(owner, id ?? '') as MemoryRow[]
      : this.store.db.prepare('SELECT * FROM bot_memories WHERE owner_id=?').all(owner) as MemoryRow[];
    for (const row of rows) this.materialize(row);
    for (const candidate of resource ? [resource] : this.store.systemFiles.list(owner)) {
      if (this.store.systemFiles.entry(owner, candidate)) continue;
      const content = this.store.systemFiles.read(owner, candidate);
      if (content === undefined) continue;
      this.save(owner, { scope: 'owner', scopeId: '', kind: diaryDate(candidate) ? 'diary' : 'note', content, source: 'user:filesystem' }, { path: candidate, fromDisk: true });
    }
  }
  private raw(owner: string, id: string) {
    const row = this.store.db.prepare('SELECT * FROM bot_memories WHERE id=? AND owner_id=?').get(id, owner) as MemoryRow | undefined;
    if (!row) throw new Error('memory_not_found');
    return row;
  }
  private sourceRevision(owner: string, value: MemoryInput): string | undefined {
    const { source } = value;
    if (value.kind === 'course_fact' && !source.startsWith('record:') && !source.startsWith('file:')) throw new Error('course_fact_requires_locatable_source');
    if (source.startsWith('record:')) {
      const [, table, ...parts] = source.split(':');
      if (!['videos', 'segments', 'materialBlocks', 'handouts', 'cards', 'subtitleTracks', 'comments', 'danmakus', 'files', 'courseFiles'].includes(table)) throw new Error('invalid_memory_source');
      let key: unknown;
      try { key = JSON.parse(parts.join(':')); } catch { throw new Error('invalid_memory_source'); }
      if (typeof key !== 'string' && typeof key !== 'number') throw new Error('invalid_memory_source');
      const row = this.store.db.prepare('SELECT revision,value FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, JSON.stringify(key)) as { revision: number; value: string | null } | undefined;
      if (!row?.value) throw new Error('memory_source_not_found');
      const record = JSON.parse(row.value) as Record<string, unknown>;
      const course = ['videos', 'files', 'courseFiles'].includes(table) ? record.id : record.videoId ?? record.materialId;
      if (value.scope === 'course' && course !== value.scopeId) throw new Error('memory_source_course_mismatch');
      return String(row.revision);
    }
    if (source.startsWith('file:')) {
      const id = source.slice(5);
      const row = this.store.db.prepare('SELECT id,created_at FROM files WHERE id=? AND owner_id=?').get(id, owner) as { id: string; created_at: string } | undefined;
      if (!row) throw new Error('memory_source_not_found');
      if (value.scope === 'course') {
        const linked = this.store.db.prepare("SELECT 1 FROM cloud_records WHERE owner_id=? AND record_key=? AND value IS NOT NULL AND (table_name='courseFiles' AND json_extract(value,'$.fileId')=? OR table_name='files' AND json_extract(value,'$.blob.$file')=?)").get(owner, JSON.stringify(value.scopeId), id, id);
        if (!linked) throw new Error('memory_source_course_mismatch');
      }
      return `${row.id}:${row.created_at}`;
    }
    if (source.startsWith('message:') || source.startsWith('run:')) {
      const message = source.startsWith('message:');
      if (!this.store.db.prepare(`SELECT 1 FROM ${message ? 'messages' : 'runs'} s JOIN threads t ON t.id=s.thread_id WHERE s.id=? AND t.owner_id=?`).get(source.slice(source.indexOf(':') + 1), owner)) throw new Error('memory_source_not_found');
      return undefined;
    }
    if (!source.startsWith('user:')) throw new Error('invalid_memory_source');
    return undefined; // Explicit manual preference, not a claimed document revision.
  }
  private validate(owner: string, value: MemoryInput) {
    const notebook = value.kind === 'note' || value.kind === 'diary';
    if (!['owner', 'bot', 'course'].includes(value.scope) || !['preference', 'course_fact', 'note', 'diary'].includes(value.kind) || typeof value.content !== 'string' || !notebook && !value.content.trim() || value.content.length > (notebook ? 100000 : 8000) || typeof value.source !== 'string' || !value.source || value.source.length > 300 || typeof value.scopeId !== 'string') throw new Error('invalid_memory');
    if (value.scope === 'owner' && value.scopeId !== '') throw new Error('invalid_memory_scope');
    if (value.scopeId.length > 300 || value.sourceRevision !== undefined && (typeof value.sourceRevision !== 'string' || value.sourceRevision.length > 300)) throw new Error('invalid_memory_source');
    if (value.scope === 'bot' && !this.store.db.prepare('SELECT 1 FROM agent_profiles WHERE id=? AND owner_id=?').get(value.scopeId, owner)) throw new Error('bot_not_found');
    if (value.scope === 'course' && !this.store.db.prepare("SELECT 1 FROM cloud_records WHERE owner_id=? AND table_name='videos' AND record_key=? AND value IS NOT NULL").get(owner, JSON.stringify(value.scopeId))) throw new Error('course_not_found');
    if (value.kind === 'course_fact' && value.scope !== 'course') throw new Error('course_fact_requires_course');
  }
  list(owner: string, query = '', offset = 0, includeDeleted = false) {
    this.sync(owner);
    this.refreshStale(owner);
    const rows = this.store.db.prepare(`SELECT * FROM bot_memories WHERE owner_id=? AND (? OR status!='deleted') AND instr(lower(content || COALESCE((SELECT path FROM system_file_entries WHERE memory_id=bot_memories.id),'')),lower(?))>0 ORDER BY updated_at DESC,id LIMIT 50 OFFSET ?`).all(owner, Number(includeDeleted), query.slice(0, 200), Math.max(0, offset)) as MemoryRow[];
    return rows.map(row => ({ ...row, path: this.path(row) }));
  }
  get(owner: string, id: string) {
    this.refreshStale(owner, id);
    return this.materialize(this.raw(owner, id));
  }
  save(owner: string, value: MemoryInput, options: { id?: string; revision?: number; origin?: 'explicit' | 'consolidated'; path?: string; fromDisk?: boolean } = {}) {
    this.validate(owner, value);
    const saved = this.store.transaction(() => {
      value = { ...value, sourceRevision: this.sourceRevision(owner, value) };
      const existing = options.id ? this.get(owner, options.id) : undefined;
      if (existing && existing.revision !== options.revision) throw new Error('memory_revision_conflict');
      if (options.origin === 'consolidated' && this.store.db.prepare("SELECT 1 FROM bot_memories WHERE owner_id=? AND source=? AND scope=? AND scope_id=? AND status='deleted'").get(owner, value.source, value.scope, value.scopeId)) throw new Error('memory_source_tombstoned');
      const id = existing?.id ?? crypto.randomUUID(), at = new Date().toISOString(), revision = (existing?.revision ?? 0) + 1;
      this.store.db.prepare(`INSERT INTO bot_memories(id,owner_id,scope,scope_id,kind,content,source,source_revision,revision,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?)
        ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,scope_id=excluded.scope_id,kind=excluded.kind,content=excluded.content,source=excluded.source,source_revision=excluded.source_revision,revision=excluded.revision,status='active',origin=excluded.origin,updated_at=excluded.updated_at`).run(id, owner, value.scope, value.scopeId, value.kind, value.content, value.source, value.sourceRevision ?? null, revision, options.origin ?? 'explicit', existing?.created_at ?? at, at);
      const row = this.raw(owner, id);
      const resource = options.path ?? this.path(row);
      if (!memoryName(resource)) throw new Error('invalid_system_path');
      if (existing && resource !== this.path(existing)) throw new Error('invalid_system_path');
      if (value.kind === 'diary' && !diaryDate(resource)) throw new Error('invalid_diary_date');
      if (this.store.systemFiles.entry(owner, resource)?.memory_id && this.store.systemFiles.entry(owner, resource)!.memory_id !== id) throw new Error('system_revision_conflict');
      this.store.systemFiles.register(owner, resource, id);
      this.store.systemFiles.write(owner, resource, row.content, options.fromDisk ? row.content : existing && existing.status !== 'deleted' ? existing.content : null);
      this.version(row);
      publishBotEvent(this.store, { owner, type: 'memory.saved', status: options.origin ?? 'explicit' });
      return row;
    });
    return saved;
  }
  private version(row: MemoryRow) {
    this.store.db.prepare('INSERT INTO bot_memory_versions(memory_id,revision,value,created_at) VALUES(?,?,?,?)').run(row.id, row.revision, JSON.stringify(row), row.updated_at);
  }
  remove(owner: string, id: string, revision: number) {
    const deleted = this.store.transaction(() => {
      const row = this.get(owner, id);
      if (row.revision !== revision) throw new Error('memory_revision_conflict');
      this.store.db.prepare("UPDATE bot_memories SET content='',status='deleted',revision=revision+1,updated_at=? WHERE id=?").run(new Date().toISOString(), id);
      const deleted = this.raw(owner, id); this.version(deleted);
      this.store.systemFiles.write(owner, this.path(row), null, row.status === 'deleted' ? null : row.content);
      return deleted;
    });
    publishBotEvent(this.store, { owner, type: 'memory.deleted', status: 'deleted' });
    return deleted;
  }
  versions(owner: string, id: string, offset = 0) {
    this.get(owner, id);
    return this.store.db.prepare('SELECT revision,value,created_at FROM bot_memory_versions WHERE memory_id=? ORDER BY revision DESC LIMIT 50 OFFSET ?').all(id, Math.max(0, offset));
  }
  restore(owner: string, id: string, revision: number, expected: number) {
    const current = this.get(owner, id);
    if (current.revision !== expected) throw new Error('memory_revision_conflict');
    const version = this.store.db.prepare('SELECT value FROM bot_memory_versions WHERE memory_id=? AND revision=?').get(id, revision) as { value: string } | undefined;
    if (!version) throw new Error('memory_version_not_found');
    const row = JSON.parse(version.value) as MemoryRow;
    if (row.status === 'deleted') throw new Error('cannot_restore_tombstone');
    const input = { scope: row.scope, scopeId: row.scope_id, kind: row.kind, content: row.content, source: row.source };
    if (row.kind === 'course_fact' && this.sourceRevision(owner, input) !== row.source_revision) throw new Error('memory_source_changed');
    return this.save(owner, input, { id, revision: expected });
  }
  refreshStale(owner: string, id?: string) {
    const rows = this.store.db.prepare("SELECT * FROM bot_memories WHERE owner_id=? AND status='active' AND (? IS NULL OR id=?)").all(owner, id ?? null, id ?? null) as MemoryRow[];
    for (const row of rows) {
      let stale = false;
      try {
        const input = { scope: row.scope, scopeId: row.scope_id, kind: row.kind, content: row.content, source: row.source };
        this.validate(owner, input);
        const revision = this.sourceRevision(owner, input);
        stale = (revision ?? null) !== row.source_revision;
      } catch { stale = true; }
      if (stale) this.store.db.prepare("UPDATE bot_memories SET status='stale' WHERE id=? AND status='active'").run(row.id);
    }
  }
  context(owner: string, thread: string) {
    this.sync(owner);
    this.refreshStale(owner);
    if (!this.store.db.prepare('SELECT 1 FROM threads WHERE id=? AND owner_id=?').get(thread, owner)) throw new Error('thread_not_found');
    const rows = this.store.db.prepare(`SELECT * FROM bot_memories m WHERE owner_id=? AND status='active' AND kind='preference'
      AND (scope='owner' OR scope='bot' AND EXISTS(SELECT 1 FROM thread_participants p WHERE p.thread_id=? AND p.agent_id=m.scope_id))
      ORDER BY updated_at DESC LIMIT 20`).all(owner, thread) as MemoryRow[];
    // Course facts are retrieved explicitly with course scope, never guessed
    // from an attachment or injected into unrelated conversations.
    let characters = 0;
    return rows.map(r => ({ id: r.id, kind: r.kind, content: r.content, source: r.source, revision: r.revision })).filter(row => {
      const size = JSON.stringify(row).length;
      if (characters + size > 8000) return false;
      characters += size; return true;
    });
  }
}
