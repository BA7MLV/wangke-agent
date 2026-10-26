/**
 * 供应商与模型目录（models.dev 快照，由 scripts/generate-models.mjs 生成）。
 *
 * 目录约 190 KiB，只在选模型时按需加载；纯函数部分（按槽位筛选）不依赖加载状态，方便单测。
 */
export type CatalogProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';
export type CatalogSlot = 'chat' | 'vision' | 'asr' | 'decision';

export interface CatalogModel {
  id: string;
  name: string;
  /** 缺省 = 普通语言模型；'decision' / 'transcription' 等来自 models.dev 的 type */
  type?: string;
  /** 缺省 = ['text'] */
  input?: string[];
  output?: string[];
  reasoning?: boolean;
  toolCall?: boolean;
  context?: number;
  maxOutput?: number;
  released?: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  baseUrl: string;
  protocol: CatalogProtocol;
  env: string[];
  doc?: string;
  models: CatalogModel[];
}

export interface Catalog {
  source: string;
  generatedAt: string;
  providers: CatalogProvider[];
}

let pending: Promise<Catalog> | undefined;

export function loadCatalog(): Promise<Catalog> {
  pending ??= import('./models.generated.json').then((m) => (m.default ?? m) as Catalog).catch((error) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

const inputOf = (m: CatalogModel) => m.input ?? ['text'];

/** 这个模型能不能放进某个槽位。只看 models.dev 声明的类型与模态，不按名字猜。 */
export function fitsSlot(model: CatalogModel, slot: CatalogSlot): boolean {
  if (slot === 'decision') return model.type === 'decision';
  if (model.type === 'decision') return false;
  if (slot === 'asr') return inputOf(model).includes('audio') && (model.type === 'transcription' || !model.toolCall);
  if (model.type === 'transcription') return false;
  if (slot === 'vision') return inputOf(model).includes('image');
  return inputOf(model).includes('text');
}

export function modelsForSlot(provider: CatalogProvider, slot: CatalogSlot): CatalogModel[] {
  return provider.models.filter((m) => fitsSlot(m, slot));
}

export function providersForSlot(catalog: Catalog, slot: CatalogSlot): CatalogProvider[] {
  return catalog.providers.filter((p) => p.models.some((m) => fitsSlot(m, slot)));
}

export function findModel(catalog: Catalog, providerId: string, modelId: string): CatalogModel | undefined {
  return catalog.providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId);
}
