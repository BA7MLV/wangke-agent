/** Bounded, informational protocol. Diagnostics never grant a host capability. */
export const MAX_WIDGET_DIAGNOSTICS = 8;
export const WIDGET_READY_TIMEOUT_MS = 12000;
export interface WidgetDiagnostic {
  kind: 'script' | 'promise' | 'resource' | 'policy';
  message: string;
}
export function readWidgetDiagnostic(value: unknown): WidgetDiagnostic | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, message } = value as Record<string, unknown>;
  if (typeof kind !== 'string' || !['script', 'promise', 'resource', 'policy'].includes(kind) || typeof message !== 'string' || !message.trim() || message.length > 500) return null;
  return { kind: kind as WidgetDiagnostic['kind'], message };
}
