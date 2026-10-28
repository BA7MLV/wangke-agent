import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

export function inspectDatabase(db: Database.Database) {
  const foreignKeys = db.pragma('foreign_key_check') as unknown[];
  if (db.pragma('quick_check', { simple: true }) !== 'ok' || foreignKeys.length) throw new Error('database_integrity_failed');
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return { schemaHash: crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex') };
}

/** In-memory bearer tokens are also discarded at process exit. Persisted leases
 * must be fenced BEFORE a recovery point: remote executors cannot complete an old
 * attempt against the replacement, including after a restored database starts. */
export function fenceRemoteWorkers(db: Database.Database) {
  db.transaction(() => {
    db.prepare("UPDATE cloud_tasks SET status=CASE WHEN executor='browser' THEN 'queued' ELSE 'interrupted' END,worker_id=NULL,lease_expires_at=NULL,updated_at=? WHERE status IN ('running','waiting_user')").run(new Date().toISOString());
    db.prepare("UPDATE cloud_permissions SET status='expired' WHERE status IN ('pending','approved','consumed')").run();
  })();
}
