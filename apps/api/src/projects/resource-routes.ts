import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ResourceFiles } from './resources.js';
import { ProjectError } from './files.js';
import { byteRange } from '../cloud/files.js';

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
  app.get<{ Params: { id: string } }>('/api/v1/resources/courses/:id', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const mapped = resources.course(user.id, request.params.id);
    const file = resources.projects.files.open(mapped.project_id, mapped.path);
    const course = resources.records.get(user.id, 'videos', request.params.id);
    reply.type(course?.mimeType ?? 'application/octet-stream').header('accept-ranges', 'bytes')
      .header('content-disposition', 'attachment').header('x-content-type-options', 'nosniff');
    const range = byteRange(request.headers.range, file.size);
    if (range === false) { fs.closeSync(file.fd); return reply.code(416).header('content-range', `bytes */${file.size}`).send(); }
    if (range) reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${file.size}`).header('content-length', range.end - range.start + 1);
    else reply.header('content-length', file.size);
    return reply.send(fs.createReadStream('', { fd: file.fd, autoClose: true, ...(range || {}) }));
  });
  app.post<{ Params: { id: string }; Body: { text: string; expected: string } }>('/api/v1/resources/courses/:id/text', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    return resources.saveText(user.id, request.params.id, request.body?.text, request.body?.expected);
  });
}
