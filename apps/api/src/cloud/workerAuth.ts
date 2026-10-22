import type { FastifyRequest } from 'fastify';

export const workerTokens = new Map<string, { id: string; taskId: string }>();
export function workerIdentity(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  return authorization?.startsWith('Bearer ') ? workerTokens.get(authorization.slice(7)) : undefined;
}
