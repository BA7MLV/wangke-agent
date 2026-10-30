import { intersectSkillMetaIds } from '@wangke/study-core/skills/scope';
import type { DatabaseStore } from '../storage/database.js';

// Keep historical Bot scopes (-1 … -5) working after builtin materialization.
const builtinAliases = ['diagramming', 'interactive-explainer', 'library-organizer', 'course-handout', 'question-bank'];
export class BotSkills {
  constructor(readonly store: DatabaseStore) {}
  private available(owner: string, thread: string) {
    const row = this.store.db.prepare('SELECT skill_ids,mcp_server_ids FROM threads WHERE id=? AND owner_id=?').get(thread, owner) as { skill_ids: string | null; mcp_server_ids: string | null } | undefined;
    if (!row) throw new Error('thread_not_found');
    const bindings = () => this.store.db.prepare('SELECT skill_id,builtin_slug FROM system_skill_bindings WHERE owner_id=?').all(owner) as Array<{ skill_id: number; builtin_slug: string | null }>;
    const physical = this.store.skillRecords.sync(owner);
    const aliases = new Map(bindings().flatMap(b => {
      const index = builtinAliases.indexOf(b.builtin_slug ?? '');
      return index < 0 ? [] : [[-index - 1, b.skill_id] as const];
    }));
    const legacy = new Set(bindings().filter(b => b.builtin_slug && !builtinAliases.includes(b.builtin_slug)).map(b => b.skill_id));
    const combined = physical.filter(s => s.enabled === 1 && !legacy.has(s.id));
    const scopeIds: number[] | undefined = row.skill_ids === null ? undefined : JSON.parse(row.skill_ids).map((id: number) => aliases.get(id) ?? id);
    const allowed = new Set(intersectSkillMetaIds(combined, scopeIds));
    let mcp: Array<{ id: string; name: string; enabled: boolean }>;
    try { mcp = this.store.systemMcp.sync(owner); }
    catch { mcp = []; } // Invalid MCP files never satisfy a skill dependency.
    const scope = row.mcp_server_ids === null ? undefined : JSON.parse(row.mcp_server_ids) as string[];
    return { aliases, skills: combined.filter(s => allowed.has(s.id)).map(s => ({ ...s,
      missingMcp: (s.mcpRequired ?? []).filter(name => !mcp.some(m => m.name === name && m.enabled && (scope === undefined || scope.includes(m.id)))) })) };
  }
  catalog(owner: string, thread: string) {
    return this.available(owner, thread).skills.map(({ id, name, description, revision, missingMcp }) => ({ id, name, description, revision, missingMcp: [...missingMcp].sort() })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id);
  }
  load(owner: string, thread: string, id: number, reference?: string) {
    const { aliases, skills } = this.available(owner, thread);
    const actual = aliases.get(id) ?? id;
    const skill = skills.find(s => s.id === actual);
    if (!skill) throw new Error('skill_not_available');
    if (skill.missingMcp.length) return { error: 'skill_mcp_dependency_missing', missingMcp: skill.missingMcp, hint: 'Enable/grant dependencies explicitly in MCP settings. Nothing was installed or authorized.' };
    const result = this.store.systemSkills.load(owner, actual, reference);
    if (!result) throw new Error('skill_not_available');
    return { ...result, id };
  }
}
