import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-migrations-'));
const source = ref => execFileSync('git', ['show', `${ref}:apps/api/src/storage/database.ts`], { encoding: 'utf8' });
const migrations = text => [...text.matchAll(/\[(\d+), `([\s\S]*?)`\]/g)].map(m => [Number(m[1]), m[2]]);
try {
  for (const [name, ref, maximum] of [['empty', null, 0], ['v12', 'c82feb6', 12], ['mcp13', '221d397', 13], ['gateway13', 'c82feb6', 13], ['gateway14', 'c82feb6', 14]]) {
    const filename = path.join(root, `${name}.sqlite`);
    if (ref) {
      const db = new Database(filename);
      db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
      for (const [version, sql] of migrations(source(ref))) if (version <= maximum) {
        db.exec(sql); db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(version, 'fixture');
      }
      db.prepare('INSERT INTO users VALUES(?,?,?)').run('owner', 'Owner', 'fixture');
      db.prepare('INSERT INTO threads(id,mode,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('thread', 'bot', 'owner', 'fixture', 'fixture');
      if (name === 'mcp13') db.prepare('INSERT INTO mcp_servers VALUES(?,?,?,?,?)').run('mcp', 'owner', '{"transport":"sse"}', 'encrypted-fixture', 'revision');
      if (name.startsWith('gateway')) {
        db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('bot', 'owner', 'Bot', 'study', '', 'fixture', 'fixture');
        db.prepare('INSERT INTO gateway_accounts(id,owner_id,channel,agent_id,config,cursor,created_at) VALUES(?,?,?,?,?,?,?)').run('account', 'owner', 'fake', 'bot', 'encrypted-fixture', 'cursor-99', 'fixture');
        db.prepare('INSERT INTO gateway_inbox(account_id,external_id,envelope) VALUES(?,?,?)').run('account', 'external', '{"text":"learn"}');
      }
      db.close();
    }
    for (let restart = 0; restart < 2; restart++) {
      const store = new DatabaseStore(filename);
      assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE name='mcp_servers'").get());
      assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE name='gateway_projection_failures'").get());
      assert.equal(store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 17);
      if (ref) assert.equal(store.db.prepare('SELECT owner_id FROM threads WHERE id=?').get('thread').owner_id, 'owner');
      if (name === 'mcp13') assert.equal(store.db.prepare('SELECT credentials FROM mcp_servers').get().credentials, 'encrypted-fixture');
      if (name.startsWith('gateway')) {
        assert.equal(store.db.prepare('SELECT cursor FROM gateway_accounts').get().cursor, 'cursor-99');
        assert.equal(store.db.prepare('SELECT external_id FROM gateway_inbox').get().external_id, 'external');
      }
      store.close();
    }
    console.log(`Migration ${name}: data preserved; restart idempotent`);
  }
  const broken = path.join(root, 'broken.sqlite');
  const store = new DatabaseStore(broken); store.db.exec('DROP TABLE mcp_servers'); store.close();
  assert.throws(() => new DatabaseStore(broken), /schema_layout_partial/);
  console.log('Partial schema rejected without migration replay');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
