import type { McpServerInput } from '../../../../packages/contracts/src/mcp.js';

/** Explicitly supported formats: Claude mcpServers and VS Code mcp.servers/servers. */
export function parseMcpImport(value: unknown): McpServerInput[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mcp_invalid_import');
  const root = value as Record<string, any>;
  const entries = root.mcpServers ?? root.mcp?.servers ?? root.servers;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || !Object.keys(entries).length || Object.keys(entries).length > 30) throw new Error('mcp_invalid_import');
  return Object.entries(entries).map(([name, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('mcp_invalid_import');
    const e = entry as Record<string, any>;
    if (Object.keys(e).some(k => !['type', 'transport', 'url', 'command', 'args', 'env', 'cwd', 'headers', 'disabled', 'enabled', 'timeout', 'timeoutMs'].includes(k))) throw new Error('mcp_import_fields');
    if ((e.disabled !== undefined && typeof e.disabled !== 'boolean') || (e.enabled !== undefined && typeof e.enabled !== 'boolean') ||
      (e.type !== undefined && e.transport !== undefined && e.type !== e.transport)) throw new Error('mcp_invalid_import');
    if (/\$\{|\{env:|\{input:/.test(JSON.stringify(e))) throw new Error('mcp_import_variables');
    const type = e.type ?? e.transport ?? (e.command ? 'stdio' : 'http');
    const transport = type === 'http' || type === 'streamable-http' ? 'streamable-http' : type;
    if (transport === 'stdio' ? e.url !== undefined || e.headers !== undefined : ['command', 'args', 'cwd', 'env'].some(k => e[k] !== undefined)) throw new Error('mcp_import_fields');
    return { name, url: e.url ?? '', transport, command: e.command, args: e.args, cwd: e.cwd, env: e.env,
      enabled: e.enabled ?? !e.disabled, auth: e.headers ? 'headers' : 'none', headers: e.headers,
      timeoutMs: e.timeoutMs ?? e.timeout ?? 30000, disabledTools: [] };
  });
}
