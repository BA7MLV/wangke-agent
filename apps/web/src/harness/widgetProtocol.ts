import type { WidgetPayload } from './widgetRuntime';
import { validateWidgetArgs } from './widget.ts';

/** Metadata describes intent, never trust. Revalidate even persisted/imported payloads. */
export function validateWidgetPayload(payload: WidgetPayload): void {
  if (!payload || typeof payload.html !== 'string') throw new Error('作品源码缺失或格式无效');
  if (payload.schemaVersion != null && payload.schemaVersion !== 1) throw new Error('此作品协议版本暂不支持，请查看源码');
  if (payload.kind != null && payload.kind !== 'html') throw new Error('作品类型不受支持');
  if (payload.revision != null && (!Number.isSafeInteger(payload.revision) || payload.revision < 1)) throw new Error('作品修订号无效');
  for (const value of [payload.id, payload.ref]) {
    if (value != null && (typeof value !== 'string' || !value || value.length > 128)) throw new Error('作品身份格式无效');
  }
  if (payload.source != null && !['tool', 'legacy-widget', 'legacy-html'].includes(payload.source)) throw new Error('作品来源格式无效');
  const result = validateWidgetArgs({ format: 'html', code: payload.html, libs: payload.libs }, payload.source === 'legacy-html', false);
  if (!result.ok) throw new Error(result.error);
}

/** Called inside the owning message's transaction, or for a transient preview. */
export function versionWidget(payload: WidgetPayload, id: string): WidgetPayload {
  validateWidgetPayload(payload);
  return { ...payload, kind: 'html', schemaVersion: 1, revision: payload.revision ?? 1,
    source: payload.source ?? 'legacy-widget', id, ref: payload.ref ?? id };
}
