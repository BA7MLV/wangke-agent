import { createStore } from 'zustand';
import type { CloudConfig, CloudProvider } from '@wangke/contracts/cloud';
import type { Provider, Settings, SettingsStore } from '../store/settings';
import { providerCatalogId } from '../store/providerPresets';
import { apiUrl } from '../api/base';
import type { DiscoveryProvider } from '../utils/useProviderModels';
import { cloud } from './state';
import { MODEL_FIELDS, type ModelSettingsIssue, type ModelSettingsUpdate } from '@wangke/contracts/model-settings';

export const cloudEditorProviders = (config: CloudConfig): Provider[] =>
  config.providers.map((p) => ({ ...p, apiKey: '' }));

/** No persist middleware: editing a server key must never put it in localStorage. */
export function createCloudModelDraft(config: CloudConfig, current: Settings) {
  return createStore<SettingsStore>()((set) => ({
    ...current,
    providers: cloudEditorProviders(config),
    llmModel: config.llmModel, visionModel: config.visionModel, asrModel: config.asrModel,
    decisionModel: config.decisionModel ?? { providerId: '', model: '' },
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
      serves: [...p.serves],
    })),
    llmModel: settings.llmModel, visionModel: settings.visionModel, asrModel: settings.asrModel, decisionModel: settings.decisionModel,
  };
}

export function cloudModelUpdate(settings: Settings, baseline: CloudConfig): ModelSettingsUpdate {
  const value = cloudModelConfig(settings, baseline);
  return { providers: value.providers, llmModel: value.llmModel, visionModel: value.visionModel,
    asrModel: value.asrModel, decisionModel: value.decisionModel, modelRevision: baseline.modelRevision ?? '' };
}

export function cloudProviderDirty(provider: Provider, config: CloudConfig): boolean {
  const saved = config.providers.find((entry) => entry.id === provider.id);
  return !saved || Boolean(provider.apiKey.trim()) || provider.name !== saved.name || provider.baseUrl !== saved.baseUrl
    || provider.protocol !== saved.protocol || provider.catalogId !== saved.catalogId
    || JSON.stringify(provider.serves) !== JSON.stringify(saved.serves);
}

export function cloudModelsDirty(settings: Settings, baseline: CloudConfig): boolean {
  const candidate = cloudModelConfig(settings, baseline);
  const providers = (config: CloudConfig) => config.providers.map(({ configured: _configured, apiKey, ...p }) => ({ ...p, apiKey: apiKey || undefined }));
  return JSON.stringify(providers(candidate)) !== JSON.stringify(providers(baseline))
    || MODEL_FIELDS.some((slot) => JSON.stringify(candidate[slot]) !== JSON.stringify(baseline[slot] ?? { providerId: '', model: '' }));
}

export function modelSettingsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    invalid_model_slot: '部分默认模型配置需要修复，请检查对应的模型选择。',
    model_settings_conflict: '服务器上的模型设置已被其他页面修改。你的草稿已保留，请重新载入服务器设置后再编辑。',
    model_revision_required: '模型设置版本已过期，请重新载入后再保存。',
    invalid_provider: '供应商信息不完整或格式无效，请检查名称与连接协议。',
    invalid_provider_url: 'API 地址必须是 HTTP 或 HTTPS 地址，且不能包含账号、密码、查询参数或片段。',
    invalid_provider_key: 'API Key 格式无效或长度超出限制，请检查后重试。',
  };
  return messages[message] ?? `保存失败：${message}`;
}

export function modelIssueMessage(issue: ModelSettingsIssue): string {
  if (issue.reason === 'provider_not_found') return '原供应商已不存在，请重新选择模型，或清除当前选择后稍后配置。';
  if (issue.reason === 'model_too_long') return '模型 ID 不能超过 200 个字符，请重新选择或修改模型。';
  return '模型引用格式无效，请重新选择模型。';
}

/** Only non-secret model preferences join the existing account synchronization. */
export function cloudModelPreferences(settings: Settings): Partial<Settings> {
  return { savedModels: settings.savedModels, favorites: settings.favorites, contextWindow: settings.contextWindow,
    agentRounds: settings.agentRounds, asrConcurrency: settings.asrConcurrency };
}
