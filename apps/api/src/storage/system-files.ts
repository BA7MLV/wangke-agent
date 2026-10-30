import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { AGENTS_PATH, MCP_PATH, MEMORY_PATH, SKILLS_PATH, memoryName } from '@wangke/contracts/system';

type Entry = { owner_id: string; path: string; memory_id: string | null; pending: number; content: string | null; expected: string | null };

/** Files are authoritative. SQLite journals pending atomic writes and indexes revisions. */
export class SystemFiles {
  constructor(readonly root: string, private readonly db: Database.Database) {}

  private filename(owner: string, resource: string) {
    const name = memoryName(resource);
    const skill = resource.startsWith(`${SKILLS_PATH}/`) ? resource.slice(SKILLS_PATH.length + 1).split('/') : undefined;
    if (skill && (skill.length < 2 || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(skill[0]) || skill.slice(1).some((part, i) =>
      !part || part === '.' || part === '..' || part.length > 255 || /[\\\u0000-\u001f\u007f]/.test(part) || part.startsWith('.') && !(i === 0 && skill.length === 2 && part === '.wangke-skill.json')))) throw new Error('invalid_system_path');
    if (resource !== AGENTS_PATH && resource !== MCP_PATH && resource !== MEMORY_PATH && !name && !skill) throw new Error('invalid_system_path');
    const account = crypto.createHash('sha256').update(owner).digest('hex');
    const directories = [this.root, path.join(this.root, account), path.join(this.root, account, 'system'), path.join(this.root, account, 'system', 'memory')];
    if (skill) {
      let current = path.join(directories[2], 'skills');
      directories.push(current);
      for (const part of skill.slice(0, -1)) { current = path.join(current, part); directories.push(current); }
    }
    for (const directory of directories) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_system_path');
    }
    if (resource === MEMORY_PATH) return directories[3];
    const filename = skill ? path.join(directories.at(-1)!, skill.at(-1)!) : resource === AGENTS_PATH || resource === MCP_PATH ? path.join(directories[2], resource === MCP_PATH ? 'mcp.json' : 'AGENTS.md') : path.join(directories[3], `${name}.md`);
    const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > (skill ? 2 * 1024 * 1024 : 400000))) throw new Error('unsafe_system_path');
    return filename;
  }

  entry(owner: string, resource: string) {
    return this.db.prepare('SELECT * FROM system_file_entries WHERE owner_id=? AND path=?').get(owner, resource) as Entry | undefined;
  }
  register(owner: string, resource: string, memory: string | null = null) {
    this.filename(owner, resource);
    this.db.prepare('INSERT OR IGNORE INTO system_file_entries(owner_id,path,memory_id) VALUES(?,?,?)').run(owner, resource, memory);
  }
  path(owner: string, memory: string) {
    return (this.db.prepare('SELECT path FROM system_file_entries WHERE owner_id=? AND memory_id=?').get(owner, memory) as { path: string } | undefined)?.path;
  }
  private physical(owner: string, resource: string): string | undefined {
    const filename = this.filename(owner, resource);
    if (!fs.existsSync(filename)) return;
    const text = fs.readFileSync(filename, 'utf8');
    if (text.length > (resource.startsWith(`${SKILLS_PATH}/`) ? 2 * 1024 * 1024 : 100000)) throw new Error('system_file_too_large');
    return text;
  }
  read(owner: string, resource: string): string | undefined {
    const entry = this.entry(owner, resource);
    if (entry?.pending && this.db.inTransaction) return entry.content ?? undefined;
    if (entry?.pending) this.flush();
    return this.physical(owner, resource);
  }
  list(owner: string) {
    const filenames = fs.readdirSync(this.filename(owner, MEMORY_PATH));
    if (filenames.length > 10000) throw new Error('system_directory_too_large');
    return filenames.map(name => `${MEMORY_PATH}/${name}`).filter(resource => memoryName(resource)).sort();
  }

  /** Stage inside the same SQL transaction as metadata; rolled-back writes never reach disk. */
  write(owner: string, resource: string, content: string | null, expected?: string | null) {
    const stage = () => {
      const previous = this.read(owner, resource);
      if (expected !== undefined && previous !== (expected ?? undefined)) throw new Error('system_revision_conflict');
      this.register(owner, resource);
      if (previous === (content ?? undefined)) return;
      this.db.prepare('UPDATE system_file_entries SET pending=1,content=?,expected=CASE WHEN pending=1 THEN expected ELSE ? END WHERE owner_id=? AND path=?').run(content, previous ?? null, owner, resource);
    };
    if (this.db.inTransaction) stage();
    else { this.db.transaction(stage)(); this.flush(); }
    return content;
  }

  /** Crash replay is conditional: never overwrite a newer external edit. */
  flush() {
    if (this.db.inTransaction) return;
    const pending = this.db.prepare('SELECT * FROM system_file_entries WHERE pending=1').all() as Entry[];
    for (const entry of pending) {
      const current = this.physical(entry.owner_id, entry.path) ?? null;
      const filename = this.filename(entry.owner_id, entry.path);
      if (current !== entry.content) {
        if (current !== entry.expected) {
          this.db.prepare('UPDATE system_file_entries SET pending=0,content=NULL,expected=NULL WHERE owner_id=? AND path=?').run(entry.owner_id, entry.path);
          throw new Error('system_file_changed');
        }
        if (entry.content === null) fs.rmSync(filename, { force: true });
        else {
          const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
          try {
            const mode = fs.statSync(filename, { throwIfNoEntry: false })?.mode ?? 0o600;
            const fd = fs.openSync(temporary, 'wx', mode & 0o777);
            try { fs.writeFileSync(fd, entry.content, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            if ((this.physical(entry.owner_id, entry.path) ?? null) !== current) throw new Error('system_file_changed');
            fs.renameSync(temporary, filename);
          } finally { fs.rmSync(temporary, { force: true }); }
        }
      }
      // Persist the rename/unlink (including replay) before completing its intent.
      const directory = fs.openSync(path.dirname(filename), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      this.db.prepare('UPDATE system_file_entries SET pending=0,content=NULL,expected=NULL WHERE owner_id=? AND path=?').run(entry.owner_id, entry.path);
    }
  }
}
