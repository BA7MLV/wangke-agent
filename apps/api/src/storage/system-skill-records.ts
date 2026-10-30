import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseSkillMarkdown, serializeSkillMarkdown, type SkillFile } from '@wangke/study-core/skills/parser';
import type { DatabaseStore } from './database.js';

type Row = Record<string, any>;
type Binding = { skill_id: number; slug: string; builtin_slug: string | null };
type Snapshot = { skills: Map<number, Row>; refs: Map<number, Row> };
const builtinRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@wangke/study-core/skills/assets'))), '..');
const builtinSlugs = ['gongwen-writing', 'gongwen-format', 'subject-math', 'subject-coding', 'gongkao-xingce', 'gongkao-shenlun',
  'diagramming', 'interactive-explainer', 'library-organizer', 'course-handout', 'question-bank'];
const resource = (slug: string, file: string) => `/system/skills/${slug}/${file}`;

// Same stable identifiers as the existing browser builtin rows and references.
function builtinId(name: string) {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return 2 ** 52 + (hash >>> 0);
}
function referencePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('references/') && value.split('/').every(part =>
    part && !part.startsWith('.') && part.length <= 255 && !/[\\\u0000-\u001f\u007f]/.test(part));
}
function validSkill(row: Row): row is Row & SkillFile {
  return Number.isSafeInteger(row.id) && row.id > 0 && ['name', 'description', 'body'].every(key => typeof row[key] === 'string') &&
    !!row.body.trim() && [0, 1].includes(row.enabled) && (row.mcpRequired === undefined || Array.isArray(row.mcpRequired) && row.mcpRequired.every((s: unknown) => typeof s === 'string'));
}
function markdown(row: SkillFile, previous = '') {
  // Keep package-specific frontmatter (version, license, etc.) on settings edits.
  const extra = previous.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)?.[1]
    .replace(/^(?:name|description|requires-mcp)\s*:.*(?:\r?\n[ \t]+.*)*/gm, '').trim();
  const text = serializeSkillMarkdown({ ...row, name: row.name.replace(/[\r\n]+/g, ' '), description: row.description.replace(/[\r\n]+/g, ' ') });
  return extra ? text.replace('\n---\n\n', `\n${extra}\n---\n\n`) : text;
}
function references(directory: string) {
  const result = new Map<string, string>();
  const visit = (relative: string) => {
    const filename = path.join(directory, relative), stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error('invalid_skill_reference');
    if (stat.isDirectory()) { for (const name of fs.readdirSync(filename).sort()) if (!name.startsWith('.')) visit(`${relative}/${name}`); }
    else if (stat.isFile() && referencePath(relative) && /\.(md|markdown|txt|csv|json|ya?ml)$/i.test(relative)) {
      if (stat.size > 2 * 1024 * 1024) throw new Error('skill_package_too_large');
      result.set(relative, fs.readFileSync(filename, 'utf8'));
    }
  };
  visit('references');
  return result;
}
let bundled: Array<{ slug: string; skill: SkillFile; text: string; refs: Map<string, string> }> | undefined;
function builtins() {
  return bundled ??= builtinSlugs.map(slug => {
    const directory = path.join(builtinRoot, slug), text = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8');
    return { slug, text, skill: parseSkillMarkdown('SKILL.md', text), refs: references(directory) };
  });
}

/** Compatibility projection: settings rows keep their IDs; package files own the content. */
export class SystemSkillRecords {
  private syncing = false;
  constructor(private store: DatabaseStore) {}

  snapshot(owner: string): Snapshot {
    const read = (table: string) => new Map<number, Row>((this.store.db.prepare('SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND value IS NOT NULL')
      .all(owner, table) as Array<{ value: string }>).flatMap(({ value }) => {
        try { const row = JSON.parse(value); return row && Number.isSafeInteger(row.id) && row.id > 0 ? [[row.id, row] as [number, Row]] : []; }
        catch { return []; }
      }));
    return { skills: read('skills'), refs: read('skillRefs') };
  }
  private bindings(owner: string) {
    return this.store.db.prepare('SELECT skill_id,slug,builtin_slug FROM system_skill_bindings WHERE owner_id=?').all(owner) as Binding[];
  }
  private bind(owner: string, id: number, slug: string, builtin: string | null) {
    this.store.db.prepare('INSERT INTO system_skill_bindings(owner_id,skill_id,slug,builtin_slug) VALUES(?,?,?,?)').run(owner, id, slug, builtin);
    return { skill_id: id, slug, builtin_slug: builtin };
  }
  private chooseSlug(owner: string, row: Row) {
    const builtin = row.builtin === 1 ? builtins().find(b => b.skill.name === row.name) : undefined;
    const base = builtin?.slug ?? `${String(row.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 35) || 'skill'}-${row.id}`;
    let slug = base;
    const root = this.store.systemSkills.directory(owner);
    for (let suffix = 1; this.bindings(owner).some(b => b.slug === slug) || fs.existsSync(path.join(root, slug)); suffix++) slug = `${base.slice(0, 55)}-${suffix}`;
    return this.bind(owner, row.id, slug, builtin?.slug ?? null);
  }
  private project(owner: string, table: string, id: number, value: Row | null) {
    const existing = this.store.db.prepare('SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, JSON.stringify(id)) as { value: string | null } | undefined;
    if (isDeepStrictEqual(existing?.value ? JSON.parse(existing.value) : null, value)) return;
    this.store.db.prepare('DELETE FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').run(owner, table, JSON.stringify(id));
    this.store.db.prepare('INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,?,?,?)').run(owner, table, JSON.stringify(id), value === null ? null : JSON.stringify(value));
  }
  private stage(owner: string, slug: string, file: string, text: string | null) {
    if (file !== 'SKILL.md' && file !== '.wangke-skill.json' && !referencePath(file)) throw new Error('invalid_skill_reference');
    if (text !== null && Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('skill_package_too_large');
    const target = resource(slug, file), files = this.store.systemFiles;
    files.write(owner, target, text, files.read(owner, target) ?? null);
  }
  private create(owner: string, row: Row, refs: Row[], text?: string, preferredSlug?: string) {
    if (!validSkill(row)) throw new Error('invalid_skill');
    if (refs.length > 190 || refs.some(r => !referencePath(r.path) || typeof r.body !== 'string')) throw new Error('invalid_skill_reference');
    const body = text ?? markdown(row);
    if (Buffer.byteLength(body) + refs.reduce((size, r) => size + Buffer.byteLength(r.body), 0) > 16 * 1024 * 1024) throw new Error('skill_package_too_large');
    const binding = preferredSlug ? this.bind(owner, row.id, preferredSlug, preferredSlug) : this.chooseSlug(owner, row);
    this.stage(owner, binding.slug, 'SKILL.md', body);
    this.stage(owner, binding.slug, '.wangke-skill.json', JSON.stringify({ enabled: row.enabled === 1 }));
    for (const ref of refs) this.stage(owner, binding.slug, ref.path, ref.body);
    return binding;
  }

  /** One-time materialization is journaled with the mapping, so restarts cannot duplicate it. */
  sync(owner: string) {
    if (this.syncing) return this.store.systemSkills.list(owner);
    this.syncing = true;
    try {
      this.store.systemFiles.flush();
      this.store.transaction(() => {
        const snapshot = this.snapshot(owner), known = new Set(this.bindings(owner).map(b => b.skill_id));
        const installed = this.store.systemSkills.list(owner);
        for (const row of snapshot.skills.values()) {
          if (known.has(row.id) || !validSkill(row)) continue;
          const builtin = row.builtin === 1 ? builtins().find(b => b.skill.name === row.name) : undefined;
          if (builtin && installed.some(s => s.slug === builtin.slug) && !this.bindings(owner).some(b => b.slug === builtin.slug)) {
            this.bind(owner, row.id, builtin.slug, builtin.slug);
            continue;
          }
          try { this.store.db.transaction(() => this.create(owner, row, [...snapshot.refs.values()].filter(r => r.skillId === row.id)))(); }
          catch (error) {
            if (!(error instanceof Error) || !['invalid_skill', 'invalid_skill_reference', 'skill_package_too_large'].includes(error.message)) throw error;
          }
        }
        for (const builtin of builtins()) {
          if (this.bindings(owner).some(b => b.builtin_slug === builtin.slug || b.slug === builtin.slug)) continue;
          // Existing packages, including user-modified builtins, are never overwritten.
          if (fs.existsSync(path.join(this.store.systemSkills.directory(owner), builtin.slug))) continue;
          const id = builtinId(builtin.skill.name);
          if (this.bindings(owner).some(b => b.skill_id === id)) continue;
          const row = { ...builtin.skill, id, enabled: 1, builtin: 1, updatedAt: 0 };
          const refs = [...builtin.refs].map(([file, body]) => ({ id: builtinId(`${row.name}/${file}`), skillId: id, path: file, body }));
          this.create(owner, row, refs, builtin.text, builtin.slug);
          this.project(owner, 'skills', id, row);
          for (const ref of refs) this.project(owner, 'skillRefs', ref.id, ref);
        }
      });
      const physical = this.store.systemSkills.list(owner), snapshot = this.snapshot(owner);
      this.store.transaction(() => {
        for (const skill of physical) {
          let binding = this.bindings(owner).find(b => b.slug === skill.slug);
          binding ??= this.bind(owner, skill.id, skill.slug, null);
          const previous = snapshot.skills.get(binding.skill_id);
          const next: Row = { ...previous, id: binding.skill_id, name: skill.name, description: skill.description, body: skill.body,
            enabled: skill.enabled, builtin: binding.builtin_slug ? 1 : previous?.builtin ?? 0, updatedAt: previous?.updatedAt ?? skill.updatedAt };
          if (skill.mcpRequired) next.mcpRequired = skill.mcpRequired; else delete next.mcpRequired;
          if (previous && !isDeepStrictEqual(previous, next)) next.updatedAt = skill.updatedAt;
          this.project(owner, 'skills', binding.skill_id, next);
          const refs = references(path.join(this.store.systemSkills.directory(owner), skill.slug));
          const oldRefs = [...snapshot.refs.values()].filter(r => r.skillId === binding.skill_id);
          for (const [file, body] of refs) {
            const old = oldRefs.find(r => r.path === file);
            const id = old?.id ?? 2 ** 52 + Number.parseInt(crypto.createHash('sha256').update(`${owner}\0${binding.skill_id}\0${file}`).digest('hex').slice(0, 12), 16);
            this.project(owner, 'skillRefs', id, { ...old, id, skillId: binding.skill_id, path: file, body });
          }
          for (const old of oldRefs) if (!refs.has(old.path)) this.project(owner, 'skillRefs', old.id, null);
        }
        for (const binding of this.bindings(owner)) {
          if (physical.some(s => s.slug === binding.slug)) continue;
          const filename = path.join(this.store.systemSkills.directory(owner), binding.slug, 'SKILL.md');
          if (fs.existsSync(filename)) {
            const row = snapshot.skills.get(binding.skill_id);
            if (row) this.project(owner, 'skills', binding.skill_id, { ...row, enabled: 0 });
          } else {
            this.project(owner, 'skills', binding.skill_id, null);
            for (const ref of snapshot.refs.values()) if (ref.skillId === binding.skill_id) this.project(owner, 'skillRefs', ref.id, null);
          }
        }
      });
      return physical;
    } finally { this.syncing = false; }
  }

  /** Called inside the cloud mutation transaction; only changed fields/files are written. */
  writeChanges(owner: string, before: Snapshot) {
    const after = this.snapshot(owner);
    for (const id of new Set([...before.skills.keys(), ...after.skills.keys()])) {
      const previous = before.skills.get(id), next = after.skills.get(id);
      const oldRefs = [...before.refs.values()].filter(r => r.skillId === id), refs = [...after.refs.values()].filter(r => r.skillId === id);
      if (isDeepStrictEqual(previous, next) && isDeepStrictEqual(oldRefs, refs)) continue;
      const binding = this.bindings(owner).find(b => b.skill_id === id);
      if (!binding) { if (next) this.create(owner, next, refs); continue; }
      if (next && !validSkill(next)) throw new Error('invalid_skill');
      if (refs.length > 190 || refs.some(r => !referencePath(r.path) || typeof r.body !== 'string')) throw new Error('invalid_skill_reference');
      if (next && Buffer.byteLength(markdown(next as SkillFile)) + refs.reduce((size, r) => size + Buffer.byteLength(r.body), 0) > 16 * 1024 * 1024) throw new Error('skill_package_too_large');
      if (!next) {
        this.stage(owner, binding.slug, 'SKILL.md', null);
      } else {
        const filename = resource(binding.slug, 'SKILL.md');
        const current = this.store.systemFiles.read(owner, filename);
        if (!previous || ['name', 'description', 'body', 'mcpRequired'].some(key => !isDeepStrictEqual(previous[key], next[key]))) this.stage(owner, binding.slug, 'SKILL.md', markdown(next as SkillFile, current));
        if (!previous || previous.enabled !== next.enabled) {
          const metadata = JSON.parse(this.store.systemFiles.read(owner, resource(binding.slug, '.wangke-skill.json')) ?? '{}');
          this.stage(owner, binding.slug, '.wangke-skill.json', JSON.stringify({ ...metadata, enabled: next.enabled === 1 }));
        }
      }
      const keep = next ? refs : [];
      for (const ref of keep) if (!oldRefs.some(old => old.path === ref.path && old.body === ref.body)) this.stage(owner, binding.slug, ref.path, ref.body);
      for (const old of oldRefs) if (!keep.some(ref => ref.path === old.path)) this.stage(owner, binding.slug, old.path, null);
    }
  }
}
