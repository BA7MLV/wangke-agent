/**
 * models.dev 提供供应商目录和模型能力；它不决定用户实际可用的连接凭据或
 * `/models` 返回的可用模型列表。
 * 保留供应商作用域以避免串用；未指定供应商时仅自动采用全目录唯一的精确 ID。
 * 未知模型默认文本输入/输出、开启工具调用（与 OpenChamber 接入行为一致）。
 */

const API_URL = 'https://models.dev/api.json?type=all';
const CACHE_KEY = 'wangke-model-meta';
const TTL_MS = 10 * 60 * 1000;

/**
 * 缓存结构版本。**字段含义变了就得 +1**，老缓存必须整体作废而不是被误读。
 *
 * v2 → v3：键从裸模型 id 变成 `catalogId \0 modelId`。不升版本的话老缓存里那批无前缀的键
 * 会被当成「catalog 为空的数据」，命中不上任何查询（表现为「能力数据凭空失效」）。
 * v5：缓存全目录能力投影，不再要求登记供应商；未知模态/工具采用接入默认值，移除定价。
 * v7：同时缓存 models.dev 的供应商目录，用于设置页动态显示供应商。
 *
 * 导出它是因为**手写缓存夹具的测试要跟着它走**（scripts/e2e-agent-guard.mjs、
 * scripts/test-thinking-depth.mjs）：版本写错的话那份夹具会被当成过期缓存丢掉。
 */
export const MODEL_META_CACHE_VERSION = 7;

/** models.dev 的供应商描述。凭据永远不在这里，也不会进入缓存。 */
export interface ModelProviderMeta {
  id: string;
  name: string;
  /** models.dev 的 API 地址；可能包含供应商要求用户替换的占位符。 */
  baseUrl?: string;
  npm?: string;
  env?: string[];
  doc?: string;
}

export interface ModelMeta {
  type?: string;
  name?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  /** 原始声明用于 UI；运行时 context/output 保留既有兜底。 */
  declaredContext?: number;
  declaredOutput?: number;
  declaredReasoning?: boolean;
  declaredToolCall?: boolean;
  structuredOutput?: boolean;
  lastUpdated?: string;
  context: number;
  output: number;
  vision: boolean;
  reasoning: boolean;
  toolCall: boolean;
  /**
   * 模型声明的思考控制方式（解析自 models.dev 的 `reasoning_options`，逐 provider）。
   * `null` = 这个模型不思考；`undefined` = **元数据没说**（不等于不支持，只代表不知道）。
   */
  thinking?: ThinkingControl | null;
}

/** undefined = 跟随目录；false / [] = 用户明确关闭，不得被目录覆盖。 */
export interface ModelOverrides {
  modelType?: string;
  /** 用户确认的目录供应商；仅影响能力匹配，不改变请求模型 ID 或连接。 */
  metadataCatalogId?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  inputCapabilities?: string[];
  outputCapabilities?: string[];
  toolCalling?: boolean;
}

export const MODEL_OVERRIDE_FIELDS = ['modelType', 'metadataCatalogId', 'contextWindow', 'maxOutputTokens', 'reasoningEffort', 'inputCapabilities', 'outputCapabilities', 'toolCalling'] as const;

export function hasModelOverrides(value?: ModelOverrides): boolean {
  return !!value && MODEL_OVERRIDE_FIELDS.some((field) => value[field] !== undefined);
}

/**
 * 模型自己声明的「思考怎么控制」。
 *
 * 这是请求参数的**唯一依据**：深度该用 `reasoning_effort` 还是 `thinking_budget`、
 * 有哪些档位、预算区间多大，全看这里。声明里没有的旋钮就不发 ——
 * 发一个模型没声明的参数，轻则被网关忽略（旋钮静默失效），重则直接 400。
 */
export interface ThinkingControl {
  /** 支持用 `enable_thinking` 开关思考 */
  toggle: boolean;
  /** 声明的 `reasoning_effort` 档位（已剔除 none：「不思考」是开关的事） */
  effort?: string[];
  /** 声明的 `thinking_budget` 合法区间；min/max 缺失表示「这一头不知道」 */
  budget?: { min?: number; max?: number };
}

interface MetaCache {
  version: number;
  complete?: boolean;
  updatedAt: number;
  catalogs?: Record<string, number>;
  providers?: Record<string, ModelProviderMeta>;
  /** 键 = `${catalogId}\0${modelId}` */
  models: Record<string, ModelMeta>;
}

/** models.dev 的 reasoning_options 里我们认得的三种旋钮 */
interface ReasoningOption {
  type?: string;
  /** effort 型：合法档位（注意有 provider 会塞 null / 'none' 表示「不思考」） */
  values?: unknown;
  /** budget_tokens 型：合法区间 */
  min?: number;
  max?: number;
}

/** models.dev 条目（只取需要的字段） */
interface ModelsDevEntry {
  type?: string;
  name?: string;
  last_updated?: string;
  structured_output?: boolean;
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  /** Current API responses expose these at the top level; accept the nested form too. */
  input?: string[];
  output?: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean | { supported?: boolean; effort?: unknown; options?: ReasoningOption[] };
  reasoning_options?: ReasoningOption[];
  tool_call?: boolean;
  capabilities?: {
    input?: string[];
    output?: string[];
    tools?: boolean;
    tool_call?: boolean;
    reasoning?: boolean | { supported?: boolean; effort?: unknown; options?: ReasoningOption[] };
    reasoning_options?: ReasoningOption[];
    structured_output?: boolean;
  };
}

interface ModelsDevProvider {
  name?: string;
  api?: string;
  base_url?: string;
  baseUrl?: string;
  npm?: string;
  env?: unknown;
  doc?: string;
  models?: Record<string, ModelsDevEntry>;
}

/** 缓存键。分隔符用 `\0`：模型 id 里不可能出现 NUL，撞键因此不可能发生 */
export function metaKey(catalogId: string, modelId: string): string {
  return `${catalogId}\0${modelId}`;
}

/**
 * 认识的 effort 档位名（由弱到强）。**白名单而不是原样透传**：
 * 声明里出现没见过的名字时宁可不发，也不能把未知字符串塞进请求体。
 */
const EFFORT_LANES: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 把 `reasoning_options` 翻成 ThinkingControl。
 *
 * 三种声明形状（实测 models.dev 全库就这三类，外加 `[]` 与字段缺失）：
 * - `{type:'toggle'}` —— 只有开关，没有深度旋钮
 * - `{type:'effort', values:[...]}` —— 档位型，档位名逐模型不同（GLM-5.2 只有 high/max）
 * - `{type:'budget_tokens', min, max}` —— 预算型
 *
 * `[]` / 字段缺失但 `reasoning: true`：知道它会思考，却没说旋钮怎么调 →
 * 只当开关用，**不替它编档位**。
 */
function reasoningSupported(m: ModelsDevEntry): boolean {
  const value = m.reasoning ?? m.capabilities?.reasoning;
  return typeof value === 'boolean' ? value : value?.supported === true;
}

function reasoningOptionsOf(m: ModelsDevEntry): ReasoningOption[] {
  if (Array.isArray(m.reasoning_options)) return m.reasoning_options;
  if (Array.isArray(m.capabilities?.reasoning_options)) return m.capabilities.reasoning_options;
  const reasoning = m.reasoning ?? m.capabilities?.reasoning;
  if (reasoning && typeof reasoning === 'object') {
    if (Array.isArray(reasoning.options)) return reasoning.options;
    if (reasoning.effort !== undefined) return [{ type: 'effort', values: reasoning.effort }];
  }
  return [];
}

function defaultModalities(type?: string): { input: string[]; output: string[] } {
  switch (type) {
    case 'image': return { input: ['text'], output: ['image'] };
    case 'video': return { input: ['text'], output: ['video'] };
    case 'audio': return { input: ['audio'], output: ['text'] };
    case 'embedding': return { input: ['text'], output: ['embedding'] };
    default: return { input: ['text'], output: ['text'] };
  }
}

function parseThinking(m: ModelsDevEntry): ThinkingControl | null {
  if (!reasoningSupported(m)) return null;
  const options = reasoningOptionsOf(m);
  const control: ThinkingControl = { toggle: false };
  for (const option of options) {
    if (option?.type === 'toggle') {
      control.toggle = true;
    } else if (option?.type === 'effort') {
      const values = (Array.isArray(option.values) ? option.values : [])
        .filter((v): v is string => typeof v === 'string' && v !== 'none')
        .filter((v) => EFFORT_LANES.includes(v));
      if (values.length > 0) control.effort = [...new Set(values)];
    } else if (option?.type === 'budget_tokens') {
      const min = typeof option.min === 'number' ? option.min : undefined;
      const max = typeof option.max === 'number' ? option.max : undefined;
      if (min != null || max != null) control.budget = { min, max };
    }
  }
  if (!control.toggle && !control.effort && !control.budget) control.toggle = true;
  return control;
}

export interface ModelMetaStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
let storage: ModelMetaStorage | undefined;
export function configureModelMetaStorage(adapter: ModelMetaStorage): void {
  storage = adapter;
  mem = undefined;
}
let mem: MetaCache | null | undefined;

function load(): MetaCache | null {
  if (mem !== undefined) return mem;
  try {
    const raw = storage?.getItem(CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as MetaCache) : null;
    // 版本对不上就当没有：宁可回退到「元数据缺失」，也不能拿旧结构猜字段
    mem = parsed?.version === MODEL_META_CACHE_VERSION ? parsed : null;
  } catch {
    mem = null;
  }
  return mem;
}

export interface ModelMetaMatch {
  status: 'exact' | 'ambiguous' | 'none';
  candidates: { catalogId: string; modelId: string; meta: ModelMeta }[];
}

let indexedModels: MetaCache['models'] | undefined;
let byModelId = new Map<string, ModelMetaMatch['candidates']>();

/** 不归一化或模糊猜测模型名；多供应商同名条目必须由用户确认来源。 */
export function matchModelMeta(catalogId: string, modelId: string): ModelMetaMatch {
  const models = load()?.models;
  if (models !== indexedModels) {
    indexedModels = models;
    byModelId = new Map();
    for (const [key, meta] of Object.entries(models ?? {})) {
      const [catalog, id] = key.split('\0');
      if (!id) continue;
      const entries = byModelId.get(id) ?? [];
      entries.push({ catalogId: catalog, modelId: id, meta });
      byModelId.set(id, entries);
    }
  }
  const scoped = catalogId ? models?.[metaKey(catalogId, modelId)] : undefined;
  if (scoped) return { status: 'exact', candidates: [{ catalogId, modelId, meta: scoped }] };
  const candidates = byModelId.get(modelId) ?? [];
  return { status: candidates.length === 1 ? 'exact' : candidates.length ? 'ambiguous' : 'none', candidates };
}

/** 用户字段覆盖目录；未知模型也可直接接入，默认值不冒充目录声明。 */
export function getModelMeta(catalogId: string, modelId: string, overrides?: ModelOverrides): ModelMeta | null {
  if (!modelId) return null;
  const match = matchModelMeta(overrides?.metadataCatalogId ?? catalogId, modelId);
  const catalog = match.status === 'exact' ? match.candidates[0].meta : null;
  if (!hasModelOverrides(overrides)) return catalog ?? parseModelMeta({});
  const meta = { ...(catalog ?? parseModelMeta({})) };
  if (overrides?.modelType !== undefined) meta.type = overrides.modelType;
  if (overrides?.inputCapabilities !== undefined) {
    meta.inputModalities = [...overrides.inputCapabilities];
    meta.vision = meta.inputModalities.includes('image');
  }
  if (overrides?.outputCapabilities !== undefined) meta.outputModalities = [...overrides.outputCapabilities];
  if (overrides?.contextWindow !== undefined) meta.context = meta.declaredContext = overrides.contextWindow;
  if (overrides?.maxOutputTokens !== undefined) meta.output = meta.declaredOutput = overrides.maxOutputTokens;
  if (overrides?.toolCalling !== undefined) meta.toolCall = meta.declaredToolCall = overrides.toolCalling;
  if (overrides?.reasoningEffort !== undefined) {
    const lanes = overrides.reasoningEffort.split(',').map((v) => v.trim()).filter((v) => EFFORT_LANES.includes(v));
    meta.reasoning = meta.declaredReasoning = lanes.length > 0;
    meta.thinking = lanes.length ? { toggle: false, effort: [...new Set(lanes)] } : null;
  }
  return meta;
}

type MetaListener = () => void;
const listeners = new Set<MetaListener>();

/**
 * 订阅「元数据换了一份」。
 *
 * 缓存是模块级变量，刷新回来**不会**触发 React 重渲染 —— 于是所有由元数据决定的
 * 判断（能不能思考、有没有深度档位、上下文窗口多大）会一直停在刷新前的旧值上，
 * 表现是「刷新成功了但控件没出现」。这个订阅就是补上这条通知。
 */
export function subscribeModelMeta(fn: MetaListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function modelMetaInfo(): { updatedAt: number; count: number } | null {
  const c = load();
  return c ? { updatedAt: c.updatedAt, count: Object.keys(c.models).length } : null;
}

/** 当前 models.dev 供应商目录的快照；返回新数组，调用方不能改缓存。 */
export function modelProviderMeta(id: string): ModelProviderMeta | null {
  const provider = load()?.providers?.[id];
  return provider ? { ...provider, env: provider.env ? [...provider.env] : undefined } : null;
}

export function modelProvidersMeta(): ModelProviderMeta[] {
  return Object.values(load()?.providers ?? {}).map((provider) => ({
    ...provider,
    env: provider.env ? [...provider.env] : undefined,
  }));
}

/** Provider-scoped catalog suggestions, not a claim that an account can call them. */
export function catalogModels(catalogId: string): { id: string; name?: string }[] {
  if (!catalogId) return [];
  const prefix = `${catalogId}\0`;
  return Object.entries(load()?.models ?? {}).flatMap(([key, meta]) =>
    key.startsWith(prefix) ? [{ id: key.slice(prefix.length), name: meta.name }] : []);
}

export function isModelMetaStale(_catalogs?: readonly string[]): boolean {
  const c = load();
  if (!c?.complete) return true;
  return Date.now() - c.updatedAt > TTL_MS;
}

export function catalogMetaUpdatedAt(catalogId: string): number | null {
  return load()?.catalogs?.[catalogId] ?? null;
}

const finiteNumber = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
const modalities = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? [...new Set(value.filter((m): m is string => typeof m === 'string'))] : undefined;

export function parseModelMeta(m: ModelsDevEntry): ModelMeta {
  const typeDefaults = defaultModalities(m.type);
  const context = finiteNumber(m.limit?.context ?? m.contextWindow);
  const output = finiteNumber(m.limit?.output ?? m.maxTokens);
  const input = modalities(m.modalities?.input ?? m.input ?? m.capabilities?.input) ?? typeDefaults.input;
  const outputModalities = modalities(m.modalities?.output ?? m.output ?? m.capabilities?.output) ?? typeDefaults.output;
  const reasoning = reasoningSupported(m);
  const toolCall = typeof m.tool_call === 'boolean' ? m.tool_call
    : typeof m.capabilities?.tool_call === 'boolean' ? m.capabilities.tool_call
      : typeof m.capabilities?.tools === 'boolean' ? m.capabilities.tools : undefined;
  const structuredOutput = typeof m.structured_output === 'boolean' ? m.structured_output : m.capabilities?.structured_output;
  return {
    type: typeof m.type === 'string' ? m.type : undefined,
    name: typeof m.name === 'string' ? m.name : undefined,
    inputModalities: input,
    outputModalities: outputModalities ?? ['text'],
    declaredContext: context,
    declaredOutput: output,
    declaredReasoning: reasoningSupported(m) || typeof m.reasoning === 'boolean' || m.capabilities?.reasoning !== undefined ? reasoning : undefined,
    declaredToolCall: toolCall,
    structuredOutput,
    lastUpdated: typeof m.last_updated === 'string' ? m.last_updated : undefined,
    context: context || 131072,
    output: output ?? 8192,
    vision: !!input?.includes('image'),
    reasoning,
    toolCall: toolCall !== false,
    thinking: parseThinking(m),
  };
}

/** 全目录仅缓存能力投影；供应商 key 是可选匹配提示，不限制下载范围。 */
let inFlight: Promise<{ count: number }> | undefined;

export function refreshModelMeta(_catalogs?: readonly string[]): Promise<{ count: number }> {
  if (inFlight) return inFlight;
  inFlight = fetchModelMeta().finally(() => { inFlight = undefined; });
  return inFlight;
}

async function fetchModelMeta(): Promise<{ count: number }> {
  const res = await fetch(API_URL, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, ModelsDevProvider>;

  const models: Record<string, ModelMeta> = {};
  const providers: Record<string, ModelProviderMeta> = {};
  const refreshed: string[] = [];
  for (const [catalog, provider] of Object.entries(json ?? {})) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue;
    const env = Array.isArray(provider.env)
      ? [...new Set(provider.env.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
      : undefined;
    const rawBaseUrl = typeof provider.api === 'string' ? provider.api
      : typeof provider.base_url === 'string' ? provider.base_url
        : typeof provider.baseUrl === 'string' ? provider.baseUrl : undefined;
    providers[catalog] = {
      id: catalog,
      name: typeof provider.name === 'string' && provider.name.trim() ? provider.name.trim() : catalog,
      baseUrl: rawBaseUrl?.trim() || undefined,
      npm: typeof provider.npm === 'string' ? provider.npm : undefined,
      env,
      doc: typeof provider.doc === 'string' ? provider.doc : undefined,
    };
    const src = provider?.models;
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    refreshed.push(catalog);
    for (const [id, m] of Object.entries(src)) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
      models[metaKey(catalog, id)] = parseModelMeta(m);
    }
  }
  if (Object.keys(models).length === 0) {
    throw new Error('models.dev 未返回有效模型能力数据');
  }
  const updatedAt = Date.now();
  mem = { version: MODEL_META_CACHE_VERSION, complete: true, updatedAt, models, providers,
    catalogs: Object.fromEntries(refreshed.map((id) => [id, updatedAt])) };
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify(mem));
  } catch {
    // 配额满等场景：内存缓存仍生效，本次会话可用
  }
  for (const fn of listeners) fn();
  return { count: Object.keys(models).length };
}
