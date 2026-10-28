import type { ModelOverrides } from './modelMeta.ts';

/** 供应商 /models 中明确声明的能力；缺失字段不冒充接口声明。 */
export interface DiscoveredModel extends ModelOverrides {
  id: string;
  name?: string;
}

const positive = (...values: unknown[]): number | undefined =>
  values.find((v): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0);
const strings = (value: unknown): string[] | undefined => Array.isArray(value)
  ? [...new Set(value.filter((v): v is string => typeof v === 'string'))] : undefined;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function parseDiscoveredModel(value: unknown): DiscoveredModel | null {
  if (typeof value === 'string') return value.trim() ? { id: value.trim() } : null;
  const raw = record(value);
  const id = raw.id ?? raw.name;
  if (typeof id !== 'string' || !id.trim()) return null;
  const limit = record(raw.limit);
  const modalities = record(raw.modalities);
  const caps = record(raw.capabilities);
  const tools = caps.tools ?? raw.tool_call ?? raw.toolCalling;
  return {
    id: id.trim(),
    modelType: typeof raw.type === 'string' ? raw.type : undefined,
    name: typeof raw.name === 'string' ? raw.name.trim() : undefined,
    contextWindow: positive(limit.context, raw.context_window, raw.contextWindow),
    maxOutputTokens: positive(limit.output, raw.max_output_tokens, raw.maxOutputTokens),
    inputCapabilities: strings(caps.input) ?? strings(modalities.input) ?? strings(raw.inputCapabilities),
    outputCapabilities: strings(caps.output) ?? strings(modalities.output) ?? strings(raw.outputCapabilities),
    toolCalling: typeof tools === 'boolean' ? tools : undefined,
  };
}
