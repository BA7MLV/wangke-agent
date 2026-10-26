import { cloud, cloudRequest } from '../cloud/state';
import type { McpCallResult, McpCatalog, McpContext, McpServer, McpServerInput, McpTool } from '../../packages/contracts/src/mcp';
import { mcpToolDefinition } from '../../packages/contracts/src/mcp';
import type { ToolDef } from '../api/siliconflow';
import i18n from '../i18n';

export const listMcpServers = () => cloudRequest<{ servers: McpServer[] }>('/mcp');
export const saveMcpServer = (input: McpServerInput, id?: string) => cloudRequest<McpServer>(`/mcp${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(input) });
export const deleteMcpServer = (id: string) => cloudRequest(`/mcp/${id}`, { method: 'DELETE' });
export const testMcpServer = (id: string) => cloudRequest<{ tools: McpTool[]; durationMs: number }>(`/mcp/${id}/test`, { method: 'POST' });

export async function loadMcpTools(context: McpContext, signal?: AbortSignal) {
  const catalog: McpCatalog = cloud.enabled
    ? await cloudRequest('/mcp/catalog', { method: 'POST', body: JSON.stringify(context), signal })
    : { tools: [], warnings: [] };
  const byName = new Map(catalog.tools.map(tool => [tool.name, tool]));
  if (cloud.enabled && context.sessionId !== undefined) {
    const [{ db }, { loadSessionSkillMeta }] = await Promise.all([import('../store/db'), import('../skills/store')]);
    const session = await db.chatSessions.get(context.sessionId);
    const skills = await loadSessionSkillMeta(session?.skillIds);
    const available = new Set(catalog.tools.map(tool => tool.serverName));
    for (const skill of skills) {
      const missing = skill.mcpRequired?.filter(name => !available.has(name));
      if (missing?.length) catalog.warnings.push(i18n.t('settings:mcp.missingDependencies', { skill: skill.name, servers: missing.join(', ') }));
    }
  }
  return {
    tools: catalog.tools.map(mcpToolDefinition) as ToolDef[], warnings: catalog.warnings,
    label: (name: string) => {
      const tool = byName.get(name);
      return tool ? `MCP · ${tool.serverName} / ${tool.originalName}` : name;
    },
    async execute(name: string, args: Record<string, unknown>) {
      if (!byName.has(name)) return 'Error: mcp_tool_unavailable';
      try {
        const result = await cloudRequest<McpCallResult>('/mcp/call', { method: 'POST', body: JSON.stringify({ ...context, name, arguments: args }), signal });
        return result.text;
      } catch (error) { if (signal?.aborted) throw error; return `Error: ${error instanceof Error ? error.message : 'mcp_connection_failed'}`; }
    },
  };
}
