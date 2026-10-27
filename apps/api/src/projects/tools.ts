import type { AgentPolicy } from '../../../../packages/contracts/src/cloud.js';
import type { ProjectThread, ProjectRepository } from './repository.js';
import { ProjectError } from './files.js';

const tool = (name: string, description: string, properties: object, required: string[]) => ({ type: 'function' as const, function: { name, description, parameters: { type: 'object', additionalProperties: false, properties, required } } });
const workspaceTool = tool('workspace', 'Access ONLY this project workspace. list/read are read-only. write creates or replaces a UTF-8 file; expectedRevision must be null to create, or the revision returned by read to replace. mkdir creates one directory. remove requires the revision from list and only removes files or empty directories. Paths are relative; use path="" to list the root. read/list support offset for pagination. Files are shared by all project sessions; chat histories are separate.', {
  action: { type: 'string', enum: ['list', 'read', 'write', 'mkdir', 'remove'] }, path: { type: 'string' },
  text: { type: 'string' }, expectedRevision: { type: ['string', 'null'] }, offset: { type: 'integer', minimum: 0 },
}, ['action', 'path']);
const projectsTool = tool('projects', 'List authorized projects, create a project (name required), or rename a project with a manage grant. A created project grants this Bot manage access and returns a link for the user to open its workspace. Renaming never changes its ID or workspace path. To work with project files, the user opens a session in that project.', {
  action: { type: 'string', enum: ['list', 'create', 'rename'] }, projectId: { type: 'string' }, name: { type: 'string' },
}, ['action']);

export class ProjectTools {
  constructor(private projects: ProjectRepository) {}
  definitions(thread: ProjectThread) { return thread.project_id ? [workspaceTool] : thread.agent_id ? [projectsTool] : []; }
  handles(name: string) { return name === 'workspace' || name === 'projects'; }

  private capability(name: string, args: Record<string, unknown>): 'read' | 'write' | 'remove' {
    const allowed = name === 'workspace' ? ['action', 'path', 'text', 'expectedRevision', 'offset'] : ['action', 'projectId', 'name'];
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new ProjectError('invalid_project_tool_arguments');
    if (name === 'workspace') {
      if (!['list', 'read', 'write', 'mkdir', 'remove'].includes(String(args.action)) || typeof args.path !== 'string') throw new ProjectError('invalid_project_tool_arguments');
      if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0)) throw new ProjectError('invalid_project_tool_arguments');
      return args.action === 'remove' ? 'remove' : ['write', 'mkdir'].includes(String(args.action)) ? 'write' : 'read';
    }
    if (!['list', 'create', 'rename'].includes(String(args.action))) throw new ProjectError('invalid_project_tool_arguments');
    if (args.action !== 'list' && (typeof args.name !== 'string' || !args.name.trim() || args.name.trim().length > 100)) throw new ProjectError('invalid_project_name');
    if (args.action !== 'rename' && args.projectId !== undefined) throw new ProjectError('invalid_project_tool_arguments');
    return args.action === 'list' ? 'read' : 'write';
  }

  permission(name: string, args: Record<string, unknown>, thread: ProjectThread, policy: AgentPolicy) {
    const capability = this.capability(name, args);
    if (name === 'workspace') {
      if (!thread.project_id) throw new ProjectError('project_access_denied', 403);
      this.projects.authorize(thread.owner_id, thread.project_id, thread.agent_id, capability === 'read' ? 'read' : 'write');
    } else {
      if (thread.project_id || !thread.agent_id) throw new ProjectError('project_access_denied', 403);
      this.projects.agent(thread.owner_id, thread.agent_id);
      if (args.action === 'rename') {
        if (typeof args.projectId !== 'string') throw new ProjectError('invalid_project_tool_arguments');
        this.projects.authorize(thread.owner_id, args.projectId, thread.agent_id, 'manage');
      }
    }
    return capability === 'remove' && policy.remove === 'allow' ? 'ask' : policy[capability];
  }

  execute(name: string, args: Record<string, unknown>, thread: ProjectThread): string {
    if (name === 'projects') {
      if (args.action === 'create') {
        const project = this.projects.create(thread.owner_id, args.name, thread.agent_id!, 'manage');
        return JSON.stringify({ ...project, url: `#/projects/${project.id}` });
      }
      if (args.action === 'rename') return JSON.stringify(this.projects.update(thread.owner_id, String(args.projectId), { name: args.name }));
      return JSON.stringify(this.projects.list(thread.owner_id).filter(p => !p.archived && this.projects.get(thread.owner_id, p.id).grants.some(g => g.agentId === thread.agent_id)).map(({ id, name, workspacePath }) => ({ id, name, workspacePath })));
    }
    const id = thread.project_id!;
    const filename = String(args.path);
    const offset = Number(args.offset ?? 0);
    if (args.action === 'list') {
      const files = this.projects.files.list(id, filename);
      const page = [];
      for (const file of files.slice(offset, offset + 100)) {
        if (page.length && JSON.stringify([...page, file]).length > 12000) break;
        page.push(file);
      }
      return JSON.stringify({ files: page, nextOffset: offset + page.length < files.length ? offset + page.length : null });
    }
    if (args.action === 'read') {
      const file = this.projects.files.read(id, filename);
      let length = 10000;
      while (JSON.stringify({ ...file, text: file.text.slice(offset, offset + length) }).length > 14000) length = Math.floor(length / 2);
      return JSON.stringify({ ...file, text: file.text.slice(offset, offset + length), nextOffset: offset + length < file.text.length ? offset + length : null });
    }
    if (args.action === 'write') return JSON.stringify(this.projects.files.write(id, filename, args.text as string, args.expectedRevision as string | null));
    if (args.action === 'mkdir') this.projects.files.mkdir(id, filename);
    else this.projects.files.remove(id, filename, args.expectedRevision as string);
    return JSON.stringify({ ok: true, path: filename });
  }
}
