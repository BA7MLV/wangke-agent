import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import { boundedText } from './result-budget.js';

export class BotArtifacts {
  constructor(readonly store: DatabaseStore) {}
  put(owner: string, run: string, step: string, content: string) {
    const size = Buffer.byteLength(content);
    if (size > 2 * 1024 * 1024) throw new Error('artifact_too_large');
    const id = crypto.createHash('sha256').update(`${owner}\0${run}\0${step}\0${content}`).digest('hex');
    this.store.transaction(() => {
      if (!this.store.db.prepare('SELECT 1 FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=?').get(run, owner)) throw new Error('artifact_run_not_owned');
      if (this.store.db.prepare('SELECT 1 FROM bot_artifacts WHERE id=? AND owner_id=?').get(id, owner)) return;
      const quota = this.store.db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes,COUNT(*) AS count FROM bot_artifacts WHERE owner_id=?').get(owner) as { bytes: number; count: number };
      if (quota.bytes + size > 50 * 1024 * 1024 || quota.count >= 1000) throw new Error('artifact_quota_exceeded');
      this.store.db.prepare('INSERT INTO bot_artifacts(id,owner_id,run_id,step_id,content,size_bytes,created_at) VALUES(?,?,?,?,?,?,?)').run(id, owner, run, step, content, size, new Date().toISOString());
    });
    return { artifactId: id, sizeBytes: size, preview: content.slice(0, 1500), read: 'artifact_read(artifactId, offset, length); offsets are UTF-16 characters' };
  }
  read(owner: string, id: string, offset = 0, length = 8000, maxTokens = 4096) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 12000) throw new Error('invalid_artifact_range');
    const row = this.store.db.prepare('SELECT content,size_bytes FROM bot_artifacts WHERE id=? AND owner_id=?').get(id, owner) as { content: string; size_bytes: number } | undefined;
    if (!row) throw new Error('artifact_not_found');
    return boundedText({ artifactId: id, sizeBytes: row.size_bytes }, row.content, offset, maxTokens, length);
  }
}
