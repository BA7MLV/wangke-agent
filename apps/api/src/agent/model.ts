import type { CloudProvider } from '../../../../packages/contracts/src/cloud.js';

export type ModelCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ModelMessage = { role: string; content: string | null; tool_call_id?: string; tool_calls?: ModelCall[]; response_items?: object[] };
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
        : { role: m.role, content: [ ...(m.response_items ?? []), ...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.tool_calls ?? []).map(c => ({ type: 'tool_use', id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) })) ] }),
      tools: tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })),
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
    } };
  }
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  if (provider.protocol === 'openai-responses') return { path: 'responses', headers, body: {
    model, store: false, max_output_tokens: 4096,
    input: messages.flatMap((m): object[] => m.role === 'tool'
      ? [{ type: 'function_call_output', call_id: m.tool_call_id, output: m.content ?? '' }]
      : [ ...(m.response_items ?? []), ...(m.content ? [{ role: m.role, content: m.content }] : []), ...(m.tool_calls ?? []).map(c => ({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments })) ]),
    tools: tools.map(t => ({ type: 'function', ...t.function, strict: false })), tool_choice: 'required', parallel_tool_calls: false,
  } };
  return { path: 'chat/completions', headers, body: { model, messages: messages.map(({ response_items: _items, ...m }) => m), tools, tool_choice: 'required', parallel_tool_calls: false, max_tokens: 4096 } };
}

export function responseContinuation(protocol: CloudProvider['protocol'], body: unknown): object[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if (protocol === 'anthropic-messages') {
    const content = (body as { content?: unknown }).content;
    return Array.isArray(content) ? content.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && ['thinking', 'redacted_thinking'].includes(item.type))) : undefined;
  }
  if (protocol !== 'openai-responses') return undefined;
  const output = (body as { output?: unknown }).output;
  return Array.isArray(output) ? output.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && item.type === 'reasoning')) : undefined;
}

export function botCalls(protocol: CloudProvider['protocol'], body: unknown): Array<{ function: ModelCall['function'] }> | undefined {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_structured_response');
    return value as Record<string, unknown>;
  };
  const result = object(body);
  let calls: unknown[];
  if (protocol === 'anthropic-messages') {
    if (['max_tokens', 'refusal'].includes(String(result.stop_reason))) throw new Error('model_incomplete_or_refused');
    if (!Array.isArray(result.content)) throw new Error('invalid_structured_response');
    calls = result.content.map(object).filter(c => c.type === 'tool_use').map(c => ({ name: c.name, arguments: JSON.stringify(c.input) }));
  } else if (protocol === 'openai-responses') {
    if (['incomplete', 'failed'].includes(String(result.status))) throw new Error('model_incomplete_or_refused');
    if (!Array.isArray(result.output)) throw new Error('invalid_structured_response');
    const output = result.output.map(object);
    if (output.some(o => Array.isArray(o.content) && o.content.some(c => object(c).type === 'refusal'))) throw new Error('model_incomplete_or_refused');
    calls = output.filter(c => c.type === 'function_call').map(c => ({ name: c.name, arguments: c.arguments }));
  } else {
    if (!Array.isArray(result.choices) || !result.choices.length) throw new Error('invalid_structured_response');
    const choice = object(result.choices[0]), message = object(choice.message);
    if (['length', 'content_filter'].includes(String(choice.finish_reason)) || message.refusal) throw new Error('model_incomplete_or_refused');
    if (!Array.isArray(message.tool_calls)) throw new Error('invalid_structured_response');
    calls = message.tool_calls.map(c => object(c).function);
  }
  return calls.map(value => {
    const call = object(value);
    if (typeof call.name !== 'string' || typeof call.arguments !== 'string') throw new Error('invalid_structured_response');
    return { function: { name: call.name, arguments: call.arguments } };
  });
}
