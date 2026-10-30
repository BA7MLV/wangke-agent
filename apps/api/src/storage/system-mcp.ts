import crypto from 'node:crypto';
import type { DatabaseStore } from './database.js';
import type { McpServerInput } from '@wangke/contracts/mcp';
import { MCP_PATH, type SystemDocument } from '@wangke/contracts/system';
import { mcpCredentialTarget, normalizeMcpConfig, type McpServerConfig } from '../mcp/config.js';

type Server = McpServerConfig & { id: string };
type Metadata = { revision: number; sha256: string; updated_at: string };
const hash = (content: string | undefined) => crypto.createHash('sha256').update(JSON.stringify(content ?? null)).digest('hex');
const encode = (servers: Server[]) => `${JSON.stringify({ version: 1, servers }, null, 2)}\n`;
const fields = ['id', 'name', 'url', 'transport', 'enabled', 'auth', 'timeoutMs', 'disabledTools', 'command', 'args', 'cwd'];

/** Disk is authoritative; SQLite holds only a rebuildable index and encrypted credentials. */
export class SystemMcp {
  constructor(private store: DatabaseStore) {}

  private ensure(owner: string) {
    const files = this.store.systemFiles;
    if (files.entry(owner, MCP_PATH)) return;
    if (files.read(owner, MCP_PATH) === undefined) {
      const legacy = this.store.db.prepare('SELECT id,config FROM mcp_servers WHERE owner_id=? ORDER BY rowid').all(owner) as Array<{ id: string; config: string }>;
      files.write(owner, MCP_PATH, encode(legacy.map(row => ({ id: row.id, ...normalizeMcpConfig(JSON.parse(row.config)) }))), null);
    }
    files.register(owner, MCP_PATH);
  }

  private metadata(owner: string, content: string | undefined) {
    const previous = this.store.db.prepare('SELECT revision,sha256,updated_at FROM system_mcp_files WHERE owner_id=?').get(owner) as Metadata | undefined;
    const sha256 = hash(content);
    if (previous?.sha256 === sha256) return previous;
    const value = { revision: (previous?.revision ?? 0) + 1, sha256, updated_at: new Date().toISOString() };
    this.store.db.prepare('INSERT INTO system_mcp_files(owner_id,revision,sha256,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision,sha256=excluded.sha256,updated_at=excluded.updated_at')
      .run(owner, value.revision, sha256, value.updated_at);
    return value;
  }

  private parse(owner: string, content: string): Server[] {
    let value: any;
    try { value = JSON.parse(content); } catch { throw new Error('mcp_invalid_json'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.servers) ||
      value.servers.length > 30 || Object.keys(value).some(k => !['version', 'servers'].includes(k))) throw new Error('mcp_invalid_config');
    const ids = new Set<string>();
    return value.servers.map((entry: any, index: number) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(k => !fields.includes(k))) throw new Error('mcp_config_fields');
      // New file entries may omit id; the next save writes the stable owner-scoped id.
      const digest = crypto.createHash('sha256').update(`${owner}\0${index}\0${entry.name}`).digest('hex');
      const id = entry.id ?? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
      if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) || ids.has(id)) throw new Error('mcp_invalid_config');
      ids.add(id);
      const existing = this.store.db.prepare('SELECT owner_id FROM mcp_servers WHERE id=?').get(id) as { owner_id: string } | undefined;
      if (existing && existing.owner_id !== owner) throw new Error('mcp_invalid_config');
      const config = normalizeMcpConfig({ url: '', transport: 'streamable-http', enabled: false, auth: 'none', timeoutMs: 30000, disabledTools: [], ...entry } as McpServerInput);
      return { id, ...config };
    });
  }

  private index(owner: string, servers: Server[]) {
    const rows = this.store.db.prepare('SELECT id,config,credentials FROM mcp_servers WHERE owner_id=?').all(owner) as Array<{ id: string; config: string; credentials: string }>;
    const previous = new Map(rows.map(row => [row.id, row]));
    for (const { id, ...config } of servers) {
      const old = previous.get(id), json = JSON.stringify(config);
      if (old?.config === json) { previous.delete(id); continue; }
      const credentials = old && mcpCredentialTarget(JSON.parse(old.config)) === mcpCredentialTarget(config) ? old.credentials : '';
      this.store.db.prepare('INSERT INTO mcp_servers(id,owner_id,config,credentials,revision) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,credentials=excluded.credentials,revision=excluded.revision')
        .run(id, owner, json, credentials, crypto.randomUUID());
      previous.delete(id);
    }
    for (const id of previous.keys()) this.store.db.prepare('DELETE FROM mcp_servers WHERE id=? AND owner_id=?').run(id, owner);
  }

  /** Invalid files remain readable/editable, but cannot provide executable configuration. */
  read(owner: string): SystemDocument {
    return this.store.transaction(() => {
      this.ensure(owner);
      const content = this.store.systemFiles.read(owner, MCP_PATH), meta = this.metadata(owner, content);
      let status = content === undefined ? 'missing' : 'active', summary = 'MCP 服务配置 · 密钥在设置中单独管理';
      if (content !== undefined) {
        try { summary = `${this.parse(owner, content).length} 个 MCP 服务 · 与设置共用配置`; }
        catch { status = 'invalid'; summary = '配置无效，请修正 JSON 后保存；MCP 不会加载此配置'; }
      }
      return { path: MCP_PATH, name: 'mcp.json', kind: 'mcp', content: content ?? '', revision: meta.revision, updatedAt: meta.updated_at, sha256: meta.sha256, status, summary };
    });
  }

  sync(owner: string): Server[] {
    return this.store.transaction(() => {
      this.ensure(owner);
      const content = this.store.systemFiles.read(owner, MCP_PATH);
      this.metadata(owner, content);
      // Deleting an established file revokes all servers; never resurrect the DB copy.
      const servers = content === undefined ? [] : this.parse(owner, content);
      this.index(owner, servers);
      return servers;
    });
  }

  save(owner: string, content: string, expected: string, revision: number): SystemDocument {
    return this.store.transaction(() => {
      const current = this.read(owner);
      if (current.content !== expected || current.revision !== revision) throw new Error('system_revision_conflict');
      const servers = this.parse(owner, content), normalized = encode(servers);
      if (normalized.length > 100000) throw new Error('system_file_too_large');
      this.store.systemFiles.write(owner, MCP_PATH, normalized, current.status === 'missing' ? null : expected);
      this.index(owner, servers);
      return this.read(owner);
    });
  }

  preview(owner: string, content: string) { return encode(this.parse(owner, content)); }

  update(owner: string, update: (servers: Server[]) => Server[]) {
    return this.store.transaction(() => {
      const current = this.read(owner), servers = this.sync(owner);
      return this.save(owner, encode(update(servers)), current.content, current.revision);
    });
  }
}
