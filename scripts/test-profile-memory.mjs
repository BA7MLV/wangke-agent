import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { BotMemory } from '../apps/api/src/agent/memory.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-memory-'));
const store = new DatabaseStore(path.join(root, 'db.sqlite'));
try {
  for (const owner of ['alice', 'bob']) store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, owner, new Date().toISOString());
  const records = new CloudRecords(store), memories = new BotMemory(store);
  const rename = (name) => {
    const op = { id: crypto.randomUUID(), table: 'preferences', key: 'userName', before: records.get('alice', 'preferences', 'userName'), after: { id: 'userName', value: name } };
    records.apply('alice', [op]);
    return op;
  };
  const op = rename('小王');
  let [memory] = memories.list('alice');
  assert.equal(memory.kind, 'preference');
  assert.equal(memory.scope, 'owner');
  assert.ok(memory.content.includes('小王'));
  assert.equal(store.systemFiles.read('alice', memory.path), memory.content);
  assert.equal(memories.list('bob').length, 0);
  records.apply('alice', [op]);
  rename('小王');
  assert.equal(memories.list('alice').length, 1);
  assert.equal(memories.get('alice', memory.id).revision, 1, 'sync replay does not duplicate/revise memory');
  rename('王老师');
  assert.equal(memories.list('alice')[0].id, memory.id);
  assert.ok(memories.get('alice', memory.id).content.includes('王老师'));
  rename('');
  assert.equal(memories.list('alice').length, 0, 'clearing the name removes stale preference');
  rename('阿王');
  [memory] = memories.list('alice');
  memories.remove('alice', memory.id, memory.revision);
  rename('阿王');
  assert.equal(memories.list('alice').length, 0, 'unchanged preference sync respects deleted memory');
  console.log('PASS: onboarding profile memory is durable, owner-scoped, idempotent, updated and removed with explicit name changes.');
} finally {
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
