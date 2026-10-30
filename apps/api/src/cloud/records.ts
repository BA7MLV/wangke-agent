import { CLOUD_TABLES, type CloudMutation, type CloudRecord } from '@wangke/contracts/cloud';
import type { DatabaseStore } from '../storage/database.js';
import { isDeepStrictEqual } from 'node:util';
import { AGENTS_PATH } from '@wangke/contracts/system';
import crypto from 'node:crypto';
import { BotMemory } from '../agent/memory.js';

const equal = isDeepStrictEqual;
export class CloudConflict extends Error {
  constructor(readonly table: string, readonly key: string | number, readonly fields: string[]) {
    super('sync_conflict');
  }
}

export class CloudRecords {
  private indexingInstructions = false;
  constructor(private store: DatabaseStore) {}
  agentInstructions(owner: string) {
    const record = this.get(owner, 'preferences', 'agentInstructions');
    const indexed = typeof record?.value === 'string' ? record.value : '';
    const known = this.store.systemFiles.entry(owner, AGENTS_PATH);
    const disk = this.store.systemFiles.read(owner, AGENTS_PATH);
    if (!known && disk === undefined) {
      this.store.systemFiles.write(owner, AGENTS_PATH, indexed, null);
      return indexed;
    }
    const text = disk ?? '';
    this.store.systemFiles.register(owner, AGENTS_PATH);
    if (text !== indexed) {
      this.indexingInstructions = true;
      try { this.apply(owner, [{ id: crypto.randomUUID(), table: 'preferences', key: 'agentInstructions', before: record, after: { id: 'agentInstructions', value: text } }]); }
      finally { this.indexingInstructions = false; }
    }
    if (disk === undefined) this.store.systemFiles.write(owner, AGENTS_PATH, '', null);
    return text;
  }
  ownedFile(owner: string, id: string) { return !!this.store.db.prepare('SELECT 1 FROM files WHERE id=? AND owner_id=?').get(id, owner); }

  get(owner: string, table: string, key: string | number): Record<string, any> | null {
    if ((table === 'skills' || table === 'skillRefs') && !this.store.db.inTransaction) this.store.skillRecords.sync(owner);
    const row = this.store.db.prepare('SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?')
      .get(owner, table, JSON.stringify(key)) as { value: string | null } | undefined;
    return row?.value ? JSON.parse(row.value) : null;
  }

  list(owner: string, after: number, limit = 200): CloudRecord[] {
    this.agentInstructions(owner);
    this.store.skillRecords.sync(owner);
    const rows = this.store.db.prepare('SELECT revision,table_name,record_key,value FROM cloud_records WHERE owner_id=? AND revision>? ORDER BY revision LIMIT ?')
      .all(owner, after, limit) as Array<{ revision: number; table_name: string; record_key: string; value: string | null }>;
    return rows.map(r => ({ revision: r.revision, table: r.table_name, key: JSON.parse(r.record_key), value: r.value ? JSON.parse(r.value) : null }));
  }

  apply(owner: string, mutations: CloudMutation[], validate?: (table: string, key: string | number, current: Record<string, unknown> | null, value: Record<string, unknown> | null) => void) {
    const skills = mutations.some(op => op?.table === 'skills' || op?.table === 'skillRefs');
    if (skills) this.store.skillRecords.sync(owner);
    const instructions = mutations.some(op => op?.table === 'preferences' && op.key === 'agentInstructions');
    if (instructions && !this.indexingInstructions) this.agentInstructions(owner);
    const result = this.store.transaction(() => {
      const skillBefore = skills ? this.store.skillRecords.snapshot(owner) : undefined;
      const nameBefore = this.get(owner, 'preferences', 'userName')?.value;
      const instructionBefore = instructions ? this.get(owner, 'preferences', 'agentInstructions')?.value ?? '' : '';
      const deletedHere = new Set<string>();
      for (const op of mutations) {
        if (!op || !Object.hasOwn(CLOUD_TABLES, op.table) || typeof op.id !== 'string' || op.id.length > 200 ||
            !op.id || !['string', 'number'].includes(typeof op.key) ||
            (typeof op.key === 'number' && (!Number.isSafeInteger(op.key) || op.key < 0)) ||
            (typeof op.key === 'string' && (!op.key || op.key.length > 256)) ||
            (op.after !== null && (!op.after || Array.isArray(op.after) || typeof op.after !== 'object')) ||
            (op.before !== null && (!op.before || Array.isArray(op.before) || typeof op.before !== 'object'))) throw new Error('invalid_mutation');
        if (this.store.db.prepare('SELECT 1 FROM cloud_operations WHERE owner_id=? AND id=?').get(owner, op.id)) continue;
        if (op.after && op.after[CLOUD_TABLES[op.table]] !== op.key) throw new Error('invalid_record_key');
        if (op.table === 'preferences' && op.key === 'agentInstructions' && op.after && (typeof op.after.value !== 'string' || op.after.value.length > 100000)) throw new Error('invalid_agent_instructions');
        const existing = this.store.db.prepare('SELECT value,revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?')
          .get(owner, op.table, JSON.stringify(op.key)) as { value: string | null; revision: number } | undefined;
        const recordId = `${op.table}:${JSON.stringify(op.key)}`;
        const current: Record<string, unknown> | null = existing?.value ? JSON.parse(existing.value) : null;
        let value = op.after;
        if (op.after === null) {
          // Delete/edit races are reported instead of resurrecting or losing someone's work.
          if (current && !equal(current, op.before)) throw new CloudConflict(op.table, op.key, ['delete']);
          deletedHere.add(recordId);
        } else if (op.before === null) {
          if (op.table === 'studyDays' && current) {
            const delta = Number(op.after.seconds);
            if (!Number.isFinite(delta) || delta < 0 || delta > 86400) throw new Error('invalid_study_delta');
            value = { ...current, seconds: Number(current.seconds) + delta, updatedAt: op.after.updatedAt };
          } else if (op.table === 'preferences' && current) {
            if (op.key === 'agentInstructions' && !equal(current, op.after)) throw new CloudConflict(op.table, op.key, ['value']);
            value = op.after;
          } else if (existing && !equal(current, op.after) && !(current === null && (op.baseRevision === existing.revision || deletedHere.has(recordId)))) throw new CloudConflict(op.table, op.key, ['create']);
        } else {
          if (!current) throw new CloudConflict(op.table, op.key, ['deleted']);
          value = { ...current };
          for (const field of new Set([...Object.keys(op.before), ...Object.keys(op.after)])) {
            if (field === '__proto__' || field === 'constructor' || field === 'prototype') throw new Error('invalid_field');
            if (equal(op.before[field], op.after[field])) continue;
            if (op.table === 'studyDays' && field === 'seconds') {
              const delta = Number(op.after.seconds) - Number(op.before.seconds ?? 0);
              if (!Number.isFinite(delta) || delta < 0 || delta > 86400) throw new Error('invalid_study_delta');
              value.seconds = Number(current.seconds ?? 0) + delta;
            } else {
              // Positions/timestamps are naturally last-write-wins; content conflicts stay visible.
               const position = (op.table === 'preferences' && op.key !== 'agentInstructions') || ['lastPosition', 'lastUnit', 'readPos', 'updatedAt', 'finished'].includes(field);
              if (!position && !equal(current[field], op.before[field]) && !equal(current[field], op.after[field])) {
                throw new CloudConflict(op.table, op.key, [field]);
              }
              if (Object.hasOwn(op.after, field)) value[field] = op.after[field];
              else delete value[field];
            }
          }
        }
        // Validate the actual optimistic merge inside the write transaction.
        validate?.(op.table, op.key, current, value);
        // INSERT after DELETE allocates a monotonic revision, including tombstones.
        this.store.db.prepare('DELETE FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').run(owner, op.table, JSON.stringify(op.key));
        this.store.db.prepare('INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,?,?,?)')
          .run(owner, op.table, JSON.stringify(op.key), value === null ? null : JSON.stringify(value));
        this.store.db.prepare('INSERT INTO cloud_operations(owner_id,id) VALUES(?,?)').run(owner, op.id);
      }
      if (instructions && !this.indexingInstructions) this.store.systemFiles.write(owner, AGENTS_PATH, this.get(owner, 'preferences', 'agentInstructions')?.value ?? '', instructionBefore);
      if (skillBefore) this.store.skillRecords.writeChanges(owner, skillBefore);
      const nameAfter = this.get(owner, 'preferences', 'userName')?.value;
      if (nameAfter !== nameBefore) {
        const name = typeof nameAfter === 'string' ? nameAfter.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '';
        new BotMemory(this.store).rememberUserName(owner, name);
      }
      return { accepted: mutations.map(op => op.id), versions: mutations.map(op => ({ table: op.table, key: op.key,
        revision: (this.store.db.prepare('SELECT revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, op.table, JSON.stringify(op.key)) as { revision: number }).revision })) };
    });
    return result;
  }
}
