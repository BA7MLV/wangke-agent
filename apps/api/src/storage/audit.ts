import type { DatabaseStore } from './database.js';

/** Diagnostics are bounded observers, never an authorization decision. */
export function appendAudit(store: DatabaseStore, owner: string, action: string, detail: unknown, at = new Date().toISOString()) {
  try {
    const configured = Number(process.env.BOT_AUDIT_LIMIT);
    const limit = Number.isSafeInteger(configured) && configured >= 1000 ? Math.min(configured, 1000000) : 100000;
    const json = JSON.stringify(detail);
    const value = json.length <= 16000 ? json : JSON.stringify({ truncated: true, sizeChars: json.length });
    store.transaction(() => {
      const count = (store.db.prepare('SELECT COUNT(*) AS n FROM cloud_audit WHERE owner_id=?').get(owner) as { n: number }).n;
      if (count >= limit) store.db.prepare('DELETE FROM cloud_audit WHERE id IN (SELECT id FROM cloud_audit WHERE owner_id=? ORDER BY id LIMIT ?)').run(owner, Math.min(100, count - limit + 1));
      if (count - 100 >= limit) return;
      store.db.prepare('INSERT INTO cloud_audit(owner_id,action,detail,created_at) VALUES(?,?,?,?)').run(owner, action, value, at);
    });
  } catch { console.error('audit_persistence_unavailable'); }
}
