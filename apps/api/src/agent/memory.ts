import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import { publishBotEvent } from './events.js';

export interface MemoryInput { scope: 'owner' | 'bot' | 'course'; scopeId: string; kind: 'preference' | 'course_fact'; content: string; source: string; sourceRevision?: string }
export type MemoryRow = { id: string; owner_id: string; scope: MemoryInput['scope']; scope_id: string; kind: MemoryInput['kind']; content: string; source: string; source_revision: string | null; revision: number; status: string; origin: string; created_at: string; updated_at: string };
export class BotMemory {
  constructor(readonly store: DatabaseStore) {}
  private validate(owner: string, value: MemoryInput) {
    if (!['owner', 'bot', 'course'].includes(value.scope) || !['preference', 'course_fact'].includes(value.kind) || typeof value.content !== 'string' || !value.content.trim() || value.content.length > 8000 || typeof value.source !== 'string' || !value.source || value.source.length > 300 || typeof value.scopeId !== 'string') throw new Error('invalid_memory');
    if (value.scope === 'owner' && value.scopeId !== '') throw new Error('invalid_memory_scope');
    if (value.scopeId.length > 300 || value.sourceRevision !== undefined && (typeof value.sourceRevision !== 'string' || value.sourceRevision.length > 300)) throw new Error('invalid_memory_source');
    if (value.scope === 'bot' && !this.store.db.prepare('SELECT 1 FROM agent_profiles WHERE id=? AND owner_id=?').get(value.scopeId, owner)) throw new Error('bot_not_found');
    if (value.scope === 'course' && !this.store.db.prepare("SELECT 1 FROM cloud_records WHERE owner_id=? AND table_name='videos' AND record_key=? AND value IS NOT NULL").get(owner, JSON.stringify(value.scopeId))) throw new Error('course_not_found');
    if (value.kind === 'course_fact' && value.scope !== 'course') throw new Error('course_fact_requires_course');
  }
  list(owner: string, query = '', offset = 0, includeDeleted = false) {
    this.refreshStale(owner);
    return this.store.db.prepare(`SELECT * FROM bot_memories WHERE owner_id=? AND (? OR status!='deleted') AND instr(lower(content),lower(?))>0 ORDER BY updated_at DESC,id LIMIT 50 OFFSET ?`).all(owner, Number(includeDeleted), query.slice(0, 200), Math.max(0, offset)) as MemoryRow[];
  }
  get(owner: string, id: string) {
    const row = this.store.db.prepare('SELECT * FROM bot_memories WHERE id=? AND owner_id=?').get(id, owner) as MemoryRow | undefined;
    if (!row) throw new Error('memory_not_found');
    return row;
  }
  save(owner: string, value: MemoryInput, options: { id?: string; revision?: number; origin?: 'explicit' | 'consolidated' } = {}) {
    this.validate(owner, value);
    return this.store.transaction(() => {
      const existing = options.id ? this.get(owner, options.id) : undefined;
      if (existing && existing.revision !== options.revision) throw new Error('memory_revision_conflict');
      if (options.origin === 'consolidated' && this.store.db.prepare("SELECT 1 FROM bot_memories WHERE owner_id=? AND source=? AND scope=? AND scope_id=? AND status='deleted'").get(owner, value.source, value.scope, value.scopeId)) throw new Error('memory_source_tombstoned');
      const id = existing?.id ?? crypto.randomUUID(), at = new Date().toISOString(), revision = (existing?.revision ?? 0) + 1;
      this.store.db.prepare(`INSERT INTO bot_memories(id,owner_id,scope,scope_id,kind,content,source,source_revision,revision,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?)
        ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,scope_id=excluded.scope_id,kind=excluded.kind,content=excluded.content,source=excluded.source,source_revision=excluded.source_revision,revision=excluded.revision,status='active',origin=excluded.origin,updated_at=excluded.updated_at`).run(id, owner, value.scope, value.scopeId, value.kind, value.content, value.source, value.sourceRevision ?? null, revision, options.origin ?? 'explicit', existing?.created_at ?? at, at);
      const row = this.get(owner, id);
      this.version(row);
      publishBotEvent(this.store, { owner, type: 'memory.saved', status: options.origin ?? 'explicit' });
      return row;
    });
  }
  private version(row: MemoryRow) {
    this.store.db.prepare('INSERT INTO bot_memory_versions(memory_id,revision,value,created_at) VALUES(?,?,?,?)').run(row.id, row.revision, JSON.stringify(row), row.updated_at);
  }
  remove(owner: string, id: string, revision: number) {
    return this.store.transaction(() => {
      const row = this.get(owner, id);
      if (row.revision !== revision) throw new Error('memory_revision_conflict');
      this.store.db.prepare("UPDATE bot_memories SET content='',status='deleted',revision=revision+1,updated_at=? WHERE id=?").run(new Date().toISOString(), id);
      const deleted = this.get(owner, id); this.version(deleted); return deleted;
    });
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
    return this.save(owner, { scope: row.scope, scopeId: row.scope_id, kind: row.kind, content: row.content, source: row.source, sourceRevision: row.source_revision ?? undefined }, { id, revision: expected });
  }
  refreshStale(owner: string) {
    const rows = this.store.db.prepare("SELECT * FROM bot_memories WHERE owner_id=? AND status='active' AND source LIKE 'record:%'").all(owner) as MemoryRow[];
    for (const row of rows) {
      const [, table, ...key] = row.source.split(':');
      const record = this.store.db.prepare('SELECT revision,value FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, key.join(':')) as { revision: number; value: string | null } | undefined;
      if (!record?.value || String(record.revision) !== row.source_revision) this.store.db.prepare("UPDATE bot_memories SET status='stale' WHERE id=? AND status='active'").run(row.id);
    }
  }
  context(owner: string, thread: string) {
    this.refreshStale(owner);
    if (!this.store.db.prepare('SELECT 1 FROM threads WHERE id=? AND owner_id=?').get(thread, owner)) throw new Error('thread_not_found');
    const rows = this.store.db.prepare(`SELECT * FROM bot_memories m WHERE owner_id=? AND status='active'
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
