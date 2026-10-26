import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import type { ProjectDetailDto, ProjectDto, ProjectGrantDto, ProjectPolicy, ProjectRole } from '../../../../packages/contracts/src/projects.js';
import { ProjectError, ProjectFiles } from './files.js';

interface ProjectRow {
  id: string; owner_id: string; name: string; instructions: string;
  shell_policy: ProjectPolicy['shell']; network_policy: ProjectPolicy['network'];
  archived: number; created_at: string; updated_at: string;
}
export interface ProjectThread { id: string; owner_id: string; project_id: string | null; agent_id: string | null; archived: number }
const timestamp = () => new Date().toISOString();
const dto = (row: ProjectRow): ProjectDto => ({ id: row.id, name: row.name, instructions: row.instructions, workspacePath: `projects/${row.id}`, policy: { shell: row.shell_policy, network: row.network_policy }, archived: Boolean(row.archived), createdAt: row.created_at, updatedAt: row.updated_at });
const nameOf = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f]/.test(value)) throw new ProjectError('invalid_project_name');
  return value.trim();
};

export class ProjectRepository {
  readonly files: ProjectFiles;
  isActive: (id: string) => boolean = () => false;
  constructor(readonly store: DatabaseStore, directory: string) { this.files = new ProjectFiles(directory); }

  list(owner: string): ProjectDto[] {
    return (this.store.db.prepare('SELECT * FROM projects WHERE owner_id=? ORDER BY updated_at DESC,id').all(owner) as ProjectRow[]).map(dto);
  }

  get(owner: string, id: string): ProjectDetailDto {
    const row = this.store.db.prepare('SELECT * FROM projects WHERE id=? AND owner_id=?').get(id, owner) as ProjectRow | undefined;
    if (!row) throw new ProjectError('project_not_found', 404);
    const grants = this.store.db.prepare('SELECT agent_id AS agentId,role FROM project_agents WHERE project_id=? ORDER BY agent_id').all(id) as ProjectGrantDto[];
    return { ...dto(row), grants };
  }

  writable(owner: string, id: string) {
    const project = this.get(owner, id);
    if (project.archived) throw new ProjectError('project_archived', 409);
    return project;
  }

  create(owner: string, name: unknown, agentId: string): ProjectDetailDto {
    const cleanName = nameOf(name);
    this.agent(owner, agentId);
    const id = crypto.randomUUID();
    // Create the directory before committing the row: a visible project always
    // has a workspace. A failed DB commit may leave an unreferenced empty UUID directory.
    this.files.create(id);
    const now = timestamp();
    this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, owner, cleanName, now, now);
      this.store.db.prepare('INSERT INTO project_agents(project_id,agent_id,role) VALUES(?,?,?)').run(id, agentId, 'write');
    });
    return this.get(owner, id);
  }

  update(owner: string, id: string, input: { name?: unknown; instructions?: unknown; archived?: unknown; policy?: unknown }) {
    const project = this.get(owner, id);
    const name = input.name === undefined ? project.name : nameOf(input.name);
    const instructions = input.instructions === undefined ? project.instructions : input.instructions;
    if (typeof instructions !== 'string' || instructions.length > 16000 || (input.archived !== undefined && typeof input.archived !== 'boolean')) throw new ProjectError('invalid_project');
    const policy = (input.policy ?? project.policy) as ProjectPolicy;
    if (!policy || !['allow', 'ask', 'deny'].includes(policy.shell) || !['allow', 'deny'].includes(policy.network)) throw new ProjectError('invalid_project_policy');
    this.store.db.prepare('UPDATE projects SET name=?,instructions=?,archived=?,shell_policy=?,network_policy=?,updated_at=? WHERE id=? AND owner_id=?')
      .run(name, instructions, Number(input.archived ?? project.archived), policy.shell, policy.network, timestamp(), id, owner);
    return this.get(owner, id);
  }

  agent(owner: string, id: string) {
    if (typeof id !== 'string' || !this.store.db.prepare('SELECT 1 FROM agent_profiles WHERE id=? AND owner_id=? AND enabled=1').get(id, owner)) throw new ProjectError('agent_not_found', 404);
  }

  grant(owner: string, id: string, agentId: string, role: ProjectRole | null) {
    this.get(owner, id); this.agent(owner, agentId);
    if (role !== null && !['read', 'write', 'manage'].includes(role)) throw new ProjectError('invalid_project_role');
    if (role === null) this.store.db.prepare('DELETE FROM project_agents WHERE project_id=? AND agent_id=?').run(id, agentId);
    else this.store.db.prepare('INSERT INTO project_agents(project_id,agent_id,role) VALUES(?,?,?) ON CONFLICT(project_id,agent_id) DO UPDATE SET role=excluded.role').run(id, agentId, role);
    return this.get(owner, id);
  }

  authorize(owner: string, id: string, agentId: string | null, capability: 'read' | 'write' | 'manage' = 'read') {
    const project = this.writable(owner, id);
    if (!agentId) throw new ProjectError('project_access_denied', 403);
    this.agent(owner, agentId);
    const role = project.grants.find(g => g.agentId === agentId)?.role;
    if (!role || (capability === 'write' && role === 'read') || (capability === 'manage' && role !== 'manage')) throw new ProjectError('project_access_denied', 403);
    return project;
  }

  thread(id: string): ProjectThread {
    const thread = this.store.db.prepare('SELECT id,owner_id,project_id,agent_id,archived FROM threads WHERE id=?').get(id) as ProjectThread | undefined;
    if (!thread) throw new ProjectError('thread_not_found', 404);
    return thread;
  }

  assertIdle(id: string) {
    if (this.isActive(id) || this.hasExecution(id) || this.store.db.prepare("SELECT 1 FROM runs r JOIN threads t ON t.id=r.thread_id WHERE t.project_id=? AND r.status='running' LIMIT 1").get(id)) throw new ProjectError('project_busy', 409);
  }

  hasExecution(id: string) { return Boolean(this.store.db.prepare('SELECT 1 FROM project_executions WHERE project_id=?').get(id)); }
  executions() { return this.store.db.prepare('SELECT project_id AS projectId,execution_id AS executionId FROM project_executions').all() as Array<{ projectId: string; executionId: string }>; }
  beginExecution(projectId: string, executionId: string) { this.store.db.prepare('INSERT INTO project_executions(project_id,execution_id) VALUES(?,?)').run(projectId, executionId); }
  endExecution(executionId: string) { this.store.db.prepare('DELETE FROM project_executions WHERE execution_id=?').run(executionId); }
}
