import Dexie, { type DBCoreTransaction } from 'dexie';
import { CLOUD_TABLES, type CloudMutation } from '../../packages/contracts/src/cloud';
import { cloud } from './state';

export const cloudApplyTransactions = new WeakSet<DBCoreTransaction>();
export interface OutboxRow extends CloudMutation { sequence?: number; transaction: string }

/** Mutations and their outbox commit/rollback together, including bulk and range deletes.
 * Random safe-integer IDs preserve the existing numeric foreign keys across devices. */
export function installCloudCache(database: Dexie) {
  const transactions = new WeakMap<DBCoreTransaction, string>();
  database.use({
    stack: 'dbcore', name: 'cloud-outbox', level: -1,
    create: core => ({
      ...core,
      transaction(stores, mode, options) {
        return core.transaction(mode === 'readwrite' ? [...new Set([...stores, '_cloudOutbox'])] : stores, mode, options);
      },
      table(name) {
        const table = core.table(name);
        if (!Object.hasOwn(CLOUD_TABLES, name)) return table;
        return {
          ...table,
          async mutate(original) {
            if (cloudApplyTransactions.has(original.trans)) return table.mutate(original);
            let req = original;
            const pk = table.schema.primaryKey;
            if ((req.type === 'add' || req.type === 'put') && pk.autoIncrement) {
              req = { ...req, values: req.values.map(value => {
                if (pk.extractKey?.(value) != null) return value;
                const random = crypto.getRandomValues(new Uint32Array(2));
                const id = (random[0] & 0xfffff) * 0x100000000 + random[1];
                return { ...value, [CLOUD_TABLES[name]]: id || 1 };
              }) };
            }
            const keys = req.type === 'deleteRange'
              ? (await table.query({ trans: req.trans, values: false, query: { index: pk, range: req.range } })).result
              : req.type === 'delete' ? req.keys : req.keys ?? req.values.map(v => pk.extractKey?.(v));
            const before = keys.length ? await table.getMany({ trans: req.trans, keys }) : [];
            const result = await table.mutate(req);
            const afterKeys = req.type === 'delete' || req.type === 'deleteRange' ? keys : result.results ?? keys;
            const after = req.type === 'delete' || req.type === 'deleteRange' ? [] : await table.getMany({ trans: req.trans, keys: afterKeys });
            let tx = transactions.get(req.trans);
            if (!tx) { tx = crypto.randomUUID(); transactions.set(req.trans, tx); }
            const values = afterKeys.flatMap((key, i) => result.failures[i] ? [] : [{
              transaction: tx!, id: crypto.randomUUID(), table: name, key,
               before: before[i] ?? null, after: after[i] ?? null,
               ...(cloud.worker && cloud.permissionId ? { permissionId: cloud.permissionId } : {}),
            } satisfies OutboxRow]);
            if (values.length) {
              const saved = await core.table('_cloudOutbox').mutate({ type: 'add', trans: req.trans, values });
              if (saved.numFailures) { req.trans.abort(); throw new Error('无法保存待同步数据，修改已回滚'); }
            }
            return result;
          },
        };
      },
    }),
  });
}

export function markCloudApply() {
  const transaction = Dexie.currentTransaction as unknown as { idbtrans: DBCoreTransaction };
  cloudApplyTransactions.add(transaction.idbtrans);
}
