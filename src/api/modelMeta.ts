/**
 * 模型能力元数据：来自 models.dev 的实时数据（含硅基流动在架模型），
 * 本地缓存 + 7 天 TTL；未拉取/过期/失败时由 modelCaps.ts 回退到名称启发式。
 */

const API_URL = 'https://models.dev/api.json';
const CACHE_KEY = 'wangke-model-meta';
const TTL_MS = 7 * 24 * 3600 * 1000;

export interface ModelMeta {
  context: number;
  output: number;
  vision: boolean;
  reasoning: boolean;
  toolCall: boolean;
}

interface MetaCache {
  updatedAt: number;
  models: Record<string, ModelMeta>;
}

/** models.dev 条目（只取需要的字段） */
interface ModelsDevEntry {
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[] };
  reasoning?: boolean;
  tool_call?: boolean;
}

let mem: MetaCache | null | undefined; // undefined = 未读 localStorage

function load(): MetaCache | null {
  if (mem !== undefined) return mem;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    mem = raw ? (JSON.parse(raw) as MetaCache) : null;
  } catch {
    mem = null;
  }
  return mem;
}

export function getModelMeta(id: string): ModelMeta | null {
  return load()?.models[id] ?? null;
}

export function modelMetaInfo(): { updatedAt: number; count: number } | null {
  const c = load();
  return c ? { updatedAt: c.updatedAt, count: Object.keys(c.models).length } : null;
}

export function isModelMetaStale(): boolean {
  const c = load();
  return !c || Date.now() - c.updatedAt > TTL_MS;
}

/** 拉取 models.dev 并精简为硅基流动（国际站 + 国内站合并，国内站优先）的能力表 */
export async function refreshModelMeta(): Promise<{ count: number }> {
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
  const json = await res.json();
  const src: Record<string, ModelsDevEntry> = {
    ...json?.siliconflow?.models,
    ...json?.['siliconflow-cn']?.models,
  };
  const models: Record<string, ModelMeta> = {};
  for (const [id, m] of Object.entries(src)) {
    const context = m?.limit?.context;
    if (!context) continue;
    models[id] = {
      context,
      output: m.limit?.output ?? 8192,
      vision: !!m.modalities?.input?.includes('image'),
      reasoning: !!m.reasoning,
      toolCall: !!m.tool_call,
    };
  }
  if (Object.keys(models).length === 0) throw new Error('models.dev 返回数据为空');
  mem = { updatedAt: Date.now(), models };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(mem));
  } catch {
    // 配额满等场景：内存缓存仍生效，本次会话可用
  }
  return { count: Object.keys(models).length };
}
