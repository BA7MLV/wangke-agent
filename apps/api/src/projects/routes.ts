import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ProjectRole } from '@wangke/contracts/projects';
import { ProjectError } from './files.js';
import { ProjectRepository } from './repository.js';
import { uploadedImageMime } from '../cloud/image.js';
import { imageFileName, safeFileName } from '../cloud/file-names.js';

export function registerProjectRoutes(app: FastifyInstance, deps: {
  projects: ProjectRepository;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => { id: string } | null;
  checkOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  stopProject: (id: string) => void;
  maxFileBytes: number;
}) {
  const { projects } = deps;
  const auth = (request: FastifyRequest, reply: FastifyReply) => {
    if (!['GET', 'HEAD'].includes(request.method) && !deps.checkOrigin(request, reply)) return null;
    return deps.requireAuth(request, reply);
  };
  const audit = (owner: string, action: string, projectId: string) => {
    projects.store.db.prepare('INSERT INTO cloud_audit(owner_id,action,detail,created_at) VALUES(?,?,?,?)').run(owner, action, JSON.stringify({ projectId }), new Date().toISOString());
  };
  // Path-based access on macOS is a development fallback. Linux uses openat-like
  // descriptor walks; on macOS don't let sandbox commands race file access.
  const readable = (owner: string, id: string) => {
    projects.get(owner, id);
    if (process.platform !== 'linux') projects.assertIdle(id);
  };
  const writable = (owner: string, id: string) => { projects.writable(owner, id); projects.assertIdle(id); };
  type Location = { Params: { id: string }; Querystring: { path?: string } };

  app.get('/api/v1/projects', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    return { projects: projects.list(user.id) };
  });
  app.post<{ Body: { name?: unknown; agentId?: string } }>('/api/v1/projects', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    const result = projects.create(user.id, request.body?.name, request.body?.agentId ?? '');
    audit(user.id, 'project.created', result.id);
    return reply.code(201).send(result);
  });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    return projects.get(user.id, request.params.id);
  });
  app.patch<{ Params: { id: string }; Body: { name?: unknown; instructions?: unknown; archived?: unknown; policy?: unknown } }>('/api/v1/projects/:id', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    const body = request.body;
    if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['name', 'instructions', 'archived', 'policy'].includes(k))) throw new ProjectError('invalid_project');
    const previous = projects.get(user.id, request.params.id);
    const result = projects.update(user.id, request.params.id, body);
    if ((!previous.archived && result.archived) || result.instructions !== previous.instructions || result.policy.shell !== previous.policy.shell || result.policy.network !== previous.policy.network) deps.stopProject(result.id);
    audit(user.id, 'project.updated', result.id);
    return result;
  });
  app.put<{ Params: { id: string; agentId: string }; Body: { role: ProjectRole | null } }>('/api/v1/projects/:id/agents/:agentId', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    const result = projects.grant(user.id, request.params.id, request.params.agentId, request.body?.role);
    deps.stopProject(result.id);
    audit(user.id, 'project.grant.updated', result.id);
    return result;
  });
  app.get<Location>('/api/v1/projects/:id/files', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    readable(user.id, request.params.id);
    return { files: projects.files.list(request.params.id, request.query.path ?? '') };
  });
  app.get<Location>('/api/v1/projects/:id/text', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    readable(user.id, request.params.id);
    return projects.files.read(request.params.id, request.query.path ?? '');
  });
  app.get<Location>('/api/v1/projects/:id/download', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    readable(user.id, request.params.id);
    const filename = request.query.path ?? '';
    const file = projects.files.open(request.params.id, filename);
    reply.type('application/octet-stream').header('content-length', file.size)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filename))}`);
    return reply.send(fs.createReadStream('', { fd: file.fd, autoClose: true }));
  });
  app.put<Location & { Body: { text: string; expectedRevision: string | null } }>('/api/v1/projects/:id/text', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    writable(user.id, request.params.id);
    const result = projects.files.write(request.params.id, request.query.path ?? '', request.body?.text, request.body?.expectedRevision);
    audit(user.id, 'project.file.written', request.params.id);
    return result;
  });
  app.post<Location>('/api/v1/projects/:id/directories', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    writable(user.id, request.params.id);
    projects.files.mkdir(request.params.id, request.query.path ?? '');
    return reply.code(201).send({ created: true });
  });
  app.delete<Location & { Querystring: { path?: string; revision?: string } }>('/api/v1/projects/:id/files', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    writable(user.id, request.params.id);
    projects.files.remove(request.params.id, request.query.path ?? '', request.query.revision ?? '');
    audit(user.id, 'project.file.removed', request.params.id);
    return { deleted: true };
  });
  app.post<Location>('/api/v1/projects/:id/uploads', {
    onRequest: async (request, reply) => { const user = auth(request, reply); if (user) writable(user.id, request.params.id); },
  }, async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    const declared = request.headers['content-length'];
    if (!(request.body instanceof Readable) || (declared !== undefined && (!Number.isSafeInteger(Number(declared)) || Number(declared) > deps.maxFileBytes))) throw new ProjectError('file_too_large_or_invalid', 413);
    // Stage outside all sandbox mounts. Commit only after the stream is complete
    // and after checking archive state and active tasks again.
    const staging = path.join(path.dirname(projects.files.root), '.project-uploads');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const temporary = path.join(staging, crypto.randomUUID());
    let size = 0;
    try {
      await pipeline(request.body, new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length;
        callback(size > deps.maxFileBytes ? new ProjectError('file_too_large_or_invalid', 413) : null, chunk);
      } }), fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (declared !== undefined && Number(declared) !== size) throw new ProjectError('file_too_large_or_invalid', 413);
      const requested = request.query.path ?? '';
      if (!requested || requested.endsWith('/')) throw new ProjectError('invalid_project_path');
      const split = requested.lastIndexOf('/') + 1, leaf = requested.slice(split);
      const mime = await uploadedImageMime(temporary, leaf, 'application/octet-stream');
      const filename = requested.slice(0, split) + (mime ? imageFileName(leaf, mime, '图片') : safeFileName(leaf));
      writable(user.id, request.params.id);
      projects.files.installUpload(request.params.id, filename, temporary);
      audit(user.id, 'project.file.uploaded', request.params.id);
      return reply.code(201).send({ path: filename, size });
    } finally { fs.rmSync(temporary, { force: true }); }
  });
}
