import type { Provider } from './settings';
import { modelProvidersMeta, type ModelProviderMeta } from '../api/modelMeta';

export interface ProviderPreset extends Omit<Provider, 'id' | 'apiKey'> {
  id: string;
  description: string;
  recommended?: boolean;
}

/** 只展示当前协议层可直接接入的 API Key 端点，不暗示支持订阅账号登录。 */
/**
 * 离线/旧缓存回退项。在线时同 ID 的条目由 models.dev 覆盖，避免这里的地址和
 * provider 目录长期漂移；保留回退是为了首次启动、离线和已有端到端夹具仍可用。
 */
const FALLBACK_PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'typesafe', name: 'TypeSafe', description: 'Jev 决策模型，用于技能路由与上下文筛选',
    baseUrl: 'https://api.typesafe.ai/v1', protocol: 'openai-chat',
    serves: ['decision'], catalogId: 'typesafe',
  },
  {
    id: 'openai', name: 'OpenAI', description: '使用 API 密钥访问 GPT 模型',
    baseUrl: 'https://api.openai.com/v1', protocol: 'openai-chat',
    serves: ['chat', 'vision', 'asr'], catalogId: 'openai', recommended: true,
  },
  {
    id: 'deepseek', name: 'DeepSeek 官方', description: '直连 DeepSeek 官方模型',
    baseUrl: 'https://api.deepseek.com', protocol: 'openai-chat',
    serves: ['chat'], catalogId: 'deepseek', recommended: true,
  },
  {
    id: 'openrouter', name: 'OpenRouter', description: '一个密钥，使用多家模型',
    baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-chat',
    serves: ['chat', 'vision'], catalogId: 'openrouter', recommended: true,
  },
  {
    id: 'anthropic', name: 'Anthropic', description: '使用 API 密钥访问 Claude 模型',
    baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic-messages',
    serves: ['chat', 'vision'], catalogId: 'anthropic',
  },
  {
    id: 'siliconflow-cn', name: '硅基流动', description: '国内端点，支持对话、读图与转写',
    baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai-chat',
    serves: ['chat', 'vision', 'asr'], catalogId: 'siliconflow-cn',
  },
  {
    id: 'google', name: 'Google', description: '使用 API 密钥访问 Gemini 模型',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai-chat',
    serves: ['chat', 'vision'], catalogId: 'google',
  },
  {
    id: 'vercel', name: 'Vercel AI Gateway', description: '通过一个网关使用众多模型',
    baseUrl: 'https://ai-gateway.vercel.sh/v1', protocol: 'openai-chat',
    serves: ['chat', 'vision'], catalogId: 'vercel',
  },
];

/** 兼容旧调用方；新 UI 应使用 getProviderPresets()。 */
export const PROVIDER_PRESETS = FALLBACK_PROVIDER_PRESETS;

function protocolOf(provider: ModelProviderMeta): Provider['protocol'] {
  const packageName = provider.npm?.toLowerCase() ?? '';
  return packageName.includes('anthropic') ? 'anthropic-messages' : 'openai-chat';
}

function presetFromModelProvider(provider: ModelProviderMeta): ProviderPreset | null {
  const baseUrl = provider.baseUrl?.trim();
  // 占位地址（例如 ${ACCOUNT_ID}）不能直接作为“常用端点”保存；用户应走自定义连接。
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl) || baseUrl.includes('${')) return null;
  return {
    id: provider.id,
    name: provider.name || provider.id,
    description: provider.doc ? `models.dev 目录 · ${provider.doc}` : '来自 models.dev 的 API 端点',
    baseUrl,
    protocol: protocolOf(provider),
    serves: ['chat'],
    catalogId: provider.id,
  };
}

/**
 * models.dev 供应商优先，静态项只在目录尚未加载或某项没有可用 API 地址时兜底。
 * 这样新增供应商不需要发版，旧用户也不会因为离线而失去已有入口。
 */
export function getProviderPresets(): readonly ProviderPreset[] {
  const dynamic = modelProvidersMeta().flatMap((provider) => {
    const preset = presetFromModelProvider(provider);
    return preset ? [preset] : [];
  });
  const byId = new Map(dynamic.map((preset) => [preset.id, preset]));
  for (const preset of FALLBACK_PROVIDER_PRESETS) {
    if (!byId.has(preset.id) && !dynamic.some((item) => matchesProviderPreset(item, preset))) byId.set(preset.id, preset);
  }
  return [...byId.values()];
}

function endpointKey(baseUrl: string): string {
  try {
    const url = new URL(baseUrl.trim());
    // 官方根地址与 /v1 写法视作同一连接；其他路径仍须精确匹配。
    const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    return `${url.origin}${path}${url.search}${url.hash}`;
  } catch {
    return baseUrl.trim();
  }
}

export function matchesProviderPreset(provider: Provider, preset: ProviderPreset): boolean {
  return endpointKey(provider.baseUrl) === endpointKey(preset.baseUrl);
}

/** 常用端点的目录由地址确定；自定义连接保留兼容的历史提示，歧义可在模型上确认。 */
export function providerCatalogId(provider: Provider): string {
  return getProviderPresets().find((preset) => matchesProviderPreset(provider, preset))?.catalogId ?? provider.catalogId ?? '';
}

export function createPresetProvider(preset: ProviderPreset, id: string): Provider {
  return {
    id, name: preset.name, baseUrl: preset.baseUrl, apiKey: '',
    protocol: preset.protocol, serves: [...preset.serves], catalogId: preset.catalogId,
  };
}
