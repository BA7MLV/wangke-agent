import { Ajv, type ValidateFunction } from 'ajv';
import { BudgetBlocked } from '../budget.js';

export type Recovery = 'read' | 'idempotent' | 'uncertain';
export type ToolDefinition = { type: string; function: { name: string; description: string; parameters: object } };
export type ToolResult = { ok: true; value: unknown } | { ok: false; error: { code: string; hint: string } };
export interface ExecutionContext {
  readonly owner: string;
  readonly thread: string;
  readonly run: string;
  readonly step: string;
  readonly signal: AbortSignal;
  checkActive(): void;
}
type Entry = { definition: ToolDefinition; validate: ValidateFunction; recovery: Recovery; timeoutMs: number };

/** Deliberately bounded draft-07 subset. Unsupported validation must fail
 * closed, not silently become an unconstrained tool. No remote resolution,
 * regex execution, mutation/coercion, async validators or custom keywords. */
function inspect(schema: unknown, depth = 0, count = { value: 0 }): void {
  if (++count.value > 1000 || depth > 16) throw new Error('tool_schema_complexity');
  if (Array.isArray(schema)) { for (const value of schema) inspect(value, depth + 1, count); return; }
  if (!schema || typeof schema !== 'object') return;
  for (const [key, value] of Object.entries(schema)) {
    if (['$async', '$dynamicRef', 'pattern', 'patternProperties', 'format', '__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('tool_schema_unsupported');
    if (key === '$ref' && (typeof value !== 'string' || !value.startsWith('#/'))) throw new Error('tool_schema_remote_ref');
    if (['properties', 'definitions', '$defs'].includes(key) && value && typeof value === 'object') {
      for (const child of Object.values(value)) inspect(child, depth + 1, count);
    } else inspect(value, depth + 1, count);
  }
}

export class ToolRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly ajv = new Ajv({ strict: true, strictTypes: false, strictTuples: false, allowUnionTypes: true, ownProperties: true, allErrors: false, addUsedSchema: false });
  register(definition: ToolDefinition, recovery: Recovery, timeoutMs = 120000) {
    const name = definition.function.name;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name) || this.entries.has(name)) throw new Error('tool_duplicate_or_invalid_name');
    if (JSON.stringify(definition.function.parameters).length > 32768) throw new Error('tool_schema_too_large');
    inspect(definition.function.parameters);
    const validate = this.ajv.compile(definition.function.parameters);
    this.entries.set(name, { definition, validate, recovery, timeoutMs });
  }
  definitions() { return [...this.entries.values()].map(e => e.definition); }
  validate(name: string, args: unknown): ToolResult {
    const entry = this.entries.get(name);
    if (!entry) return { ok: false, error: { code: 'unknown_tool', hint: 'Choose an available tool.' } };
    if (JSON.stringify(args)?.length > 128000 || !entry.validate(args)) return { ok: false, error: { code: 'invalid_arguments', hint: 'Follow the tool input schema; omit undeclared fields.' } };
    return { ok: true, value: args };
  }
  async execute(name: string, args: unknown, context: ExecutionContext, operation: (context: ExecutionContext) => Promise<unknown>): Promise<ToolResult> {
    const validation = this.validate(name, args);
    if (!validation.ok) return validation;
    const entry = this.entries.get(name)!;
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(entry.timeoutMs)]);
    const scoped: ExecutionContext = { ...context, signal, checkActive: () => { signal.throwIfAborted(); context.checkActive(); } };
    scoped.checkActive();
    let abort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      });
      const value = await Promise.race([operation(scoped), interrupted]);
      scoped.checkActive();
      return { ok: true, value };
    } catch (error) {
      if (error instanceof BudgetBlocked) throw error;
      context.signal.throwIfAborted();
      const safeCodes = ['skill_not_available', 'skill_reference_not_found', 'invalid_skill_reference', 'memory_revision_conflict', 'memory_not_found', 'memory_source_tombstoned'];
      const code = signal.aborted ? 'tool_timeout' : error instanceof Error && safeCodes.includes(error.message) ? error.message : 'tool_failed';
      return { ok: false, error: { code, hint: entry.recovery === 'uncertain' ? 'Side effects may have occurred. Inspect evidence; do not automatically replay.' : 'Check current permissions and input before retrying.' } };
    } finally { if (abort) signal.removeEventListener('abort', abort); }
  }
}
