import { cloudRequest } from '../cloud/state';
import type { ToolDef } from '../api/siliconflow';

export async function loadWebTools(sessionId: number, signal?: AbortSignal) {
  const catalog = await cloudRequest<{ tools: ToolDef[] }>('/web-search/catalog', { method: 'POST', body: JSON.stringify({ sessionId }), signal });
  const names = new Set(catalog.tools.map(tool => tool.function.name));
  return { tools: catalog.tools, names,
    async execute(name: string, args: Record<string, unknown>) {
      if (!names.has(name)) return 'Error: web_disabled';
      try { return JSON.stringify(await cloudRequest('/web-search/call', { method: 'POST', body: JSON.stringify({ sessionId, name, arguments: args }), signal })); }
      catch (error) { signal?.throwIfAborted(); return `Error: ${error instanceof Error ? error.message : 'web_request_failed'}`; }
    },
  };
}
