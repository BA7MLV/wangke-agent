import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const MIGRATIONS: Array<[number, string]> = [
  [1, `
    CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_credentials (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('chat', 'bot')),
      title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      client_nonce TEXT, seq INTEGER NOT NULL, role TEXT NOT NULL,
      kind TEXT NOT NULL, content TEXT NOT NULL, reply_to TEXT,
      created_at TEXT NOT NULL, UNIQUE(thread_id, seq), UNIQUE(thread_id, client_nonce)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('chat', 'bot')), status TEXT NOT NULL,
      created_at TEXT NOT NULL, completed_at TEXT
    );
  `],
  [2, `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions(token_hash);
    ALTER TABLE threads ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;
    UPDATE threads SET owner_id = (SELECT id FROM users ORDER BY created_at LIMIT 1) WHERE owner_id IS NULL;
    CREATE INDEX IF NOT EXISTS threads_owner_idx ON threads(owner_id);
    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('registration', 'authentication')),
      challenge TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS webauthn_challenge_idx ON webauthn_challenges(challenge);
    CREATE TABLE IF NOT EXISTS passkey_credentials (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message_events (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(thread_id, seq)
    );
    CREATE INDEX IF NOT EXISTS message_events_thread_seq_idx ON message_events(thread_id, seq);
  `],
  [3, `
    ALTER TABLE webauthn_challenges ADD COLUMN credential_id TEXT;
    ALTER TABLE message_events RENAME TO message_events_v2;
    CREATE TABLE message_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO message_events(id,thread_id,seq,type,payload,created_at)
      SELECT id,thread_id,seq,type,payload,created_at FROM message_events_v2 ORDER BY rowid;
    DROP TABLE message_events_v2;
    CREATE INDEX message_events_thread_cursor_idx ON message_events(thread_id,event_id);
    CREATE INDEX webauthn_challenge_user_kind_idx ON webauthn_challenges(user_id,kind,created_at);
  `],
  [4, `
    ALTER TABLE runs ADD COLUMN started_at TEXT;
    ALTER TABLE runs ADD COLUMN error_code TEXT;
    ALTER TABLE runs ADD COLUMN trigger_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX runs_trigger_message_idx ON runs(trigger_message_id) WHERE trigger_message_id IS NOT NULL;
  `],
  [5, `
    CREATE TABLE device_pairings (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE,
      device_name TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      used_at TEXT
    );
    CREATE INDEX device_pairings_owner_idx ON device_pairings(owner_id, created_at);
    CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX api_tokens_user_idx ON api_tokens(user_id, created_at);
  `],
  [6, `
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      storage_name TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX files_owner_idx ON files(owner_id, created_at);
  `],
  [7, `
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      avatar TEXT,
      role TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_id, name)
    );
    CREATE INDEX agent_profiles_owner_idx ON agent_profiles(owner_id, updated_at);
    CREATE TABLE thread_participants (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL,
      PRIMARY KEY(thread_id, agent_id)
    );
    CREATE TABLE message_reactions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reaction TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(message_id, user_id, reaction)
    );
    CREATE INDEX message_reactions_message_idx ON message_reactions(message_id, created_at);
    CREATE TABLE message_mentions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(message_id, agent_id)
    );
    CREATE INDEX message_mentions_agent_idx ON message_mentions(agent_id, created_at);
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution TEXT
    );
    CREATE INDEX approvals_thread_idx ON approvals(thread_id, status, created_at);
  `],
  [8, `
    ALTER TABLE approvals ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
    CREATE INDEX approvals_run_idx ON approvals(run_id, status);
  `],
  [9, `
    ALTER TABLE runs ADD COLUMN context_json TEXT;
    ALTER TABLE runs ADD COLUMN step_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE runs ADD COLUMN wake_at TEXT;
    CREATE TABLE run_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      arguments TEXT NOT NULL,
      result TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX run_steps_run_idx ON run_steps(run_id, created_at);
  `],
  [10, `
    CREATE TABLE cloud_records (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      table_name TEXT NOT NULL, record_key TEXT NOT NULL, value TEXT,
      UNIQUE(owner_id,table_name,record_key)
    );
    CREATE INDEX cloud_records_cursor ON cloud_records(owner_id,revision);
    CREATE TABLE cloud_operations (
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL, PRIMARY KEY(owner_id,id)
    );
    CREATE TABLE cloud_config (
      owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      value TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE cloud_tasks (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nonce TEXT NOT NULL, kind TEXT NOT NULL, resource TEXT NOT NULL,
      input TEXT NOT NULL, status TEXT NOT NULL, progress TEXT, result TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(owner_id,nonce)
    );
    CREATE INDEX cloud_tasks_queue ON cloud_tasks(status,created_at);
    CREATE TABLE cloud_task_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES cloud_tasks(id) ON DELETE CASCADE,
      event TEXT NOT NULL
    );
    CREATE TABLE cloud_permissions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES cloud_tasks(id) ON DELETE CASCADE,
      capability TEXT NOT NULL, arguments TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE cloud_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL,
      action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `],
  [11, `
    ALTER TABLE approvals ADD COLUMN step_id TEXT REFERENCES run_steps(id);
    CREATE UNIQUE INDEX approvals_step ON approvals(step_id);
    CREATE TABLE cloud_task_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES cloud_tasks(id) ON DELETE CASCADE,
      nonce TEXT NOT NULL, action TEXT NOT NULL, value TEXT, consumed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(task_id,nonce)
    );
  `],
  [12, `ALTER TABLE cloud_tasks ADD COLUMN executor TEXT CHECK(executor IN ('node','media','browser'));`],
  [13, `
    CREATE TABLE gateway_accounts (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agent_profiles(id),
      enabled INTEGER NOT NULL DEFAULT 0, preset TEXT NOT NULL DEFAULT 'inherit',
      config TEXT NOT NULL, cursor TEXT, health TEXT NOT NULL DEFAULT 'stopped', created_at TEXT NOT NULL
    );
    CREATE TABLE gateway_pairings (
      account_id TEXT PRIMARY KEY REFERENCES gateway_accounts(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE gateway_bindings (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES gateway_accounts(id) ON DELETE CASCADE,
      tenant TEXT NOT NULL, peer TEXT NOT NULL, chat TEXT NOT NULL, topic TEXT NOT NULL,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      context TEXT, revoked INTEGER NOT NULL DEFAULT 0, checkpoint INTEGER NOT NULL DEFAULT 0,
      UNIQUE(account_id,tenant,peer,chat,topic)
    );
    CREATE TABLE gateway_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES gateway_accounts(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL, envelope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT,
      UNIQUE(account_id,external_id)
    );
    CREATE TABLE gateway_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      binding_id TEXT NOT NULL REFERENCES gateway_bindings(id) ON DELETE CASCADE,
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, platform_id TEXT, error TEXT
    );
    CREATE INDEX gateway_outbox_queue ON gateway_outbox(status,next_at,seq);
    CREATE TABLE bot_reminders (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      text TEXT NOT NULL, timezone TEXT NOT NULL, next_at INTEGER NOT NULL,
      interval_seconds INTEGER, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
    );
    ALTER TABLE cloud_tasks ADD COLUMN parent_run_id TEXT REFERENCES runs(id);
    ALTER TABLE cloud_tasks ADD COLUMN parent_step_id TEXT REFERENCES run_steps(id);
    ALTER TABLE approvals ADD COLUMN cloud_permission_id TEXT REFERENCES cloud_permissions(id);
  `],
  [14, `
    CREATE TABLE gateway_projection_failures (
      binding_id TEXT NOT NULL REFERENCES gateway_bindings(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL, error TEXT NOT NULL, next_at INTEGER NOT NULL,
      PRIMARY KEY(binding_id,event_id)
    );
  `],
  [15, `
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      config TEXT NOT NULL, credentials TEXT NOT NULL, revision TEXT NOT NULL
    );
    CREATE INDEX mcp_servers_owner ON mcp_servers(owner_id);
    ALTER TABLE threads ADD COLUMN mcp_server_ids TEXT;
  `],
  [16, `
    CREATE INDEX cloud_audit_owner_id ON cloud_audit(owner_id,id);
    ALTER TABLE threads ADD COLUMN skill_ids TEXT;
    ALTER TABLE runs ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE runs ADD COLUMN budget_json TEXT;
    CREATE TABLE bot_requests (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), run_id TEXT REFERENCES runs(id),
      step_id TEXT, task_id TEXT, purpose TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      attempt INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL,
      reserved_tokens INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cache_tokens INTEGER,
      cost REAL, pricing_source TEXT, price_json TEXT, usage_source TEXT NOT NULL DEFAULT 'unknown'
    );
    CREATE INDEX bot_requests_owner_day ON bot_requests(owner_id,started_at);
    CREATE INDEX bot_requests_run ON bot_requests(run_id);
    CREATE TABLE bot_artifacts (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), run_id TEXT REFERENCES runs(id),
      step_id TEXT, content TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX bot_artifacts_owner ON bot_artifacts(owner_id,created_at);
    CREATE TABLE bot_summaries (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), source_start INTEGER NOT NULL,
      source_end INTEGER NOT NULL, version INTEGER NOT NULL, model TEXT NOT NULL, content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE bot_operations (
      step_id TEXT PRIMARY KEY REFERENCES run_steps(id), owner_id TEXT NOT NULL REFERENCES users(id),
      result TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE bot_memories (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), scope TEXT NOT NULL,
      scope_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL,
      source_revision TEXT, revision INTEGER NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX bot_memories_owner ON bot_memories(owner_id,status,updated_at);
    CREATE TABLE bot_memory_versions (
      memory_id TEXT NOT NULL REFERENCES bot_memories(id), revision INTEGER NOT NULL, value TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(memory_id,revision)
    );
    CREATE TABLE bot_memory_jobs (
      owner_id TEXT PRIMARY KEY REFERENCES users(id), enabled INTEGER NOT NULL DEFAULT 0,
      cursor TEXT, token_budget INTEGER NOT NULL DEFAULT 10000, interval_seconds INTEGER NOT NULL DEFAULT 86400,
      next_at INTEGER NOT NULL DEFAULT 0
    );
  `],
  [17, `
    ALTER TABLE gateway_inbox ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0;
    UPDATE gateway_inbox SET received_at=CAST(strftime('%s','now') AS INTEGER)*1000;
  `],
];

export class DatabaseStore {
  readonly db: Database.Database;

  constructor(filename = process.env.DB_PATH ?? '/data/db/wangke.sqlite') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    try { this.migrate(); } catch (error) { this.db.close(); throw error; }
  }

  private migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const current = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number };
    for (const [version, sql] of MIGRATIONS) {
      if (version > 12) break;
      if (version <= current.version) continue;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      })();
    }
    // Versions 13 and 14 were shipped by two independent branches. Never infer
    // their contents from the numeric watermark or replay an ALTER blindly.
    this.db.transaction(() => {
      const columns = (db: Database.Database, table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
      const expected = new Database(':memory:');
      try {
        for (const [version, sql] of MIGRATIONS) if (version <= 15) expected.exec(sql);
        const groups = [
          { version: 13, tables: ['gateway_accounts', 'gateway_pairings', 'gateway_bindings', 'gateway_inbox', 'gateway_outbox', 'bot_reminders'], extra: [['cloud_tasks', 'parent_run_id'], ['cloud_tasks', 'parent_step_id'], ['approvals', 'cloud_permission_id']] },
          { version: 14, tables: ['gateway_projection_failures'], extra: [] },
          { version: 15, tables: ['mcp_servers'], extra: [['threads', 'mcp_server_ids']] },
        ];
        const present = groups.map(group => {
          const markers = [...group.tables.map(table => columns(this.db, table).length > 0), ...group.extra.map(([table, column]) => columns(this.db, table).some(c => c.name === column))];
          if (markers.some(Boolean) && !markers.every(Boolean)) throw new Error(`schema_layout_partial_v${group.version}: restore a consistent backup before upgrading`);
          if (markers.every(Boolean)) {
            for (const table of group.tables) {
              const actual = columns(this.db, table).filter(c => !(current.version >= 17 && table === 'gateway_inbox' && c.name === 'received_at'));
              const trusted = columns(expected, table);
              if (JSON.stringify(actual) !== JSON.stringify(trusted)) throw new Error(`schema_layout_untrusted_${table}`);
              if (JSON.stringify(this.db.prepare(`PRAGMA foreign_key_list(${table})`).all()) !== JSON.stringify(expected.prepare(`PRAGMA foreign_key_list(${table})`).all())) throw new Error(`schema_foreign_keys_untrusted_${table}`);
            }
            for (const [table, name] of group.extra) {
              const actual = columns(this.db, table).find(c => c.name === name);
              const trusted = columns(expected, table).find(c => c.name === name);
              if (JSON.stringify(actual) !== JSON.stringify(trusted)) throw new Error(`schema_layout_untrusted_${table}_${name}`);
            }
          }
          return markers.every(Boolean);
        });
        const validLegacy = current.version <= 12 ? present.every(v => !v)
          : current.version === 13 ? (!present[1] && present[0] !== present[2])
          : current.version === 14 ? (present[0] && present[1] && !present[2])
          : current.version >= 15 && current.version <= MIGRATIONS.at(-1)![0] ? present.every(Boolean) : false;
        if (!validLegacy) throw new Error('schema_layout_unknown: do not edit migration numbers; restore a consistent backup');
        for (const [index, group] of groups.entries()) {
          if (!present[index]) this.db.exec(MIGRATIONS.find(([v]) => v === group.version)![1]);
          this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)').run(group.version, new Date().toISOString());
        }
      } finally { expected.close(); }
    })();
    for (const [version, sql] of MIGRATIONS) {
      if (version <= Math.max(15, current.version)) continue;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(version, new Date().toISOString());
      })();
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close() { this.db.close(); }
}
