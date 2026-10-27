import { createStore } from 'zustand';
import type { CloudConfig, CloudProvider } from '../../packages/contracts/src/cloud';
import type { Provider, Settings, SettingsStore } from '../store/settings';
import { providerCatalogId } from '../store/providerPresets';
import { apiUrl } from '../api/base';
import type { DiscoveryProvider } from '../utils/useProviderModels';
import { cloud } from './state';

export const cloudEditorProviders = (config: CloudConfig): Provider[] =>
  config.providers.map((p) => ({ ...p, apiKey: '' }));

/** No persist middleware: editing a server key must never put it in localStorage. */
export function createCloudModelDraft(config: CloudConfig, current: Settings) {
  return createStore<SettingsStore>()((set) => ({
    ...current,
    providers: cloudEditorProviders(config),
    llmModel: config.llmModel, visionModel: config.visionModel, asrModel: config.asrModel,
    decisionModel: { providerId: '', model: '' },
    update: (patch) => set(patch),
  }));
}

/** Discovery always goes through the saved server connection, never the browser's draft key. */
export function cloudDiscoveryProviders(settings: Settings, config: CloudConfig, revision = ''): DiscoveryProvider[] {
  return settings.providers.flatMap((p) => {
    const saved = config.providers.find((s) => s.id === p.id);
    if (!saved || p.apiKey || p.baseUrl !== saved.baseUrl || p.protocol !== saved.protocol) return [];
    return [{ ...p, baseUrl: apiUrl(`/api/v1/cloud/models/${encodeURIComponent(p.id)}`), apiKey: '', credentials: 'include' as const,
      cacheScope: JSON.stringify([cloud.userId, saved.baseUrl, revision]) }];
  });
}

export function cloudModelConfig(settings: Settings, latest: CloudConfig): CloudConfig {
  return {
    ...latest,
    providers: settings.providers.map((p): CloudProvider => ({
      id: p.id, name: p.name, baseUrl: p.baseUrl, protocol: p.protocol,
      apiKey: p.apiKey.trim() || undefined,
      catalogId: providerCatalogId(p),
      serves: p.serves.filter((slot): slot is 'chat' | 'vision' | 'asr' => slot !== 'decision'),
    })),
    llmModel: settings.llmModel, visionModel: settings.visionModel, asrModel: settings.asrModel,
  };
}

/** Only non-secret model preferences join the existing account synchronization. */
export function cloudModelPreferences(settings: Settings): Partial<Settings> {
  return { savedModels: settings.savedModels, favorites: settings.favorites, contextWindow: settings.contextWindow,
    agentRounds: settings.agentRounds, asrConcurrency: settings.asrConcurrency };
}
