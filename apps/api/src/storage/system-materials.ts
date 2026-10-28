import crypto from 'node:crypto';
import type { DatabaseStore } from './database.js';
import { CloudRecords, CloudConflict } from '../cloud/records.js';
import { BotMemory, type MemoryRow } from '../agent/memory.js';
import { AGENTS_PATH, MEMORY_PATH, memoryId, memoryName, diaryDate, type SystemDirectory, type SystemDocument } from '@wangke/contracts/system';

export class SystemMaterials {
  readonly memory: BotMemory;
  readonly records: CloudRecords;
  constructor(readonly store: DatabaseStore) {
    this.memory = new BotMemory(store);
    this.records = new CloudRecords(store);
  }

  /** Upgrade existing settings/memories without adding duplicate course records. */
  migrate() {
    const owners = this.store.db.prepare('SELECT id FROM users').all() as Array<{ id: string }>;
    for (const owner of owners) this.records.agentInstructions(owner.id);
    const rows = this.store.db.prepare('SELECT * FROM bot_memories').all() as MemoryRow[];
    for (const row of rows) this.memory.materialize(row);
    for (const owner of owners) this.memory.sync(owner.id);
  }

  private document(row: MemoryRow): SystemDocument {
    const path = this.memory.path(row);
    return { path, name: path.split('/').pop()!, kind: row.kind, content: row.content, revision: row.revision,
      updatedAt: row.updated_at, status: row.status, scope: row.scope, scopeId: row.scope_id, source: row.source, summary: row.content.trim().split('\n')[0].slice(0, 100) };
  }

  read(owner: string, path: string): SystemDocument {
    if (path === AGENTS_PATH) {
      const content = this.records.agentInstructions(owner);
      const row = this.store.db.prepare("SELECT revision FROM cloud_records WHERE owner_id=? AND table_name='preferences' AND record_key=?").get(owner, JSON.stringify('agentInstructions')) as { revision: number } | undefined;
      return { path, name: 'AGENTS.md', content, revision: row?.revision ?? 0, updatedAt: null };
    }
    if (!memoryName(path)) throw new Error('invalid_system_path');
    this.memory.sync(owner, path);
    const id = this.store.systemFiles.entry(owner, path)?.memory_id ?? memoryId(path);
    if (!id) throw new Error('memory_not_found');
    const row = this.memory.get(owner, id);
    if (row.status === 'deleted') throw new Error('memory_not_found');
    return this.document(row);
  }

  list(owner: string, path: string, offset = 0, query = ''): SystemDirectory {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_offset');
    if (path === '/system') {
      const { content: _content, ...file } = this.read(owner, AGENTS_PATH);
      return { files: offset === 0 ? [file] : [], directories: offset === 0 ? [MEMORY_PATH] : [], nextOffset: null };
    }
    if (path !== MEMORY_PATH) throw new Error('invalid_system_path');
    const rows = this.memory.list(owner, query, offset);
    return { files: rows.map(row => { const { content: _content, ...file } = this.document(row); return file; }), nextOffset: rows.length === 50 ? offset + 50 : null };
  }

  /** A fresh, owner-scoped search snapshot. Bodies remain authoritative on disk. */
  searchDocuments(owner: string): SystemDocument[] {
    this.memory.sync(owner);
    this.memory.refreshStale(owner);
    const rows = this.store.db.prepare("SELECT * FROM bot_memories WHERE owner_id=? AND status!='deleted' ORDER BY id").all(owner) as MemoryRow[];
    return rows.map(row => this.document(row));
  }

  save(owner: string, path: string, content: string, expected: string, revision: number, source = 'user:notebook') {
    if (typeof content !== 'string' || typeof expected !== 'string' || !Number.isSafeInteger(revision) || revision < 0 || content.length > 100000) throw new Error('invalid_system_document');
    if (memoryName(path)) {
      this.memory.sync(owner, path);
      if (!this.store.systemFiles.entry(owner, path)) {
        if (revision !== 0 || expected !== '') throw new Error('system_revision_conflict');
        if (/\/\d{4}-\d{2}-\d{2}\.md$/.test(path) && !diaryDate(path)) throw new Error('invalid_diary_date');
        this.memory.save(owner, { scope: 'owner', scopeId: '', kind: diaryDate(path) ? 'diary' : 'note', content, source }, { path });
        return this.read(owner, path);
      }
    }
    const current = this.read(owner, path);
    if (current.content !== expected || current.revision !== revision) throw new Error('system_revision_conflict');
    if (path === AGENTS_PATH) {
      const before = this.records.get(owner, 'preferences', 'agentInstructions');
      try { this.records.apply(owner, [{ id: crypto.randomUUID(), table: 'preferences', key: 'agentInstructions', before, after: { id: 'agentInstructions', value: content } }]); }
      catch (e) { if (e instanceof CloudConflict) throw new Error('system_revision_conflict'); throw e; }
    } else {
      const row = this.memory.get(owner, this.store.systemFiles.entry(owner, path)!.memory_id!);
      // A stale source must not silently become fresh just because its Markdown was edited.
      if (row.status !== 'active') throw new Error('memory_source_changed');
      this.memory.save(owner, { scope: row.scope, scopeId: row.scope_id, kind: row.kind, content, source: row.source }, { id: row.id, revision });
    }
    return this.read(owner, path);
  }
}
