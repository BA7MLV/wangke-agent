import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-backup-test-'));
const source = path.join(root, 'source'), restored = path.join(root, 'restored');
try {
  const store = new DatabaseStore(path.join(source, 'data/db/wangke.sqlite'));
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run('owner', 'Test', '2026-10-22');
  const config = new CloudConfiguration(store, path.join(source, 'data/config'));
  config.save('owner', { ...config.get('owner'), providers: [{ id: 'test', name: 'Test', baseUrl: 'https://example.com/v1', apiKey: 'backup-key-test', protocol: 'openai-chat', serves: ['chat'], catalogId: '' }] });
  store.close();
  fs.mkdirSync(path.join(source, 'data/files'));
  fs.writeFileSync(path.join(source, 'data/files/example.bin'), 'course-file');
  fs.writeFileSync(path.join(source, '.env'), 'PORT=3000\n', { mode: 0o600 });
  const env = { ...process.env, WANGKE_COMPOSE_FILE: '' };
  execFileSync('bash', ['scripts/backup.sh', '--data-dir', source], { env });
  const archive = path.join(source, 'backups', fs.readdirSync(path.join(source, 'backups'))[0]);
  execFileSync('bash', ['scripts/restore.sh', '--data-dir', restored, archive], { env });
  const restoredStore = new DatabaseStore(path.join(restored, 'data/db/wangke.sqlite'));
  try {
    assert.equal(new CloudConfiguration(restoredStore, path.join(restored, 'data/config')).get('owner', true).providers[0].apiKey, 'backup-key-test');
    assert.equal(fs.readFileSync(path.join(restored, 'data/files/example.bin'), 'utf8'), 'course-file');
    assert.equal(fs.statSync(archive).mode & 0o777, 0o600);
  } finally { restoredStore.close(); }
  console.log('Cloud backup: SQLite, original files, encrypted credentials and credentials.key restored successfully');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
