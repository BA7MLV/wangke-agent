/**
 * 模型能力元数据：来自 models.dev 的实时数据，**逐供应商**索引，
 * 本地缓存 + 7 天 TTL；未拉取/过期/失败时由 modelCaps.ts 回退到名称启发式。
 *
 * ## 为什么缓存键要带供应商
 *
 * models.dev 的能力表本来就是「provider → models → 能力」的三层结构，而**同一个模型 id
 * 在不同供应商下能力可以不同**。实测全库 3914 个 id 里有 1150 个出现在多个供应商下，
 * 其中大量上下文窗口/模态不一致，例如：
 *
 * - `Qwen/Qwen3.6-35B-A3B`：国际站只支持文本，国内站支持图像 + 视频
 * - `thinkingmachines/Inkling`：deepinfra 524288 上下文，官方只有 65536
 *
 * 旧实现把 `siliconflow` 与 `siliconflow-cn` 拍平成一张 `id → 能力` 表，两者有 31 个同名 id
 * 其中 7 个能力冲突，取到的是「后合并的那一站」的值 —— 能用纯属合并顺序的巧合，
 * 上游改任一侧就会静默失效（视觉识图首当其冲）。现在键是 `catalogId \0 modelId`，冲突从根上消失。
 */

const API_URL = 'https://models.dev/api.json';
const CACHE_KEY = 'wangke-model-meta';
const TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * 缓存结构版本。**字段含义变了就得 +1**，老缓存必须整体作废而不是被误读。
 *
 * v2 → v3：键从裸模型 id 变成 `catalogId \0 modelId`。不升版本的话老缓存里那批无前缀的键
 * 会被当成「catalog 为空的数据」，命中不上任何查询（表现为「能力数据凭空失效」）。
 *
 * 导出它是因为**手写缓存夹具的测试要跟着它走**（scripts/e2e-agent-guard.mjs、
 * scripts/test-thinking-depth.mjs）：版本写错的话那份夹具会被当成过期缓存丢掉。
 */
export const MODEL_META_CACHE_VERSION = 4;

export interface ModelMeta {
  name?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  /** 原始声明用于 UI；运行时 context/output 保留既有兜底。 */
  declaredContext?: number;
  declaredOutput?: number;
  declaredReasoning?: boolean;
  declaredToolCall?: boolean;
  structuredOutput?: boolean;
  cost?: { input?: number; output?: number };
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
  updatedAt: number;
  catalogs?: Record<string, number>;
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
  name?: string;
  last_updated?: string;
  cost?: { input?: number; output?: number };
  structured_output?: boolean;
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  reasoning?: boolean;
  reasoning_options?: ReasoningOption[];
  tool_call?: boolean;
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
function parseThinking(m: ModelsDevEntry): ThinkingControl | null {
  if (!m.reasoning) return null;
  const options = Array.isArray(m.reasoning_options) ? m.reasoning_options : [];
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

let mem: MetaCache | null | undefined; // undefined = 未读 localStorage

function load(): MetaCache | null {
  if (mem !== undefined) return mem;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as MetaCache) : null;
    // 版本对不上就当没有：宁可回退到「元数据缺失」，也不能拿旧结构猜字段
    mem = parsed?.version === MODEL_META_CACHE_VERSION ? parsed : null;
  } catch {
    mem = null;
  }
  return mem;
}

/**
 * 查一个模型在某家供应商下的能力。元数据没有收录（或供应商没填 catalogId）时返回 null。
 *
 * `catalogId` 为空串时**不会**退化成「按模型名全局查」：那正是 v2 拍平表的老 bug，
 * 同名模型在别家的能力会被当成本家的。
 */
export function getModelMeta(catalogId: string, modelId: string): ModelMeta | null {
  if (!catalogId) return null;
  return load()?.models[metaKey(catalogId, modelId)] ?? null;
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

export function isModelMetaStale(catalogs?: readonly string[]): boolean {
  const c = load();
  if (catalogs?.length) return catalogs.some((id) => !c?.catalogs?.[id] || Date.now() - c.catalogs[id] > TTL_MS);
  return !c || Date.now() - c.updatedAt > TTL_MS;
}

export function catalogMetaUpdatedAt(catalogId: string): number | null {
  return load()?.catalogs?.[catalogId] ?? null;
}

const finiteNumber = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
const modalities = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? [...new Set(value.filter((m): m is string => typeof m === 'string'))] : undefined;

export function parseModelMeta(m: ModelsDevEntry): ModelMeta {
  const context = finiteNumber(m.limit?.context);
  const output = finiteNumber(m.limit?.output);
  const input = modalities(m.modalities?.input);
  return {
    name: typeof m.name === 'string' ? m.name : undefined,
    inputModalities: input,
    outputModalities: modalities(m.modalities?.output),
    declaredContext: context,
    declaredOutput: output,
    declaredReasoning: typeof m.reasoning === 'boolean' ? m.reasoning : undefined,
    declaredToolCall: typeof m.tool_call === 'boolean' ? m.tool_call : undefined,
    structuredOutput: typeof m.structured_output === 'boolean' ? m.structured_output : undefined,
    cost: m.cost ? { input: finiteNumber(m.cost.input), output: finiteNumber(m.cost.output) } : undefined,
    lastUpdated: typeof m.last_updated === 'string' ? m.last_updated : undefined,
    context: context || 131072,
    output: output ?? 8192,
    vision: !!input?.includes('image'),
    reasoning: m.reasoning === true,
    toolCall: m.tool_call === true,
    thinking: parseThinking(m),
  };
}

/**
 * 拉取 models.dev 并按 `catalogId \0 modelId` 建能力表。
 *
 * @param catalogs 用户登记过的 models.dev 供应商 key（`Provider.catalogId`）。
 *   **只保留这几家的数据** —— models.dev 全库 226 家 / 3914 个模型，整份存下来对
 *   localStorage 是纯浪费（而配额满了会静默让整份缓存写不进去）。
 *   传空数组则整份都不保留（没有登记就没有查询入口）。
 */
const inFlight = new Map<string, Promise<{ count: number }>>();

export function refreshModelMeta(catalogs: readonly string[]): Promise<{ count: number }> {
  const ids = [...new Set(catalogs.map((id) => id.trim()).filter(Boolean))].sort();
  const key = JSON.stringify(ids);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = fetchModelMeta(ids).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

async function fetchModelMeta(catalogs: readonly string[]): Promise<{ count: number }> {
  const wanted = [...new Set(catalogs.filter((c) => c.trim().length > 0))];
  if (wanted.length === 0) return { count: 0 };

  const res = await fetch(API_URL, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, { models?: Record<string, ModelsDevEntry> }>;

  const models: Record<string, ModelMeta> = {};
  const refreshed: string[] = [];
  for (const catalog of wanted) {
    const src = json?.[catalog]?.models;
    if (!src) continue;
    refreshed.push(catalog);
    for (const [id, m] of Object.entries(src)) {
      if (!m || typeof m !== 'object') continue;
      models[metaKey(catalog, id)] = parseModelMeta(m);
    }
  }
  if (Object.keys(models).length === 0) {
    throw new Error(`models.dev 里没有 ${wanted.join(' / ')} 的模型数据`);
  }
  const previous = load();
  const updatedAt = Date.now();
  const kept = Object.fromEntries(Object.entries(previous?.models ?? {}).filter(([key]) => !refreshed.includes(key.split('\0')[0])));
  mem = { version: MODEL_META_CACHE_VERSION, updatedAt, models: { ...kept, ...models },
    catalogs: { ...previous?.catalogs, ...Object.fromEntries(refreshed.map((id) => [id, updatedAt])) } };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(mem));
  } catch {
    // 配额满等场景：内存缓存仍生效，本次会话可用
  }
  for (const fn of listeners) fn();
  return { count: Object.keys(models).length };
}
