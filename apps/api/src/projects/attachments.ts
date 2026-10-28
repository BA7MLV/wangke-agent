import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectRepository } from './repository.js';

type Source = { id: string; storage_name: string; original_name: string; sha256: string; created_at: string };
type Receipt = { project_id: string; path: string; status: 'pending' | 'done' };

/** Project committed Bot attachments into the real resource tree. The receipt is
 * durable even after a user moves/deletes the copy, so history never resurrects it.
 * Old Gateway text attachments are included, but unattached uploads are not. */
export function importBotAttachments(projects: ProjectRepository, filesDir: string, owner: string, root: string) {
  const db = projects.store.db;
  // Start with message references, not every upload (course frames can be numerous).
  const rows = db.prepare(`SELECT f.id,f.storage_name,f.original_name,f.sha256,f.created_at
    FROM threads t JOIN messages m ON m.thread_id=t.id JOIN files f
      ON f.owner_id=t.owner_id AND f.id=json_extract(CASE WHEN json_valid(m.content) THEN m.content ELSE '{}' END,'$.fileId')
    WHERE t.owner_id=? AND t.mode='bot' AND m.kind='attachment'
      AND NOT EXISTS (SELECT 1 FROM resource_attachments a WHERE a.owner_id=f.owner_id AND a.file_id=f.id AND a.status='done')
    UNION SELECT f.id,f.storage_name,f.original_name,f.sha256,f.created_at
    FROM resource_attachments a JOIN files f ON f.owner_id=a.owner_id AND f.id=a.file_id
    WHERE a.owner_id=? AND a.status='pending'`).all(owner, owner) as Source[];
  const sources = new Map(rows.map(row => [row.id, row]));
  const legacy = db.prepare(`SELECT m.content FROM messages m JOIN threads t ON t.id=m.thread_id
    WHERE t.owner_id=? AND t.mode='bot' AND m.role='user' AND instr(m.content,'Attachment fileId=')>0`).all(owner) as { content: string }[];
  const lookup = db.prepare(`SELECT id,storage_name,original_name,sha256,created_at FROM files f WHERE id=? AND owner_id=?
    AND NOT EXISTS (SELECT 1 FROM resource_attachments a WHERE a.owner_id=f.owner_id AND a.file_id=f.id AND a.status='done')`);
  for (const message of legacy) for (const match of message.content.matchAll(/Attachment fileId=([a-f0-9-]{36}),/g)) {
    if (sources.has(match[1])) continue;
    const source = lookup.get(match[1], owner) as Source | undefined;
    if (source) sources.set(source.id, source);
  }
  const allocate = (source: Source, projectId: string) => {
    const names = new Set(projects.files.list(projectId, '').map(f => f.name));
    for (const row of db.prepare("SELECT path FROM resource_attachments WHERE owner_id=? AND project_id=? AND status='pending'").all(owner, projectId) as { path: string }[]) names.add(row.path);
    const name = source.original_name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').replace(/^\.+$/, '_') || 'Attachment';
    const ext = path.extname(name).slice(0, 16), stem = Array.from(name.slice(0, name.length - path.extname(name).length)).slice(0, 45).join('') || 'Attachment';
    let candidate = `${stem}${ext}`, n = 2;
    while (names.has(candidate)) candidate = `${stem} (${n++})${ext}`;
    return candidate;
  };
  for (const source of [...sources.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    const filename = path.resolve(filesDir, source.storage_name);
    if (path.dirname(filename) !== path.resolve(filesDir) || !fs.existsSync(filename)) continue;
    let receipt = db.prepare('SELECT * FROM resource_attachments WHERE owner_id=? AND file_id=?').get(owner, source.id) as Receipt | undefined;
    if (!receipt) {
      // An attachment may already be a learning resource; do not create another copy.
      const mapped = db.prepare("SELECT project_id,path FROM resource_files WHERE owner_id=? AND source_file=? AND revision<>'' LIMIT 1").get(owner, source.id) as Receipt | undefined;
      if (mapped) {
        db.prepare("INSERT INTO resource_attachments VALUES(?,?,?,?,'done')").run(owner, source.id, mapped.project_id, mapped.path);
        continue;
      }
      projects.writable(owner, root); projects.assertIdle(root);
      receipt = { project_id: root, path: allocate(source, root), status: 'pending' };
      db.prepare("INSERT INTO resource_attachments VALUES(?,?,?,?,'pending')").run(owner, source.id, root, receipt.path);
    }
    projects.writable(owner, receipt.project_id); projects.assertIdle(receipt.project_id);
    // Recover a crash between the atomic file installation and receipt commit.
    const entry = projects.files.list(receipt.project_id, '').find(f => f.path === receipt!.path);
    if (entry) {
      let matches = false;
      if (entry.kind === 'file') {
        const file = projects.files.open(receipt.project_id, receipt.path);
        try { matches = crypto.createHash('sha256').update(fs.readFileSync(file.fd)).digest('hex') === source.sha256; }
        finally { fs.closeSync(file.fd); }
      }
      if (!matches) {
        receipt.path = allocate(source, receipt.project_id);
        db.prepare('UPDATE resource_attachments SET path=? WHERE owner_id=? AND file_id=?').run(receipt.path, owner, source.id);
      } else {
        db.prepare("UPDATE resource_attachments SET status='done' WHERE owner_id=? AND file_id=?").run(owner, source.id);
        continue;
      }
    }
    projects.files.copy(receipt.project_id, receipt.path, filename);
    db.prepare("UPDATE resource_attachments SET status='done' WHERE owner_id=? AND file_id=?").run(owner, source.id);
  }
}
