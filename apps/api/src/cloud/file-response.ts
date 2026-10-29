import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { byteRange } from './files.js';

/** Call only after authorization. Owns the descriptor on every response path. */
export function sendPrivateFile(request: FastifyRequest, reply: FastifyReply,
  file: { fd: number; size: number; revision: string }, mimeType: string) {
  const etag = `"${crypto.createHash('sha256').update(file.revision).digest('hex')}"`;
  reply.type(mimeType).header('accept-ranges', 'bytes').header('etag', etag)
    .header('cache-control', 'private, no-cache')
    .header('content-disposition', /^(video|audio)\//.test(mimeType) ? 'inline' : 'attachment')
    .header('x-content-type-options', 'nosniff');
  const noneMatch = request.headers['if-none-match'];
  if (noneMatch?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)) {
    fs.closeSync(file.fd);
    return reply.code(304).send();
  }
  // Range applies to GET, not HEAD. A changed validator means a full fresh copy.
  const rangeHeader = request.method === 'GET' && (!request.headers['if-range'] || request.headers['if-range'] === etag)
    ? request.headers.range : undefined;
  const range = byteRange(rangeHeader, file.size);
  if (range === false) {
    fs.closeSync(file.fd);
    return reply.code(416).header('content-range', `bytes */${file.size}`).send();
  }
  if (range) reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${file.size}`)
    .header('content-length', range.end - range.start + 1);
  else reply.header('content-length', file.size);
  if (request.method === 'HEAD' || file.size === 0) {
    fs.closeSync(file.fd);
    return reply.send();
  }
  // Fastify destroys the ReadStream on disconnect, which also closes this fd.
  return reply.send(fs.createReadStream('', { fd: file.fd, autoClose: true, ...(range || {}) }));
}
