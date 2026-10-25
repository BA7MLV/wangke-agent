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
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      config TEXT NOT NULL, credentials TEXT NOT NULL, revision TEXT NOT NULL
    );
    CREATE INDEX mcp_servers_owner ON mcp_servers(owner_id);
    ALTER TABLE threads ADD COLUMN mcp_server_ids TEXT;
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
    this.migrate();
  }

  private migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const current = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number };
    for (const [version, sql] of MIGRATIONS) {
      if (version <= current.version) continue;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      })();
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close() { this.db.close(); }
}
