/**
 * 模型能力元数据：来自 models.dev 的实时数据（含硅基流动在架模型），
 * 本地缓存 + 7 天 TTL；未拉取/过期/失败时由 modelCaps.ts 回退到名称启发式。
 */

const API_URL = 'https://models.dev/api.json';
const CACHE_KEY = 'wangke-model-meta';
const TTL_MS = 7 * 24 * 3600 * 1000;
/**
 * 缓存结构版本。**字段含义变了就得 +1**：老缓存里没有 `thinking`，
 * 而「没有」和「模型没声明旋钮」在数据上长得一样 —— 不升版本会把老缓存
 * 误读成「这个模型不支持深度」，于是深度控件凭空消失且没人知道为什么。
 *
 * 导出它是因为**手写缓存夹具的测试要跟着它走**（scripts/e2e-agent-guard.mjs）：
 * 版本写错的话那份夹具会被当成过期缓存丢掉，测试表现为「能力数据凭空失效」。
 */
export const MODEL_META_CACHE_VERSION = 2;

export interface ModelMeta {
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
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[] };
  reasoning?: boolean;
  reasoning_options?: ReasoningOption[];
  tool_call?: boolean;
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

export function getModelMeta(id: string): ModelMeta | null {
  return load()?.models[id] ?? null;
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
      thinking: parseThinking(m),
    };
  }
  if (Object.keys(models).length === 0) throw new Error('models.dev 返回数据为空');
  mem = { version: MODEL_META_CACHE_VERSION, updatedAt: Date.now(), models };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(mem));
  } catch {
    // 配额满等场景：内存缓存仍生效，本次会话可用
  }
  for (const fn of listeners) fn();
  return { count: Object.keys(models).length };
}
