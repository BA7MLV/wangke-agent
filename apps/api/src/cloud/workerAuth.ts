import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export interface WorkerToken { id: string; taskId: string; expiresAt: number }
export const workerTokens = new Map<string, WorkerToken>();
export const workerTokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export function workerIdentity(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice(7);
  const identity = workerTokens.get(token);
  if (identity && identity.expiresAt <= Date.now()) {
    workerTokens.delete(token);
    return undefined;
  }
  return identity;
}
export function renewWorker(request: FastifyRequest, expiresAt: number) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return;
  const token = authorization.slice(7);
  const identity = workerTokens.get(token);
  if (identity) identity.expiresAt = expiresAt;
}
