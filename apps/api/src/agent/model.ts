import type { CloudProvider } from '@wangke/contracts/cloud';

export type ModelCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ModelMessage = { role: string; content: string | null; tool_call_id?: string; tool_calls?: ModelCall[]; response_items?: object[]; checkpoint_id?: string; runtime_notice?: boolean };
type Tool = { type: string; function: { name: string; description: string; parameters: object } };

/** The Bot uses the same configured protocol as ordinary cloud chat. */
export function botRequest(provider: Pick<CloudProvider, 'protocol' | 'apiKey'>, model: string, messages: ModelMessage[], tools: Tool[], outputTokens = 4096) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (provider.protocol === 'anthropic-messages') {
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    return { path: 'messages', headers, body: {
      model, max_tokens: outputTokens, system: messages.filter(m => m.role === 'system').map(m => m.content ?? '').join('\n'),
      messages: messages.filter(m => m.role !== 'system').map(m => m.role === 'tool'
        ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' }] }
        : { role: m.role, content: [ ...(m.response_items ?? []), ...(m.content && !m.response_items?.some(item => (item as { type?: string }).type === 'text') ? [{ type: 'text', text: m.content }] : []), ...(m.tool_calls ?? []).map(c => ({ type: 'tool_use', id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) })) ] }),
      tools: tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })),
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    } };
  }
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  if (provider.protocol === 'openai-responses') return { path: 'responses', headers, body: {
    model, store: false, max_output_tokens: outputTokens, include: ['reasoning.encrypted_content'],
    input: messages.flatMap((m): object[] => m.role === 'tool'
      ? [{ type: 'function_call_output', call_id: m.tool_call_id, output: m.content ?? '' }]
      : [ ...(m.response_items ?? []), ...(m.content && !m.response_items?.some(item => (item as { type?: string }).type === 'message') ? [{ role: m.role, content: m.content }] : []), ...(m.tool_calls ?? []).map(c => ({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments })) ]),
    tools: tools.map(t => ({ type: 'function', ...t.function, strict: false })), tool_choice: 'auto', parallel_tool_calls: false,
  } };
  return { path: 'chat/completions', headers, body: { model, messages: messages.map(({ response_items: _items, checkpoint_id: _checkpoint, runtime_notice: _notice, ...m }) => m), tools, tool_choice: 'auto', parallel_tool_calls: false, max_tokens: outputTokens } };
}

export function responseContinuation(protocol: CloudProvider['protocol'], body: unknown): object[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if (protocol === 'anthropic-messages') {
    const content = (body as { content?: unknown }).content;
    return Array.isArray(content) ? content.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && ['thinking', 'redacted_thinking', 'text'].includes(item.type))) : undefined;
  }
  if (protocol !== 'openai-responses') return undefined;
  const output = (body as { output?: unknown }).output;
  return Array.isArray(output) ? output.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && item.type !== 'function_call')) : undefined;
}

export function botReply(protocol: CloudProvider['protocol'], body: unknown): { text: string; calls: Array<{ function: ModelCall['function'] }> } {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_structured_response');
    return value as Record<string, unknown>;
  };
  const result = object(body);
  let calls: unknown[];
  let text = '';
  if (protocol === 'anthropic-messages') {
    if (['max_tokens', 'refusal'].includes(String(result.stop_reason))) throw new Error('model_incomplete_or_refused');
    if (!Array.isArray(result.content)) throw new Error('invalid_structured_response');
    calls = result.content.map(object).filter(c => c.type === 'tool_use').map(c => ({ name: c.name, arguments: JSON.stringify(c.input) }));
    text = result.content.map(object).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
  } else if (protocol === 'openai-responses') {
    if (['incomplete', 'failed'].includes(String(result.status))) throw new Error('model_incomplete_or_refused');
    if (!Array.isArray(result.output)) throw new Error('invalid_structured_response');
    const output = result.output.map(object);
    if (output.some(o => Array.isArray(o.content) && o.content.some(c => object(c).type === 'refusal'))) throw new Error('model_incomplete_or_refused');
    calls = output.filter(c => c.type === 'function_call').map(c => ({ name: c.name, arguments: c.arguments }));
    text = output.filter(c => c.type === 'message' && c.role === 'assistant').flatMap(c => Array.isArray(c.content) ? c.content.map(object) : []).filter(c => c.type === 'output_text' && typeof c.text === 'string').map(c => c.text).join('\n');
  } else {
    if (!Array.isArray(result.choices) || !result.choices.length) throw new Error('invalid_structured_response');
    const choice = object(result.choices[0]), message = object(choice.message);
    if (['length', 'content_filter'].includes(String(choice.finish_reason)) || message.refusal) throw new Error('model_incomplete_or_refused');
    if (message.tool_calls != null && !Array.isArray(message.tool_calls)) throw new Error('invalid_structured_response');
    calls = Array.isArray(message.tool_calls) ? message.tool_calls.map(c => object(c).function) : [];
    text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map(object).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') : '';
  }
  if (!calls.length && !text.trim()) throw new Error('invalid_structured_response');
  return { text, calls: calls.map(value => {
    const call = object(value);
    if (typeof call.name !== 'string' || typeof call.arguments !== 'string') throw new Error('invalid_structured_response');
    return { function: { name: call.name, arguments: call.arguments } };
  }) };
}

export function botCalls(protocol: CloudProvider['protocol'], body: unknown) { return botReply(protocol, body).calls; }
