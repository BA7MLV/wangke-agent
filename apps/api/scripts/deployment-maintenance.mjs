// Runs only in an explicitly selected API image, with no HTTP server/schedulers.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { inspectDatabase, fenceRemoteWorkers } from '../dist/apps/api/src/storage/release.js';

const [action, source, destination] = process.argv.slice(2);
if (action === 'metadata') {
  console.log(fs.readFileSync(new URL('../dist/database-identity.json', import.meta.url), 'utf8'));
} else if (action === 'snapshot') {
  const db = new Database(source, { fileMustExist: true });
  try {
    inspectDatabase(db);
    fenceRemoteWorkers(db);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    // Remove only our own disposable pre-copy database and its SQLite sidecars.
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(destination + suffix, { force: true });
    await db.backup(destination);
    const backup = new Database(destination, { readonly: true, fileMustExist: true });
    try { console.log(JSON.stringify(inspectDatabase(backup))); } finally { backup.close(); }
  } finally { db.close(); }
} else if (action === 'verify') {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try { console.log(JSON.stringify(inspectDatabase(db))); } finally { db.close(); }
} else throw new Error('unknown_maintenance_action');
