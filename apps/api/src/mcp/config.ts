import type { McpServerInput } from '@wangke/contracts/mcp';

export type McpServerConfig = Omit<McpServerInput, 'token' | 'headers' | 'env'>;

/** Only non-secret, declarative settings belong in mcp.json. */
export function normalizeMcpConfig(input: McpServerInput): McpServerConfig {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 ||
    typeof input.url !== 'string' || input.url.length > 2048 || !['streamable-http', 'sse', 'stdio'].includes(input.transport) ||
    typeof input.enabled !== 'boolean' || !['none', 'bearer', 'headers', 'oauth'].includes(input.auth) ||
    !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 120000 ||
    !Array.isArray(input.disabledTools) || input.disabledTools.length > 2000 || input.disabledTools.some(t => typeof t !== 'string' || t.length > 256)) throw new Error('mcp_invalid_config');
  let url = '';
  if (input.transport !== 'stdio') {
    let parsed: URL;
    try { parsed = new URL(input.url); } catch { throw new Error('mcp_invalid_url'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error('mcp_invalid_url');
    url = parsed.href;
  } else if (input.auth !== 'none' || typeof input.command !== 'string' || !input.command.trim() || input.command.length > 2048 || /[\r\n\0]/.test(input.command) ||
    (input.args !== undefined && (!Array.isArray(input.args) || input.args.length > 100 || input.args.some(a => typeof a !== 'string' || a.length > 8192 || a.includes('\0')))) ||
    (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.length > 4096 || input.cwd.includes('\0') || (input.cwd !== '' && !input.cwd.startsWith('/'))))) throw new Error('mcp_invalid_command');
  return { name: input.name.trim(), url, transport: input.transport, enabled: input.enabled, auth: input.auth, timeoutMs: input.timeoutMs,
    disabledTools: [...new Set(input.disabledTools)], ...(input.transport === 'stdio' ? { command: input.command, args: input.args ?? [], cwd: input.cwd || undefined } : {}) };
}

/** Never forward saved credentials to a different endpoint or executable. */
export const mcpCredentialTarget = (config: McpServerConfig) => JSON.stringify([
  config.transport, config.auth, config.url, config.command, config.args, config.cwd,
]);
