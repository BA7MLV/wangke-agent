import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { intersectSkillMetaIds } from '../../../../src/skills/scope.js';
import { parseSkillMarkdown } from '../../../../src/skills/types.js';
import type { DatabaseStore } from '../storage/database.js';

type Skill = { id: number; name: string; description: string; body: string; enabled: number; updatedAt: number; mcpRequired?: string[]; builtinPath?: string };
const builtinRoot = fileURLToPath(new URL('../../../../src/skills/builtin/', import.meta.url));
let builtins: Skill[] | undefined;
function builtinSkills() {
  return builtins ??= ['diagramming', 'interactive-explainer', 'library-organizer', 'course-handout', 'question-bank'].map((directory, index) => {
    const filename = path.join(builtinRoot, directory, 'SKILL.md');
    return { ...parseSkillMarkdown('SKILL.md', fs.readFileSync(filename, 'utf8')), id: -index - 1, enabled: 1, updatedAt: fs.statSync(filename).mtimeMs, builtinPath: path.dirname(filename) };
  });
}
export class BotSkills {
  constructor(readonly store: DatabaseStore) {}
  private available(owner: string, thread: string) {
    const row = this.store.db.prepare('SELECT skill_ids,mcp_server_ids FROM threads WHERE id=? AND owner_id=?').get(thread, owner) as { skill_ids: string | null; mcp_server_ids: string | null } | undefined;
    if (!row) throw new Error('thread_not_found');
    const saved = (this.store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='skills' AND value IS NOT NULL").all(owner) as Array<{ value: string }>).map(r => JSON.parse(r.value) as Skill);
    const combined = [...saved, ...builtinSkills().filter(b => !saved.some(s => s.name === b.name))].filter(s => s.enabled === 1);
    const allowed = new Set(intersectSkillMetaIds(combined, row.skill_ids === null ? undefined : JSON.parse(row.skill_ids)));
    const mcp = (this.store.db.prepare('SELECT id,config FROM mcp_servers WHERE owner_id=?').all(owner) as Array<{ id: string; config: string }>).map(r => ({ id: r.id, ...JSON.parse(r.config) as { name: string; enabled: boolean } }));
    const scope = row.mcp_server_ids === null ? undefined : JSON.parse(row.mcp_server_ids) as string[];
    return combined.filter(s => allowed.has(s.id)).map(s => ({ ...s, missingMcp: (s.mcpRequired ?? []).filter(name => !mcp.some(m => m.name === name && m.enabled && (scope === undefined || scope.includes(m.id)))) }));
  }
  catalog(owner: string, thread: string) {
    return this.available(owner, thread).map(({ id, name, description, updatedAt, missingMcp }) => ({ id, name, description, revision: updatedAt, missingMcp }));
  }
  load(owner: string, thread: string, id: number, reference?: string) {
    const skill = this.available(owner, thread).find(s => s.id === id);
    if (!skill) throw new Error('skill_not_available');
    if (skill.missingMcp.length) return { error: 'skill_mcp_dependency_missing', missingMcp: skill.missingMcp, hint: 'Enable/grant dependencies explicitly in MCP settings. Nothing was installed or authorized.' };
    if (reference !== undefined) {
      if (!/^references\/[a-zA-Z0-9_/-]+\.md$/.test(reference) || reference.includes('..')) throw new Error('invalid_skill_reference');
      const stored = (this.store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='skillRefs' AND value IS NOT NULL").all(owner) as Array<{ value: string }>).map(r => JSON.parse(r.value) as { skillId: number; path: string; body: string }).find(r => r.skillId === id && r.path === reference);
      const body = stored?.body ?? (skill.builtinPath && fs.existsSync(path.join(skill.builtinPath, reference)) ? fs.readFileSync(path.join(skill.builtinPath, reference), 'utf8') : undefined);
      if (body === undefined) throw new Error('skill_reference_not_found');
      return { id, reference, body, revision: skill.updatedAt, source: skill.builtinPath ? 'builtin' : 'synced' };
    }
    return { id, name: skill.name, body: skill.body, revision: skill.updatedAt, source: skill.builtinPath ? 'builtin' : 'synced' };
  }
}
