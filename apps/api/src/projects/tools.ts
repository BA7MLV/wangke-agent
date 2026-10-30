import type { AgentPolicy } from '@wangke/contracts/cloud';
import type { ProjectThread, ProjectRepository } from './repository.js';
import { ProjectError } from './files.js';

const tool = (name: string, description: string, properties: object, required: string[]) => ({ type: 'function' as const, function: { name, description, parameters: { type: 'object', additionalProperties: false, properties, required } } });
const workspaceTool = tool('workspace', 'Access real files in every resource project owned by the current user. In ordinary Bot conversations, paths default to the Bot folder, also mounted as shell /workspace. Use projects list for exact projectIds, then pass projectId to read/list/write/mkdir/remove when working in another project; never guess IDs or prepend Bot/ to default paths. The /system scope is available through read/grep/edit without approval for reads/creates/edits; shell writes there use systemWrite=true, while deletion still requires approval. list/read are read-only. write creates or replaces UTF-8 text: expectedRevision=null to create, or the revision from read to replace. mkdir creates one directory; create parents first. remove requires the revision from list and only removes files or empty directories. read/list support offset. Changing projectId for a tool call never changes the shell workspace.', {
  action: { type: 'string', enum: ['list', 'read', 'write', 'mkdir', 'remove'] }, path: { type: 'string' }, projectId: { type: 'string' },
  text: { type: 'string' }, expectedRevision: { type: ['string', 'null'] }, offset: { type: 'integer', minimum: 0 },
}, ['action', 'path']);
const projectsTool = tool('projects', 'List every resource project owned by the current user with exact projectIds, including defaultWorkspace/resourceRoot markers and archived state. The /system scope is a separate owner-scoped system resource available through read/grep/edit and shell. create makes a subdirectory INSIDE the default Bot folder (name required; optional path is an existing parent relative to Bot). Use workspace mkdir for deeper task organization. rename still requires a manage grant and projectId; IDs and physical workspace paths stay stable.', {
  action: { type: 'string', enum: ['list', 'create', 'rename'] }, projectId: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' },
}, ['action']);

export class ProjectTools {
  constructor(private projects: ProjectRepository) {}
  definitions(thread: ProjectThread) { return thread.agent_id ? [workspaceTool, projectsTool] : []; }
  handles(name: string) { return name === 'workspace' || name === 'projects'; }
  parallelSafe(name: string, args: Record<string, unknown>) {
    return name === 'workspace' && ['list', 'read'].includes(String(args.action));
  }

  private capability(name: string, args: Record<string, unknown>): 'read' | 'write' | 'remove' {
    const allowed = name === 'workspace' ? ['action', 'path', 'projectId', 'text', 'expectedRevision', 'offset'] : ['action', 'projectId', 'name', 'path'];
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new ProjectError('invalid_project_tool_arguments');
    if (name === 'workspace') {
      if (!['list', 'read', 'write', 'mkdir', 'remove'].includes(String(args.action)) || typeof args.path !== 'string') throw new ProjectError('invalid_project_tool_arguments');
      if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0)) throw new ProjectError('invalid_project_tool_arguments');
      return args.action === 'remove' ? 'remove' : ['write', 'mkdir'].includes(String(args.action)) ? 'write' : 'read';
    }
    if (!['list', 'create', 'rename'].includes(String(args.action))) throw new ProjectError('invalid_project_tool_arguments');
    if (args.action !== 'list' && (typeof args.name !== 'string' || !args.name.trim() || args.name.trim().length > 100)) throw new ProjectError('invalid_project_name');
    if (args.action !== 'rename' && args.projectId !== undefined) throw new ProjectError('invalid_project_tool_arguments');
    if (args.path !== undefined && (args.action !== 'create' || typeof args.path !== 'string')) throw new ProjectError('invalid_project_tool_arguments');
    if (args.action === 'create' && (/[\\/]/.test(String(args.name)) || ['.', '..'].includes(String(args.name).trim()))) throw new ProjectError('invalid_project_name');
    return args.action === 'list' ? 'read' : 'write';
  }

  private workspace(thread: ProjectThread, projectId: unknown) {
    if (projectId !== undefined && (typeof projectId !== 'string' || !projectId)) throw new ProjectError('invalid_project_tool_arguments');
    const id = (projectId as string | undefined) ?? this.projects.workspaceId(thread);
    if (!id) throw new ProjectError('project_access_denied', 403);
    return id;
  }

  permission(name: string, args: Record<string, unknown>, thread: ProjectThread, policy: AgentPolicy) {
    const capability = this.capability(name, args);
    if (name === 'workspace') {
      this.projects.authorizeBot(thread.owner_id, this.workspace(thread, args.projectId), thread.agent_id, capability === 'read' ? 'read' : 'write');
    } else {
      if (!thread.agent_id) throw new ProjectError('project_access_denied', 403);
      this.projects.agent(thread.owner_id, thread.agent_id);
      if (args.action === 'create') this.projects.authorizeBot(thread.owner_id, this.workspace(thread, undefined), thread.agent_id, 'write');
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
        const id = this.workspace(thread, undefined);
        const filename = [args.path, String(args.name).trim()].filter(Boolean).join('/');
        this.projects.files.mkdir(id, filename);
        return JSON.stringify({ projectId: id, path: filename, url: `#/library?folder=${id}&path=${encodeURIComponent(filename)}` });
      }
      if (args.action === 'rename') return JSON.stringify(this.projects.update(thread.owner_id, String(args.projectId), { name: args.name }));
      const workspace = this.projects.workspaceId(thread), root = this.projects.resourceRoot(thread.owner_id);
      return JSON.stringify(this.projects.list(thread.owner_id).map(({ id, name, workspacePath, archived }) => ({ id, name, workspacePath, archived, defaultWorkspace: id === workspace, resourceRoot: id === root })));
    }
    const id = this.workspace(thread, args.projectId);
    if (id !== this.projects.workspaceId(thread)) this.projects.assertIdle(id);
    const filename = String(args.path);
    const offset = Number(args.offset ?? 0);
    if (args.action === 'list') {
      const files = this.projects.files.list(id, filename);
      const page = [];
      for (const file of files.slice(offset, offset + 100)) {
        if (page.length && JSON.stringify([...page, file]).length > 12000) break;
        page.push(file);
      }
      return JSON.stringify({ projectId: id, path: filename, files: page, nextOffset: offset + page.length < files.length ? offset + page.length : null });
    }
    if (args.action === 'read') {
      const file = this.projects.files.read(id, filename);
      let length = 10000;
      while (JSON.stringify({ ...file, text: file.text.slice(offset, offset + length) }).length > 14000) length = Math.floor(length / 2);
      return JSON.stringify({ projectId: id, ...file, text: file.text.slice(offset, offset + length), nextOffset: offset + length < file.text.length ? offset + length : null });
    }
    if (args.action === 'write') return JSON.stringify({ projectId: id, ...this.projects.files.write(id, filename, args.text as string, args.expectedRevision as string | null) });
    if (args.action === 'mkdir') this.projects.files.mkdir(id, filename);
    else this.projects.files.remove(id, filename, args.expectedRevision as string);
    return JSON.stringify({ ok: true, projectId: id, path: filename });
  }
}
