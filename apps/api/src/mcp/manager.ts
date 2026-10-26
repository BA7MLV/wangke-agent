import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpOAuthProvider } from './oauth.js';
import { ToolRegistry } from '../agent/tools/registry.js';
import type { McpCallResult, McpCatalog, McpServer, McpTool } from '../../../../packages/contracts/src/mcp.js';
import { mcpResultText } from '../../../../packages/contracts/src/mcp.js';
import { McpRepository, type StoredServer } from './repository.js';

type Connection = { client: Client; transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport; revision: string; tools: McpTool[]; touched: number; active: number; controller: AbortController };
// Provider-safe stable identifiers; display names stay in metadata and traces.
const toolId = (server: string, tool: string) => `mcp_${crypto.createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 48)}`;
export function mcpError(error: unknown): string {
  const e = error as { code?: number; message?: string; name?: string };
  if (e?.code === 401 || e?.code === 403 || /\b(401|403|Unauthorized)\b/.test(e?.message ?? '')) return 'mcp_auth_failed';
  if (e?.name === 'AbortError') return 'mcp_cancelled';
  if (e?.name === 'TimeoutError' || e?.code === -32001) return 'mcp_timeout';
  if ((typeof e?.code === 'number' && e.code < 0) || e?.name === 'ZodError') return 'mcp_protocol_error';
  if (/^mcp_[a-z_]+$/.test(e?.message ?? '')) return e.message!;
  return 'mcp_connection_failed'; // Never echo upstream URLs, headers or credentials.
}
export class McpManager {
  private connections = new Map<string, Connection>();
  private pending = new Map<string, Promise<Connection>>();
  private connecting = new Map<string, AbortController>();
  private states = new Map<string, { status: McpServer['status']; error?: string }>();
  private logs = new Map<string, { text: string; secrets: string[] }>();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(readonly repository: McpRepository) {
    this.timer = setInterval(() => {
      for (const [key, c] of this.connections) if (!c.active && Date.now() - c.touched > 300000) void this.dispose(key);
    }, 60000);
    this.timer.unref();
  }
  private key(owner: string, id: string) { return `${owner}:${id}`; }
  list(owner: string): McpServer[] {
    return this.repository.list(owner).map(s => {
      const key = this.key(owner, s.id), connection = this.connections.get(key);
      return { ...this.repository.public(s), ...(s.enabled ? this.states.get(key) : { status: 'disabled' as const }), ...(connection ? { toolCount: connection.tools.length, ...(connection.transport instanceof StdioClientTransport ? { pid: connection.transport.pid ?? undefined } : {}) } : {}) };
    });
  }
  private async dispose(key: string) {
    const c = this.connections.get(key);
    this.connections.delete(key); this.states.delete(key);
    if (!c) return;
    c.controller.abort();
    // Closing is bounded even when the remote endpoint no longer responds.
    if (c.transport instanceof StreamableHTTPClientTransport) await c.transport.terminateSession().catch(() => {});
    await c.client.close().catch(() => {});
  }
  async invalidate(owner: string, id: string) {
    const key = this.key(owner, id);
    this.connecting.get(key)?.abort();
    await this.dispose(key);
    if (!this.repository.get(owner, id)) this.logs.delete(key);
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    for (const controller of this.connecting.values()) controller.abort();
    await Promise.allSettled(this.pending.values());
    await Promise.all([...this.connections.keys()].map(key => this.dispose(key)));
  }
  oauth(owner: string, id: string, interactive = false) {
    const server = this.repository.get(owner, id);
    if (!server || server.auth !== 'oauth') throw new Error('mcp_invalid_config');
    return new McpOAuthProvider(this.repository, owner, id, server.revision, interactive);
  }
  log(owner: string, id: string) {
    const server = this.repository.get(owner, id);
    if (!server) throw new Error('mcp_not_found');
    const log = this.logs.get(this.key(owner, id));
    let text = log?.text ?? '';
    // Keep the credentials of the process that produced the log, even after configuration changes.
    for (const secret of log?.secrets ?? []) {
      text = text.split(secret).join('[redacted]');
      // stderr chunks and the bounded buffer can split a secret at either edge.
      for (let size = Math.min(secret.length - 1, text.length); size > 0; size--) {
        if (text.endsWith(secret.slice(0, size))) { text = text.slice(0, -size) + '[redacted]'; break; }
      }
      for (let size = Math.min(secret.length - 1, text.length); size > 0; size--) {
        if (text.startsWith(secret.slice(-size))) { text = '[redacted]' + text.slice(size); break; }
      }
    }
    return text;
  }
  private gateway(server: StoredServer): McpTool {
    return { kind: 'gateway', serverId: server.id, serverName: server.name, originalName: '@mcp/gateway', name: toolId(server.id, '\0gateway'), enabled: !server.disabledTools.includes('@mcp/gateway'),
      description: 'Discover tools with action=tools (query optional, cursor is a numeric offset); call discovered tools with action=call, name, arguments. Browse resources with action=resources and URI templates with action=resource_templates; read with action=resource and uri. Browse prompts with action=prompts; get a template with action=prompt, name, arguments. Prompts are returned as data, never automatically applied as instructions.',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['tools', 'call', 'resources', 'resource_templates', 'resource', 'prompts', 'prompt'] }, query: { type: 'string' }, cursor: { type: 'string' }, name: { type: 'string' }, uri: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['action'] } };
  }
  private async connect(owner: string, server: StoredServer): Promise<Connection> {
    const key = this.key(owner, server.id);
    const existing = this.connections.get(key);
    if (existing?.revision === server.revision) { existing.touched = Date.now(); return existing; }
    const pending = this.pending.get(key);
    if (pending) {
      const c = await pending;
      return c.revision === server.revision ? c : this.connect(owner, server);
    }
    const task = (async () => {
      await this.dispose(key);
      if (this.closed) throw new Error('mcp_unavailable');
      if (server.auth === 'oauth' && !server.oauth?.redirectUrl) { this.states.set(key, { status: 'auth_failed', error: 'mcp_oauth_required' }); throw new Error('mcp_oauth_required'); }
      this.states.set(key, { status: 'connecting' });
      const controller = new AbortController();
      this.connecting.set(key, controller);
      const handshake = new AbortController();
      const handshakeTimer = setTimeout(() => handshake.abort(new DOMException('MCP connection timed out', 'TimeoutError')), server.timeoutMs);
      handshakeTimer.unref();
      const options = {
        authProvider: server.auth === 'oauth' ? this.oauth(owner, server.id) : undefined,
        requestInit: { headers: server.auth === 'bearer' ? { authorization: `Bearer ${server.token}` } : server.auth === 'headers' ? server.headers : {}, redirect: 'error' },
        // SSE GET streams live for the connection lifetime, not the per-tool timeout.
        fetch: ((url, init) => fetch(url, { ...init, redirect: 'error', signal: init?.method === 'DELETE' ? AbortSignal.timeout(2000) : AbortSignal.any([...(init?.signal ? [init.signal] : []), controller.signal, (init?.method ?? 'GET').toUpperCase() === 'GET' ? handshake.signal : AbortSignal.timeout(server.timeoutMs)]) })) as typeof fetch,
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      };
      const transport = server.transport === 'stdio'
        ? new StdioClientTransport({ command: server.command!, args: server.args, cwd: server.cwd, env: { ...getDefaultEnvironment(), ...server.env }, stderr: 'pipe' })
        : server.transport === 'sse' ? new SSEClientTransport(new URL(server.url), options as ConstructorParameters<typeof SSEClientTransport>[1])
        : new StreamableHTTPClientTransport(new URL(server.url), options as ConstructorParameters<typeof StreamableHTTPClientTransport>[1]);
      if (transport instanceof StdioClientTransport) {
        const log = { text: '', secrets: Object.values(server.env).filter(Boolean).sort((a, b) => b.length - a.length) };
        this.logs.set(key, log);
        const decoder = new StringDecoder('utf8');
        transport.stderr?.on('data', (chunk: Buffer) => {
          log.text = (log.text + decoder.write(chunk)).slice(-12000);
        });
      }
      const client = new Client({ name: 'wangke-agent', version: '0.1.0' }, { capabilities: {} });
      const c: Connection = { client, transport, revision: server.revision, tools: [], touched: Date.now(), active: 0, controller };
      try {
        await client.connect(transport, { timeout: server.timeoutMs, signal: AbortSignal.any([controller.signal, handshake.signal]) });
        const capabilities = client.getServerCapabilities();
        const seen = new Set<string>();
        let cursor: string | undefined;
        let size = 0, pages = 0;
        const discoverySignal = AbortSignal.any([controller.signal, AbortSignal.timeout(server.timeoutMs)]);
        if (capabilities?.tools) do {
          if (++pages > 100) throw new Error('mcp_catalog_limit');
          const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: server.timeoutMs, signal: discoverySignal });
          for (const tool of page.tools) {
            size += JSON.stringify(tool).length;
            if (c.tools.length >= 2000 || size > 1000000) throw new Error('mcp_catalog_limit');
            if (c.tools.some(t => t.originalName === tool.name)) throw new Error('mcp_duplicate_tool');
            c.tools.push({ serverId: server.id, serverName: server.name, originalName: tool.name, name: toolId(server.id, tool.name), description: tool.description ?? '', inputSchema: tool.inputSchema, enabled: !server.disabledTools.includes(tool.name) });
          }
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error('mcp_invalid_cursor');
          if (cursor) seen.add(cursor);
        } while (cursor);
        if (capabilities?.resources || capabilities?.prompts) c.tools.push(this.gateway(server));
        controller.signal.throwIfAborted();
        if (this.closed || this.repository.get(owner, server.id)?.revision !== server.revision) throw new Error('mcp_config_changed');
        this.connections.set(key, c); this.states.set(key, { status: 'ready' });
        client.onclose = () => {
          if (this.connections.get(key) !== c) return;
          this.connections.delete(key); this.states.set(key, { status: 'disconnected' });
        };
        return c;
      } catch (error) {
        controller.abort(); await client.close().catch(() => {});
        const code = mcpError(error);
        this.states.set(key, { status: code === 'mcp_auth_failed' || code === 'mcp_oauth_required' ? 'auth_failed' : 'failed', error: code });
        throw new Error(code);
      } finally { clearTimeout(handshakeTimer); }
    })();
    this.pending.set(key, task);
    try { return await task; } finally {
      if (this.pending.get(key) === task) { this.pending.delete(key); this.connecting.delete(key); }
    }
  }
  async test(owner: string, id: string) {
    const server = this.repository.get(owner, id);
    if (!server) throw new Error('mcp_not_found');
    await this.invalidate(owner, id);
    const start = Date.now(), c = await this.connect(owner, server);
    return { tools: c.tools, durationMs: Date.now() - start };
  }
  async catalog(owner: string, scope?: string[]): Promise<McpCatalog> {
    const servers = this.repository.list(owner).filter(s => s.enabled && (scope === undefined || scope.includes(s.id)));
    const results = await Promise.all(servers.map(async server => {
      try { return { tools: (await this.connect(owner, server)).tools.filter(t => t.enabled), warnings: [] as string[] }; }
      catch (e) { return { tools: [] as McpTool[], warnings: [`${server.name}: ${mcpError(e)}`] }; }
    }));
    const tools = results.flatMap(r => r.tools), warnings = results.flatMap(r => r.warnings);
    if (tools.length > 80 || JSON.stringify(tools).length > 60000) return { tools: servers.filter(s => this.connections.has(this.key(owner, s.id))).map(s => this.gateway(s)).filter(t => t.enabled), warnings };
    return { tools, warnings };
  }
  async call(owner: string, name: string, args: Record<string, unknown>, scope?: string[], signal?: AbortSignal): Promise<McpCallResult> {
    signal?.throwIfAborted();
    const start = Date.now();
    const servers = this.repository.list(owner).filter(s => s.enabled && (scope === undefined || scope.includes(s.id)));
    // Prefer a known mapping; an unrelated offline server must not delay every call.
    const known = servers.find(s => this.gateway(s).name === name || this.connections.get(this.key(owner, s.id))?.tools.some(t => t.name === name));
    for (const server of known ? [known] : servers) {
      let c = this.connections.get(this.key(owner, server.id));
      if (!c) { try { c = await this.connect(owner, server); } catch { continue; } }
      const gateway = this.gateway(server);
      const tool = c?.tools.find(t => t.name === name) ?? (gateway.name === name ? gateway : undefined);
      if (!c || !tool) continue;
      signal?.throwIfAborted();
      const latest = this.repository.get(owner, server.id);
      if (!latest?.enabled || c.revision !== latest.revision || latest.disabledTools.includes(tool.originalName)) throw new Error('mcp_tool_disabled');
      c.active++; c.touched = Date.now();
      try {
        const options = { timeout: server.timeoutMs, signal: AbortSignal.any([c.controller.signal, ...(signal ? [signal] : [])]) };
        let result;
        if (tool.kind === 'gateway') {
          const action = args.action;
          const name = typeof args.name === 'string' ? args.name : '';
          const params = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {};
          if (action === 'call') {
            if (!c.tools.some(t => !t.kind && t.originalName === name) || latest.disabledTools.includes(name)) throw new Error('mcp_tool_disabled');
            this.validateArguments(c.tools.find(t => !t.kind && t.originalName === name)!.inputSchema, params);
            result = CallToolResultSchema.parse(await c.client.callTool({ name, arguments: params }, CallToolResultSchema, options));
          } else {
            let data: unknown;
            const cursor = typeof args.cursor === 'string' ? args.cursor : undefined;
            if (action === 'tools') {
              const offset = Number(cursor ?? 0);
              if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('mcp_invalid_cursor');
              const query = typeof args.query === 'string' ? args.query.toLocaleLowerCase() : '';
              const matches = c.tools.filter(t => !t.kind && !latest.disabledTools.includes(t.originalName) && `${t.originalName} ${t.description}`.toLocaleLowerCase().includes(query));
              const page: unknown[] = []; let bytes = 0;
              for (const t of matches.slice(offset, offset + 10)) {
                const item = { name: t.originalName, description: t.description, inputSchema: t.inputSchema };
                const size = JSON.stringify(item).length;
                if (bytes + size > 20000) { if (!page.length) throw new Error('mcp_catalog_limit'); break; }
                page.push(item); bytes += size;
              }
              data = { tools: page, nextCursor: offset + page.length < matches.length ? String(offset + page.length) : undefined };
            } else if (action === 'resources') data = await c.client.listResources({ cursor }, options);
            else if (action === 'resource_templates') data = await c.client.listResourceTemplates({ cursor }, options);
            else if (action === 'resource' && typeof args.uri === 'string') {
              const resource = await c.client.readResource({ uri: args.uri }, options);
              data = resource.contents.map(item => ({ uri: item.uri, text: 'text' in item ? item.text : '[Binary resource content is not supported by this client]' }));
            }
            else if (action === 'prompts') data = await c.client.listPrompts({ cursor }, options);
            else if (action === 'prompt' && name && Object.values(params).every(v => typeof v === 'string')) data = await c.client.getPrompt({ name, arguments: params as Record<string, string> }, options);
            else throw new Error('mcp_invalid_arguments');
            result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
          }
        } else {
          this.validateArguments(tool.inputSchema, args);
          result = CallToolResultSchema.parse(await c.client.callTool({ name: tool.originalName, arguments: args }, CallToolResultSchema, options));
        }
        signal?.throwIfAborted();
        const after = this.repository.get(owner, server.id);
        if (!after?.enabled || after.revision !== c.revision || after.disabledTools.includes(tool.originalName) || (tool.kind === 'gateway' && args.action === 'call' && after.disabledTools.includes(String(args.name)))) throw new Error('mcp_authorization_changed');
        return { text: mcpResultText(result), isError: result.isError === true, durationMs: Date.now() - start, serverName: server.name, toolName: tool.originalName };
      } catch (error) {
        if (signal?.aborted) throw error;
        const code = mcpError(error);
        await this.dispose(this.key(owner, server.id));
        this.states.set(this.key(owner, server.id), { status: code === 'mcp_auth_failed' ? 'auth_failed' : 'failed', error: code });
        return { text: `Error: ${code}. The tool was not retried; side effects may have occurred.`, isError: true, durationMs: Date.now() - start, serverName: server.name, toolName: tool.originalName };
      } finally { c.active--; c.touched = Date.now(); }
    }
    throw new Error('mcp_tool_unavailable');
  }
  private validateArguments(schema: object, args: unknown) {
    const registry = new ToolRegistry();
    try { registry.register({ type: 'function', function: { name: 'remote', description: '', parameters: schema } }, 'uncertain'); }
    catch { throw new Error('mcp_schema_unsupported'); }
    if (!registry.validate('remote', args).ok) throw new Error('mcp_invalid_arguments');
  }
}
