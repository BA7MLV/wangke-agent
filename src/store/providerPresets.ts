import type { Provider } from './settings';

export interface ProviderPreset extends Omit<Provider, 'id' | 'apiKey'> {
  id: string;
  description: string;
  recommended?: boolean;
}

/** 只展示当前协议层可直接接入的 API Key 端点，不暗示支持订阅账号登录。 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
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
  return PROVIDER_PRESETS.find((preset) => matchesProviderPreset(provider, preset))?.catalogId ?? provider.catalogId ?? '';
}

export function createPresetProvider(preset: ProviderPreset, id: string): Provider {
  return {
    id, name: preset.name, baseUrl: preset.baseUrl, apiKey: '',
    protocol: preset.protocol, serves: [...preset.serves], catalogId: preset.catalogId,
  };
}
