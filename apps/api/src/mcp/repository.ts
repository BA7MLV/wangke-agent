import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfiguration } from '../cloud/config.js';
import type { McpServer, McpServerInput } from '@wangke/contracts/mcp';
import type { OAuthData } from './oauth.js';
import { parseMcpImport } from './import.js';
import { mcpCredentialTarget, normalizeMcpConfig } from './config.js';

export type StoredServer = McpServer & { token: string; headers: Record<string, string>; env: Record<string, string>; oauth?: OAuthData };
export class McpRepository {
  constructor(private store: DatabaseStore, private encryption: CloudConfiguration) {}

  list(owner: string): StoredServer[] {
    this.store.systemMcp.sync(owner);
    const rows = this.store.db.prepare('SELECT * FROM mcp_servers WHERE owner_id=? ORDER BY rowid').all(owner) as Array<{ id: string; config: string; credentials: string; revision: string }>;
    return rows.map(row => {
      const config = JSON.parse(row.config) as McpServerInput;
      const secrets = row.credentials ? JSON.parse(this.encryption.open(row.credentials)) as Pick<StoredServer, 'token' | 'headers' | 'env' | 'oauth'> : { token: '', headers: {}, env: {} };
      return { ...config, ...secrets, env: secrets.env ?? {}, envNames: Object.keys(secrets.env ?? {}), oauthAuthorized: Boolean(secrets.oauth?.tokens), id: row.id, revision: row.revision,
        configured: config.auth === 'bearer' ? Boolean(secrets.token) : config.auth === 'headers' && Object.keys(secrets.headers).length > 0,
        headerNames: Object.keys(secrets.headers), status: config.enabled ? 'disconnected' : 'disabled' };
    });
  }
  get(owner: string, id: string) { return this.list(owner).find(s => s.id === id); }
  public(server: StoredServer): McpServer {
    const { token: _token, headers: _headers, env: _env, oauth: _oauth, ...value } = server;
    return value;
  }
  private prepare(owner: string, input: McpServerInput, id?: string) {
    let previous = id ? this.get(owner, id) : undefined;
    if (id && !previous) throw new Error('mcp_not_found');
    if (!previous && this.list(owner).length >= 30) throw new Error('mcp_server_limit');
    const config = normalizeMcpConfig(input);
    if (previous && mcpCredentialTarget(previous) !== mcpCredentialTarget(config)) previous = undefined;
    const env = input.transport === 'stdio' ? input.env ?? previous?.env ?? {} : {};
    if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 100 || Object.entries(env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.length > 8192 || v.includes('\0'))) throw new Error('mcp_invalid_credentials');
    const token = input.auth === 'bearer' ? input.token ?? (previous?.auth === 'bearer' ? previous.token : '') : '';
    const headers = input.auth === 'headers' ? input.headers ?? (previous?.auth === 'headers' ? previous.headers : {}) : {};
    if (typeof token !== 'string' || token.length > 8192 || /[\r\n]/.test(token) || !headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length > 20) throw new Error('mcp_invalid_credentials');
    const names = new Set<string>();
    for (const [key, value] of Object.entries(headers)) {
      const name = key.toLowerCase();
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(key) || names.has(name) ||
        /^(host|cookie|content-length|content-type|accept|connection|transfer-encoding|mcp-.*)$/i.test(key) ||
        typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) throw new Error('mcp_invalid_credentials');
      names.add(name);
    }
    const oauth = input.auth === 'oauth' ? previous?.oauth : undefined;
    return { config, credentials: { token, headers, env, oauth } };
  }
  save(owner: string, input: McpServerInput, id?: string, expectedRevision?: string): StoredServer {
    return this.store.transaction(() => {
      if (id && expectedRevision !== undefined && this.get(owner, id)?.revision !== expectedRevision) throw new Error('mcp_config_changed');
      const { config, credentials } = this.prepare(owner, input, id);
      const serverId = id ?? crypto.randomUUID();
      this.store.systemMcp.update(owner, servers => id ? servers.map(s => s.id === id ? { id, ...config } : s) : [...servers, { id: serverId, ...config }]);
      this.store.db.prepare('UPDATE mcp_servers SET credentials=?,revision=? WHERE id=? AND owner_id=?')
        .run(this.encryption.seal(JSON.stringify(credentials)), crypto.randomUUID(), serverId, owner);
      return this.get(owner, serverId)!;
    });
  }
  remove(owner: string, id: string, expectedRevision?: string) {
    return this.store.transaction(() => {
      const server = this.get(owner, id);
      if (!server) throw new Error('mcp_not_found');
      if (expectedRevision !== undefined && server.revision !== expectedRevision) throw new Error('mcp_config_changed');
      this.store.systemMcp.update(owner, servers => servers.filter(s => s.id !== id));
    });
  }
  owner(id: string): string | undefined {
    return (this.store.db.prepare('SELECT owner_id FROM mcp_servers WHERE id=?').get(id) as { owner_id: string } | undefined)?.owner_id;
  }
  updateOAuth(owner: string, id: string, revision: string, update: (data: OAuthData) => OAuthData) {
    const server = this.get(owner, id);
    if (!server || server.auth !== 'oauth' || server.revision !== revision) throw new Error('mcp_config_changed');
    const { token, headers, env } = server;
    this.store.db.prepare('UPDATE mcp_servers SET credentials=? WHERE id=? AND owner_id=? AND revision=?')
      .run(this.encryption.seal(JSON.stringify({ token, headers, env, oauth: update(server.oauth ?? {}) })), id, owner, revision);
  }
  private importInputs(owner: string, value: unknown) {
    const inputs = parseMcpImport(value);
    const names = new Set(this.list(owner).map(s => s.name));
    if (this.list(owner).length + inputs.length > 30) throw new Error('mcp_server_limit');
    for (const input of inputs) {
      input.name = input.name.trim();
      if (names.has(input.name)) throw new Error('mcp_import_duplicate');
      names.add(input.name);
      this.prepare(owner, input);
    }
    return inputs;
  }
  previewImport(owner: string, value: unknown) {
    return this.importInputs(owner, value).map(s => ({ name: s.name, transport: s.transport }));
  }
  import(owner: string, value: unknown) {
    const inputs = this.importInputs(owner, value);
    return this.store.transaction(() => inputs.map(input => this.public(this.save(owner, input))));
  }
  resetOAuth(owner: string, id: string) {
    const server = this.get(owner, id);
    if (!server || server.auth !== 'oauth') throw new Error('mcp_invalid_config');
    this.store.db.prepare('UPDATE mcp_servers SET credentials=?,revision=? WHERE id=? AND owner_id=?')
      .run(this.encryption.seal(JSON.stringify({ token: server.token, headers: server.headers, env: server.env })), crypto.randomUUID(), id, owner);
  }
}
