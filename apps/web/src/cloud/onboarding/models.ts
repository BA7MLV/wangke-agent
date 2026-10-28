/**
 * 引导页「选择模型」的纯逻辑：把一次选择写回 CloudConfig。不碰 DOM，单测见 scripts/test-onboarding.mjs。
 */
import type { CloudConfig, CloudProvider } from '@wangke/contracts/cloud';
import type { CatalogProvider, CatalogSlot } from '../../api/catalog';

export const CUSTOM_PROVIDER = '__custom__';

const FIELD = { chat: 'llmModel', vision: 'visionModel', asr: 'asrModel', decision: 'decisionModel' } as const satisfies Record<CatalogSlot, keyof CloudConfig>;

export type SlotChoice =
  | { kind: 'catalog'; provider: CatalogProvider; apiKey?: string; model: string }
  | { kind: 'custom'; baseUrl: string; apiKey?: string; model: string; existingId?: string };

const EMPTY = { providerId: '', model: '' };

export function slotRef(config: CloudConfig, slot: CatalogSlot): { providerId: string; model: string } {
  return config[FIELD[slot]] ?? EMPTY;
}

/** 服务器只收 `[\w-]{1,64}` 的 id；目录 id 里偶尔有点号（如 wafer.ai）。 */
function uniqueId(config: CloudConfig, base: string): string {
  const clean = base.replace(/[^\w-]/g, '-').slice(0, 56) || 'provider';
  const taken = new Set(config.providers.map((p) => p.id));
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}-${i}`)) return `${clean}-${i}`;
}

function withServes(provider: CloudProvider, slot: CatalogSlot): CloudProvider['serves'] {
  return provider.serves.includes(slot) ? provider.serves : [...provider.serves, slot];
}

/** 选中（或清空）某个槽位；同一家供应商只登记一次，Key 留空时沿用服务器上已存的。 */
export function applyChoice(config: CloudConfig, slot: CatalogSlot, choice: SlotChoice | null): CloudConfig {
  if (!choice) return { ...config, [FIELD[slot]]: { ...EMPTY } };
  let providers = config.providers;
  let providerId: string;
  if (choice.kind === 'catalog') {
    const existing = providers.find((p) => p.catalogId === choice.provider.id);
    if (existing) {
      providerId = existing.id;
      providers = providers.map((p) => p.id === existing.id
        ? { ...p, ...(choice.apiKey ? { apiKey: choice.apiKey } : {}), serves: withServes(p, slot) }
        : p);
    } else {
      providerId = uniqueId(config, choice.provider.id);
      providers = [...providers, {
        id: providerId, name: choice.provider.name, baseUrl: choice.provider.baseUrl, protocol: choice.provider.protocol,
        apiKey: choice.apiKey ?? '', catalogId: choice.provider.id, serves: [slot],
      }];
    }
  } else {
    const existing = choice.existingId ? providers.find((p) => p.id === choice.existingId) : undefined;
    if (existing) {
      providerId = existing.id;
      providers = providers.map((p) => p.id === existing.id
        ? { ...p, baseUrl: choice.baseUrl, ...(choice.apiKey ? { apiKey: choice.apiKey } : {}), serves: withServes(p, slot) }
        : p);
    } else {
      providerId = uniqueId(config, 'custom');
      let name = choice.baseUrl;
      try { name = new URL(choice.baseUrl).hostname; } catch { /* 校验交给服务器 */ }
      providers = [...providers, { id: providerId, name, baseUrl: choice.baseUrl, protocol: 'openai-chat', apiKey: choice.apiKey ?? '', catalogId: '', serves: [slot] }];
    }
  }
  return { ...config, providers, [FIELD[slot]]: { providerId, model: choice.model } };
}
