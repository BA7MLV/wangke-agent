import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { parseSkillMarkdown } from '@wangke/study-core/skills/parser';
import { SKILLS_PATH, type SystemDirectory, type SystemDocument } from '@wangke/contracts/system';

export type SystemSkill = {
  id: number;
  slug: string;
  name: string;
  description: string;
  body: string;
  enabled: number;
  sha256: string;
  revision: number;
  version?: string;
  sourceUrl?: string;
  updatedAt: number;
  mcpRequired?: string[];
};

const SKILL_ID_BASE = 2 ** 52;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;

function ownerHash(owner: string) { return crypto.createHash('sha256').update(owner).digest('hex'); }
function skillId(owner: string, slug: string) {
  const value = Number.parseInt(crypto.createHash('sha256').update(`${owner}\0${slug}`).digest('hex').slice(0, 12), 16);
  return SKILL_ID_BASE + value;
}
function safeDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_system_path');
}

type SkillIndexRow = { source_url: string | null; sha256: string; revision: number; version: string | null; enabled: number };
type SkillSidecar = { sourceUrl?: string; version?: string; enabled?: boolean };
function frontmatterVersion(text: string) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const value = block?.[1].match(/^version\s*:\s*(.+)$/m)?.[1].trim().replace(/^['"]|['"]$/g, '');
  return value && value.length <= 100 ? value : undefined;
}

/** Real owner-scoped Skill packages. The directory is the source of truth. */
export class SystemSkills {
  constructor(readonly root: string, private readonly db: Database.Database) {}

  directory(owner: string) {
    const account = path.join(this.root, ownerHash(owner));
    const system = path.join(account, 'system');
    const skills = path.join(system, 'skills');
    safeDirectory(this.root);
    safeDirectory(account);
    safeDirectory(system);
    safeDirectory(skills);
    return skills;
  }

  private package(owner: string, slug: string) {
    if (!SLUG.test(slug)) throw new Error('invalid_skill_path');
    const root = this.directory(owner);
    const directory = path.join(root, slug);
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('unsafe_system_path');
    return directory;
  }

  private digest(directory: string) {
    const hash = crypto.createHash('sha256');
    let count = 0;
    let total = 0;
    const visit = (current: string, relative: string) => {
      for (const name of fs.readdirSync(current).sort()) {
        if (name === '.' || name === '..' || name.startsWith('.')) continue;
        if (++count > MAX_FILES) throw new Error('skill_package_too_large');
        const filename = path.join(current, name);
        const rel = path.posix.join(relative, name);
        const stat = fs.lstatSync(filename);
        if (stat.isSymbolicLink()) throw new Error('invalid_skill_path');
        if (stat.isDirectory()) visit(filename, rel);
        else if (stat.isFile()) {
          if (stat.size > MAX_FILE_BYTES || (total += stat.size) > MAX_PACKAGE_BYTES) throw new Error('skill_package_too_large');
          hash.update(rel).update('\0').update(fs.readFileSync(filename));
        }
      }
    };
    visit(directory, '');
    return hash.digest('hex');
  }

  private sidecar(directory: string): SkillSidecar {
    const filename = path.join(directory, '.wangke-skill.json');
    const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!stat) return {};
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('invalid_skill_metadata');
    try {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<string, unknown>;
      const sourceUrl = typeof value.sourceUrl === 'string' && value.sourceUrl.length <= 2048 ? value.sourceUrl : undefined;
      const version = typeof value.version === 'string' && value.version.length <= 100 ? value.version : undefined;
      if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('invalid_skill_metadata');
      return { ...(sourceUrl ? { sourceUrl } : {}), ...(version ? { version } : {}), ...(value.enabled !== undefined ? { enabled: value.enabled } : {}) };
    } catch { throw new Error('invalid_skill_metadata'); }
  }

  private indexed(owner: string, slug: string, metadata: SkillSidecar, sha256: string, revision: number): SkillIndexRow {
    const existing = this.db.prepare('SELECT source_url,sha256,revision,version,enabled FROM system_skills WHERE owner_id=? AND slug=?').get(owner, slug) as SkillIndexRow | undefined;
    const sourceUrl = metadata.sourceUrl ?? existing?.source_url ?? null;
    const version = metadata.version ?? existing?.version ?? null;
    const enabled = metadata.enabled === undefined ? (existing?.enabled ?? 1) : Number(metadata.enabled);
    if (!existing) {
      this.db.prepare('INSERT INTO system_skills(owner_id,slug,source_url,sha256,revision,version,enabled,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(owner, slug, sourceUrl, sha256, revision, version, enabled, new Date().toISOString());
      return { source_url: sourceUrl, sha256, revision, version, enabled };
    }
    if (existing.sha256 !== sha256 || existing.revision !== revision || existing.source_url !== sourceUrl || existing.version !== version || existing.enabled !== enabled) {
      this.db.prepare('UPDATE system_skills SET source_url=?,sha256=?,revision=?,version=?,enabled=?,updated_at=? WHERE owner_id=? AND slug=?')
        .run(sourceUrl, sha256, revision, version, enabled, new Date().toISOString(), owner, slug);
    }
    return { source_url: sourceUrl, sha256, revision, version, enabled };
  }

  private readPackage(owner: string, slug: string): SystemSkill | undefined {
    const directory = this.package(owner, slug);
    const filename = path.join(directory, 'SKILL.md');
    const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('invalid_skill_path');
    const text = fs.readFileSync(filename, 'utf8');
    const parsed = parseSkillMarkdown('SKILL.md', text);
    if (!parsed.body) return;
    const sha256 = this.digest(directory);
    const revision = Number.parseInt(sha256.slice(0, 12), 16);
    const metadata = this.sidecar(directory);
    const index = this.indexed(owner, slug, { ...metadata, version: metadata.version ?? frontmatterVersion(text) }, sha256, revision);
    const updatedAt = Math.max(stat.mtimeMs, fs.statSync(directory).mtimeMs);
    const binding = this.db.prepare('SELECT skill_id FROM system_skill_bindings WHERE owner_id=? AND slug=?').get(owner, slug) as { skill_id: number } | undefined;
    return { id: binding?.skill_id ?? skillId(owner, slug), slug, name: parsed.name || slug, description: parsed.description, body: parsed.body,
      enabled: index.enabled, sha256, revision, version: index.version ?? undefined, sourceUrl: index.source_url ?? undefined,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : revision, ...(parsed.mcpRequired ? { mcpRequired: parsed.mcpRequired } : {}) };
  }

  list(owner: string): SystemSkill[] {
    const root = this.directory(owner);
    return fs.readdirSync(root).filter(slug => SLUG.test(slug)).flatMap(slug => {
      try { const skill = this.readPackage(owner, slug); return skill ? [skill] : []; }
      catch { return []; }
    }).sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
  }

  load(owner: string, id: number, reference?: string) {
    const skill = this.list(owner).find(item => item.id === id);
    if (!skill) return;
    if (reference === undefined) return { id, name: skill.name, body: skill.body, revision: skill.revision, source: 'system' as const };
    if (!/^references\/[a-zA-Z0-9_./-]+$/.test(reference) || reference.includes('..')) throw new Error('invalid_skill_reference');
    const directory = this.package(owner, skill.slug);
    const root = fs.realpathSync(directory);
    const filename = path.resolve(directory, reference);
    if (!fs.existsSync(filename)) throw new Error('skill_reference_not_found');
    const real = fs.realpathSync(filename);
    if (!real.startsWith(`${root}${path.sep}`)) throw new Error('invalid_skill_reference');
    const stat = fs.lstatSync(real);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('invalid_skill_reference');
    return { id, reference, body: fs.readFileSync(real, 'utf8'), revision: skill.revision, source: 'system' as const };
  }

  private relativePath(resource: string) {
    if (typeof resource !== 'string' || !resource.startsWith(`${SKILLS_PATH}/`)) throw new Error('invalid_system_path');
    const parts = resource.slice(SKILLS_PATH.length + 1).split('/');
    if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[\\\u0000-\u001f\u007f]/.test(part) || part.length > 255)) throw new Error('invalid_system_path');
    if (!SLUG.test(parts[0])) throw new Error('invalid_system_path');
    return { slug: parts[0], relative: parts.slice(1).join('/') };
  }

  private safeFile(owner: string, slug: string, relative: string) {
    if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[\\\u0000-\u001f\u007f]/.test(part))) throw new Error('invalid_system_path');
    const directory = this.package(owner, slug);
    const root = fs.realpathSync(directory);
    let current = directory;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('invalid_system_path');
    }
    const real = fs.realpathSync(current);
    if (!real.startsWith(`${root}${path.sep}`)) throw new Error('invalid_system_path');
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('system_file_too_large');
    return { filename: real, stat, directory };
  }

  private document(owner: string, slug: string, relative: string): SystemDocument {
    const file = this.safeFile(owner, slug, relative);
    const skill = this.list(owner).find(item => item.slug === slug);
    if (!skill) throw new Error('skill_not_found');
    const filePath = `${SKILLS_PATH}/${slug}/${relative}`;
    return { path: filePath, name: path.basename(relative), content: fs.readFileSync(file.filename, 'utf8'), revision: skill.revision,
      updatedAt: new Date(file.stat.mtimeMs).toISOString(), source: skill.sourceUrl ?? 'system:skill', kind: 'skill', summary: skill.name,
      slug, version: skill.version, sha256: skill.sha256, enabled: skill.enabled === 1 };
  }

  readFile(owner: string, resource: string): SystemDocument {
    const { slug, relative } = this.relativePath(resource);
    return this.document(owner, slug, relative);
  }

  /** User and Agent edits share the same live-file CAS as the rest of /system. */
  saveFile(owner: string, resource: string, content: string, expected: string, revision: number): SystemDocument {
    if (typeof content !== 'string' || typeof expected !== 'string' || !Number.isSafeInteger(revision) || revision < 0 || content.length > 100000) throw new Error('invalid_system_document');
    const { slug, relative } = this.relativePath(resource);
    if (relative === 'SKILL.md') {
      try {
        const parsed = parseSkillMarkdown('SKILL.md', content);
        if (!parsed.body) throw new Error();
      } catch { throw new Error('invalid_skill_markdown'); }
    }
    const current = this.readFile(owner, resource);
    if (current.content !== expected || current.revision !== revision) throw new Error('system_revision_conflict');
    const file = this.safeFile(owner, slug, relative);
    const temporary = path.join(path.dirname(file.filename), `.${path.basename(file.filename)}.${crypto.randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temporary, 'wx', file.stat.mode & 0o777);
      try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const latest = this.readFile(owner, resource);
      if (latest.content !== expected || latest.revision !== revision) throw new Error('system_revision_conflict');
      fs.renameSync(temporary, file.filename);
      const directory = fs.openSync(path.dirname(file.filename), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally { fs.rmSync(temporary, { force: true }); }
    return this.readFile(owner, resource);
  }

  listDirectory(owner: string, resource: string, offset = 0, query = ''): SystemDirectory {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_offset');
    const root = this.directory(owner);
    let base = root;
    let prefix = SKILLS_PATH;
    let skillSlug: string | undefined;
    let relativeBase = '';
    if (resource !== SKILLS_PATH) {
      const { slug, relative } = this.relativePath(resource);
      skillSlug = slug;
      relativeBase = relative;
      base = this.package(owner, slug);
      for (const part of relative ? relative.split('/') : []) {
        base = path.join(base, part);
        const entry = fs.lstatSync(base);
        if (entry.isSymbolicLink()) throw new Error('invalid_system_path');
      }
      prefix = resource;
      const stat = fs.lstatSync(base);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_system_path');
    }
    const packages = resource === SKILLS_PATH ? new Set(this.list(owner).map(skill => skill.slug)) : undefined;
    const entries = fs.readdirSync(base).filter(name => !name.startsWith('.') && (!packages || packages.has(name)) && (!query || name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))).sort();
    const page = entries.slice(offset, offset + 50);
    const files: Omit<SystemDocument, 'content'>[] = [];
    const directories: string[] = [];
    for (const name of page) {
      const filename = path.join(base, name);
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) throw new Error('invalid_system_path');
      const child = `${prefix}/${name}`;
      if (stat.isDirectory()) directories.push(child);
      else if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
        if (!skillSlug) continue;
        const relative = relativeBase ? `${relativeBase}/${name}` : name;
        const { content: _content, ...document } = this.document(owner, skillSlug, relative);
        files.push(document);
      }
    }
    return { files, directories, nextOffset: entries.length > offset + 50 ? offset + 50 : null };
  }
}
