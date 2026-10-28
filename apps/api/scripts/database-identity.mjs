import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseStore } from '../dist/apps/api/src/storage/database.js';
import { inspectDatabase } from '../dist/apps/api/src/storage/release.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-schema-'));
let store;
try {
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'system-files'));
  const hash = crypto.createHash('sha256');
  for (const file of ['src/storage/database.ts', 'src/storage/system-files.ts', 'src/storage/system-materials.ts', 'src/projects/resources.ts']) {
    hash.update(file).update('\0').update(fs.readFileSync(file)).update('\0');
  }
  fs.writeFileSync('dist/database-identity.json', JSON.stringify({ identity: `sha256:${hash.digest('hex')}`, ...inspectDatabase(store.db) }, null, 2) + '\n');
} finally { store?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
