import type { CloudProvider } from '../../../../packages/contracts/src/cloud.js';

export type ModelCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ModelMessage = { role: string; content: string | null; tool_call_id?: string; tool_calls?: ModelCall[] };
type Tool = { type: string; function: { name: string; description: string; parameters: object } };

/** The Bot uses the same configured protocol as ordinary cloud chat. */
export function botRequest(provider: Pick<CloudProvider, 'protocol' | 'apiKey'>, model: string, messages: ModelMessage[], tools: Tool[]) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (provider.protocol === 'anthropic-messages') {
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    return { path: 'messages', headers, body: {
      model, max_tokens: 4096, system: messages.filter(m => m.role === 'system').map(m => m.content ?? '').join('\n'),
      messages: messages.filter(m => m.role !== 'system').map(m => m.role === 'tool'
        ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' }] }
        : { role: m.role, content: [ ...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.tool_calls ?? []).map(c => ({ type: 'tool_use', id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) })) ] }),
      tools: tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })),
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
    } };
  }
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  if (provider.protocol === 'openai-responses') return { path: 'responses', headers, body: {
    model, store: false, max_output_tokens: 4096,
    input: messages.flatMap((m): object[] => m.role === 'tool'
      ? [{ type: 'function_call_output', call_id: m.tool_call_id, output: m.content ?? '' }]
      : [ ...(m.content ? [{ role: m.role, content: m.content }] : []), ...(m.tool_calls ?? []).map(c => ({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments })) ]),
    tools: tools.map(t => ({ type: 'function', ...t.function, strict: false })), tool_choice: 'required', parallel_tool_calls: false,
  } };
  return { path: 'chat/completions', headers, body: { model, messages, tools, tool_choice: 'required', parallel_tool_calls: false, max_tokens: 4096 } };
}

export function botCalls(protocol: CloudProvider['protocol'], body: any): Array<{ function: ModelCall['function'] }> | undefined {
  if (protocol === 'anthropic-messages') return body?.content?.filter((c: any) => c.type === 'tool_use').map((c: any) => ({ function: { name: c.name, arguments: JSON.stringify(c.input) } }));
  if (protocol === 'openai-responses') return body?.output?.filter((c: any) => c.type === 'function_call').map((c: any) => ({ function: { name: c.name, arguments: c.arguments } }));
  return body?.choices?.[0]?.message?.tool_calls;
}
