import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { intersectSkillMetaIds } from '@wangke/study-core/skills/scope';
import { parseSkillMarkdown } from '@wangke/study-core/skills/parser';
import type { DatabaseStore } from '../storage/database.js';

type Skill = { id: number; name: string; description: string; body: string; enabled: number; updatedAt: number; mcpRequired?: string[] };
const builtinRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@wangke/study-core/skills/assets'))), '..');
// Filesystem capabilities never travel in synchronized JSON, even when it
// claims to be a builtin. Only this module can populate the trusted map.
const builtinPaths = new Map<Skill, string>();
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function parse(value: string): Record<string, unknown> | undefined { try { return object(JSON.parse(value)); } catch { return undefined; } }
function synced(value: string): Skill | undefined {
  const r = parse(value);
  if (!r || !Number.isSafeInteger(r.id) || Number(r.id) <= 0 || !['name', 'description', 'body'].every(k => typeof r[k] === 'string') || ![0, 1].includes(Number(r.enabled)) || typeof r.enabled !== 'number' || typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return;
  if (r.mcpRequired !== undefined && (!Array.isArray(r.mcpRequired) || !r.mcpRequired.every(v => typeof v === 'string'))) return;
  return { id: Number(r.id), name: String(r.name), description: String(r.description), body: String(r.body), enabled: r.enabled, updatedAt: r.updatedAt, mcpRequired: r.mcpRequired as string[] | undefined };
}
let builtins: Skill[] | undefined;
function builtinSkills() {
  return builtins ??= ['diagramming', 'interactive-explainer', 'library-organizer', 'course-handout', 'question-bank'].map((directory, index) => {
    const filename = path.join(builtinRoot, directory, 'SKILL.md');
    const skill = { ...parseSkillMarkdown('SKILL.md', fs.readFileSync(filename, 'utf8')), id: -index - 1, enabled: 1, updatedAt: fs.statSync(filename).mtimeMs };
    builtinPaths.set(skill, path.dirname(filename));
    return skill;
  });
}
export class BotSkills {
  constructor(readonly store: DatabaseStore) {}
  private available(owner: string, thread: string) {
    const row = this.store.db.prepare('SELECT skill_ids,mcp_server_ids FROM threads WHERE id=? AND owner_id=?').get(thread, owner) as { skill_ids: string | null; mcp_server_ids: string | null } | undefined;
    if (!row) throw new Error('thread_not_found');
    const saved = (this.store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='skills' AND value IS NOT NULL").all(owner) as Array<{ value: string }>).flatMap(r => { const s = synced(r.value); return s ? [s] : []; });
    const combined = [...saved, ...builtinSkills().filter(b => !saved.some(s => s.name === b.name))].filter(s => s.enabled === 1);
    const allowed = new Set(intersectSkillMetaIds(combined, row.skill_ids === null ? undefined : JSON.parse(row.skill_ids)));
    const mcp = (this.store.db.prepare('SELECT id,config FROM mcp_servers WHERE owner_id=?').all(owner) as Array<{ id: string; config: string }>).map(r => ({ id: r.id, ...JSON.parse(r.config) as { name: string; enabled: boolean } }));
    const scope = row.mcp_server_ids === null ? undefined : JSON.parse(row.mcp_server_ids) as string[];
    return combined.filter(s => allowed.has(s.id)).map(s => ({ skill: s, ...s, missingMcp: (s.mcpRequired ?? []).filter(name => !mcp.some(m => m.name === name && m.enabled && (scope === undefined || scope.includes(m.id)))) }));
  }
  catalog(owner: string, thread: string) {
    return this.available(owner, thread).map(({ id, name, description, updatedAt, missingMcp }) => ({ id, name, description, revision: updatedAt, missingMcp: [...missingMcp].sort() })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id);
  }
  load(owner: string, thread: string, id: number, reference?: string) {
    const skill = this.available(owner, thread).find(s => s.id === id);
    if (!skill) throw new Error('skill_not_available');
    if (skill.missingMcp.length) return { error: 'skill_mcp_dependency_missing', missingMcp: skill.missingMcp, hint: 'Enable/grant dependencies explicitly in MCP settings. Nothing was installed or authorized.' };
    if (reference !== undefined) {
      if (!/^references\/[a-zA-Z0-9_/-]+\.md$/.test(reference) || reference.includes('..')) throw new Error('invalid_skill_reference');
      const builtinPath = builtinPaths.get(skill.skill);
      const stored = (this.store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='skillRefs' AND value IS NOT NULL").all(owner) as Array<{ value: string }>).map(r => parse(r.value)).find(r => r?.skillId === id && r.path === reference && typeof r.body === 'string');
      let body = !builtinPath && stored ? String(stored.body) : undefined;
      if (builtinPath && fs.existsSync(path.join(builtinPath, reference))) {
        const root = fs.realpathSync(builtinRoot), filename = path.join(builtinPath, reference);
        // Reject symlinks in every component, not just escapes at the leaf.
        let component = builtinRoot;
        for (const part of path.relative(builtinRoot, filename).split(path.sep)) { component = path.join(component, part); if (fs.lstatSync(component).isSymbolicLink()) throw new Error('invalid_skill_reference'); }
        const real = fs.realpathSync(filename);
        if (!real.startsWith(`${root}${path.sep}`) || !fs.statSync(real).isFile()) throw new Error('invalid_skill_reference');
        body = fs.readFileSync(real, 'utf8');
      }
      if (body === undefined) throw new Error('skill_reference_not_found');
      return { id, reference, body, revision: skill.updatedAt, source: builtinPath ? 'builtin' : 'synced' };
    }
    return { id, name: skill.name, body: skill.body, revision: skill.updatedAt, source: builtinPaths.has(skill.skill) ? 'builtin' : 'synced' };
  }
}
