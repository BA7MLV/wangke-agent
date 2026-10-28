import type { CloudConfig, CloudProvider } from './cloud.js';

export const MODEL_FIELDS = ['llmModel', 'visionModel', 'asrModel', 'decisionModel'] as const;
export type ModelField = typeof MODEL_FIELDS[number];
export interface ModelSettingsIssue {
  path: string;
  reason: 'invalid_reference' | 'model_too_long' | 'provider_not_found' | 'invalid_provider' | 'invalid_url' | 'invalid_key';
}
export type ModelSettingsUpdate = Pick<CloudConfig, 'providers' | 'llmModel' | 'visionModel' | 'asrModel' | 'decisionModel'> & { modelRevision: string };
export interface ProviderSettingsUpdate {
  provider: CloudProvider;
  modelRevision: string;
}

/** Incomplete configuration is valid; a non-empty model must resolve to a provider. */
export function modelReferenceIssues(value: Pick<CloudConfig, 'providers' | ModelField>): ModelSettingsIssue[] {
  const ids = new Set(value.providers.map((p) => p.id));
  return MODEL_FIELDS.flatMap((slot): ModelSettingsIssue[] => {
    const ref = value[slot];
    if (slot === 'decisionModel' && ref === undefined) return [];
    if (!ref || typeof ref.model !== 'string' || typeof ref.providerId !== 'string') return [{ path: slot, reason: 'invalid_reference' }];
    if (ref.model.length > 200) return [{ path: slot, reason: 'model_too_long' }];
    if (ref.model && !ids.has(ref.providerId)) return [{ path: slot, reason: 'provider_not_found' }];
    return [];
  });
}
