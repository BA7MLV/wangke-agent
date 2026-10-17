import type { DatabaseStore } from './database.js';
import crypto from 'node:crypto';

export class BootstrapRepository {
  constructor(private readonly store: DatabaseStore) {}

  isInitialized(): boolean {
    return Boolean(this.store.db.prepare("SELECT 1 FROM app_state WHERE key = 'initialized'").get());
  }

  initializeAdmin(name: string, passwordHash: string): boolean {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    return this.store.transaction(() => {
      if (this.isInitialized()) return false;
      this.store.db.prepare('INSERT INTO users(id, name, created_at) VALUES (?, ?, ?)').run(id, name, now);
      this.store.db.prepare('INSERT INTO password_credentials(user_id, password_hash, created_at) VALUES (?, ?, ?)').run(id, passwordHash, now);
      this.store.db.prepare("INSERT OR REPLACE INTO app_state(key, value) VALUES ('initialized', 'true')").run();
      return true;
    });
  }
}
