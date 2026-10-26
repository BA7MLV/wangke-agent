import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DatabaseStore } from '../storage/database.js';
const operationUploads = new Set<string>();

export async function receiveFile(store: DatabaseStore, directory: string, owner: string, stream: Readable,
  name: string, mime: string, limit: number, declared?: number, checkActive: () => void = () => {}, operationFileId?: string) {
  const id = operationFileId ?? crypto.randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid_file_operation');
  if (operationFileId) {
    checkActive();
    const existing = store.db.prepare('SELECT id,original_name AS originalName,mime_type AS mimeType,size_bytes AS sizeBytes,sha256,created_at AS createdAt FROM files WHERE id=? AND owner_id=?').get(id, owner);
    if (existing) return existing as { id: string; originalName: string; mimeType: string; sizeBytes: number; sha256: string; createdAt: string };
    if (store.db.prepare('SELECT 1 FROM files WHERE id=?').get(id)) throw new Error('file_operation_not_owned');
  }
  const operationKey = `${directory}\0${id}`;
  // A competing retry must never remove another upload's temporary/final file.
  if (operationUploads.has(operationKey)) throw new Error('file_operation_inflight');
  operationUploads.add(operationKey);
  const storageName = `${id}.bin`;
  const temporaryPath = path.join(directory, `.upload-${id}.tmp`);
  const storagePath = path.join(directory, storageName);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const counter = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    if (bytes > limit) return done(Object.assign(new Error('file_too_large_or_invalid'), { statusCode: 413 }));
    hash.update(chunk); done(null, chunk);
  } });
  try {
    await pipeline(stream, counter, fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
    if (bytes < 1 || (declared !== undefined && declared !== bytes)) throw Object.assign(new Error('file_too_large_or_invalid'), { statusCode: 413 });
    const handle = await fs.promises.open(temporaryPath, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    const sha256 = hash.digest('hex'); const createdAt = new Date().toISOString();
    if (name === 'cache-blob') {
      const existing = store.db.prepare("SELECT id,original_name AS originalName,mime_type AS mimeType,size_bytes AS sizeBytes,sha256,created_at AS createdAt FROM files WHERE owner_id=? AND sha256=? AND mime_type=? AND original_name='cache-blob' LIMIT 1").get(owner, sha256, mime);
      if (existing) { await fs.promises.rm(temporaryPath, { force: true }); return existing as { id: string; originalName: string; mimeType: string; sizeBytes: number; sha256: string; createdAt: string }; }
    }
    await fs.promises.rename(temporaryPath, storagePath);
    checkActive(); // No asynchronous gap between authority recheck and the database commit.
    store.db.prepare('INSERT INTO files(id,owner_id,storage_name,original_name,mime_type,size_bytes,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, owner, storageName, name, mime, bytes, sha256, createdAt);
    return { id, originalName: name, mimeType: mime, sizeBytes: bytes, sha256, createdAt };
  } catch (error) {
    await Promise.all([fs.promises.rm(temporaryPath, { force: true }), fs.promises.rm(storagePath, { force: true })]);
    throw error;
  } finally { operationUploads.delete(operationKey); }
}

export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | false {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return false;
  return { start, end };
}
