import { CLOUD_TABLES, type CloudMutation, type CloudRecord } from '../../../../packages/contracts/src/cloud.js';
import type { DatabaseStore } from '../storage/database.js';
import { isDeepStrictEqual } from 'node:util';

const equal = isDeepStrictEqual;
export class CloudConflict extends Error {
  constructor(readonly table: string, readonly key: string | number, readonly fields: string[]) {
    super('sync_conflict');
  }
}

export class CloudRecords {
  constructor(private store: DatabaseStore) {}

  get(owner: string, table: string, key: string | number): Record<string, any> | null {
    const row = this.store.db.prepare('SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?')
      .get(owner, table, JSON.stringify(key)) as { value: string | null } | undefined;
    return row?.value ? JSON.parse(row.value) : null;
  }

  list(owner: string, after: number, limit = 200): CloudRecord[] {
    const rows = this.store.db.prepare('SELECT revision,table_name,record_key,value FROM cloud_records WHERE owner_id=? AND revision>? ORDER BY revision LIMIT ?')
      .all(owner, after, limit) as Array<{ revision: number; table_name: string; record_key: string; value: string | null }>;
    return rows.map(r => ({ revision: r.revision, table: r.table_name, key: JSON.parse(r.record_key), value: r.value ? JSON.parse(r.value) : null }));
  }

  apply(owner: string, mutations: CloudMutation[]) {
    return this.store.transaction(() => {
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
               const position = op.table === 'preferences' || ['lastPosition', 'lastUnit', 'readPos', 'updatedAt', 'finished'].includes(field);
              if (!position && !equal(current[field], op.before[field]) && !equal(current[field], op.after[field])) {
                throw new CloudConflict(op.table, op.key, [field]);
              }
              if (Object.hasOwn(op.after, field)) value[field] = op.after[field];
              else delete value[field];
            }
          }
        }
        // INSERT after DELETE allocates a monotonic revision, including tombstones.
        this.store.db.prepare('DELETE FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').run(owner, op.table, JSON.stringify(op.key));
        this.store.db.prepare('INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,?,?,?)')
          .run(owner, op.table, JSON.stringify(op.key), value === null ? null : JSON.stringify(value));
        this.store.db.prepare('INSERT INTO cloud_operations(owner_id,id) VALUES(?,?)').run(owner, op.id);
      }
      return { accepted: mutations.map(op => op.id), versions: mutations.map(op => ({ table: op.table, key: op.key,
        revision: (this.store.db.prepare('SELECT revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, op.table, JSON.stringify(op.key)) as { revision: number }).revision })) };
    });
  }
}
