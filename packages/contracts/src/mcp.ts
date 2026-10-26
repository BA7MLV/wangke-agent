/** Secrets are write-only. Omission preserves a credential; an empty value clears it. */
export interface McpServerInput {
  name: string;
  url: string;
  transport: 'streamable-http' | 'sse' | 'stdio';
  enabled: boolean;
  auth: 'none' | 'bearer' | 'headers' | 'oauth';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  token?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  disabledTools: string[];
}
export interface McpServer extends Omit<McpServerInput, 'token' | 'headers' | 'env'> {
  envNames?: string[];
  pid?: number;
  oauthAuthorized?: boolean;
  id: string;
  configured: boolean;
  headerNames: string[];
  revision: string;
  status: 'disconnected' | 'connecting' | 'ready' | 'auth_failed' | 'failed' | 'disabled';
  error?: string;
  toolCount?: number;
}
export interface McpTool {
  kind?: 'gateway';
  serverId: string;
  serverName: string;
  originalName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
}
export interface McpCatalog { tools: McpTool[]; warnings: string[] }
export interface McpContext { sessionId?: number; threadId?: string }
export interface McpCallResult { text: string; isError: boolean; durationMs: number; serverName: string; toolName: string }

export function mcpToolDefinition(tool: McpTool) {
  return { type: 'function' as const, function: {
    name: tool.name, description: `[MCP: ${tool.serverName} / ${tool.originalName}] ${tool.description}`,
    parameters: tool.inputSchema,
  } };
}

/** Keep result conversion identical for browser harness and Node BotRunner. */
export function mcpResultText(result: { content?: unknown; structuredContent?: unknown; isError?: boolean }): string {
  const parts: string[] = [];
  if (result.isError) parts.push('Error: MCP tool reported a failure.');
  if (Array.isArray(result.content)) for (const block of result.content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'resource_link') parts.push(`[Resource: ${block.name ?? ''}] ${block.uri ?? ''}`);
    else if (block?.type === 'resource' && typeof block.resource?.text === 'string') parts.push(`${block.resource.uri ?? ''}\n${block.resource.text}`);
    else parts.push(`[MCP content type ${String(block?.type ?? 'unknown')} is not supported by this client; content omitted.]`);
  }
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join('\n\n') || '[MCP returned no content]';
  return text.length > 24000 ? `${text.slice(0, 24000)}\n[MCP result truncated at 24000 characters]` : text;
}
