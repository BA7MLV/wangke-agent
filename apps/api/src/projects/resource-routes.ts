import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ResourceFiles } from './resources.js';
import { ProjectError } from './files.js';
import { sendPrivateFile } from '../cloud/file-response.js';

export function registerResourceRoutes(app: FastifyInstance, resources: ResourceFiles,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => { id: string } | null,
  checkOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean) {
  app.get<{ Querystring: { projectId?: string; path?: string; archived?: string } }>('/api/v1/resources', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    return resources.list(user.id, request.query.projectId, request.query.path ?? '', request.query.archived === 'true');
  });
  app.post<{ Body: { name: string } }>('/api/v1/resources/folders', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    resources.migrate(user.id);
    // A folder exists independently of any Bot. Granting a Bot is optional.
    const project = resources.projects.create(user.id, request.body?.name);
    resources.list(user.id, project.id);
    return reply.code(201).send(project);
  });
  app.post<{ Body: { projectId: string; path: string; targetProjectId: string; target: string; revision: string } }>('/api/v1/resources/move', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const b = request.body;
    if (!b || !['projectId', 'path', 'targetProjectId', 'target', 'revision'].every(k => typeof b[k as keyof typeof b] === 'string')) throw new ProjectError('invalid_project_path');
    resources.move(user.id, b.projectId, b.path, b.targetProjectId, b.target, b.revision);
    return { moved: true };
  });
  const readCourse = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const file = resources.openCourse(user.id, request.params.id);
    return sendPrivateFile(request, reply, file, file.mimeType);
  };
  // Fastify's automatically generated HEAD route recalculates Content-Length
  // from its empty payload. An explicit route preserves the actual file size.
  app.head('/api/v1/resources/courses/:id', readCourse);
  app.get('/api/v1/resources/courses/:id', { exposeHeadRoute: false }, readCourse);
  app.post<{ Params: { id: string }; Body: { text: string; expected: string } }>('/api/v1/resources/courses/:id/text', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    return resources.saveText(user.id, request.params.id, request.body?.text, request.body?.expected);
  });
}
