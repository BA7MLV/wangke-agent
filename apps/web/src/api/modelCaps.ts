/**
 * 模型能力查询：用户覆盖优先，未配置字段用 models.dev（按供应商逐家索引）。
 * 视觉/推理能力未知时不按名称猜测；上下文估值仍保留历史兜底。
 *
 * `catalogId` 是可选匹配提示；缺省时仅采用全目录唯一的精确 ID，不按名称猜测。
 *
 * **例外是思考参数**（`thinkingParams`）：它不靠猜模型名，而是查模型自己声明的
 * 旋钮 —— 用户配置优先，其次是厂商文档纠错与目录；都没有就不发深度参数。
 */

import type { ReasoningEffort, ThinkingLevel } from './siliconflow';
import { getModelMeta, type ModelOverrides, type ThinkingControl } from './modelMeta';

export function isVisionModel(catalogId: string, id: string, overrides?: ModelOverrides): boolean {
  return getModelMeta(catalogId, id, overrides)?.vision ?? false;
}

export function supportsThinking(catalogId: string, id: string, overrides?: ModelOverrides): boolean {
  if (overrides?.reasoningEffort !== undefined) return getModelMeta(catalogId, id, overrides)?.reasoning ?? false;
  return !!DOC_EFFORT_MODELS[catalogId]?.[id] || (getModelMeta(catalogId, id)?.reasoning ?? false);
}

/**
 * 硅基流动 API 参考里**点名列出的** effort 模型（逐个 id 写死，不做名字正则）。
 *
 * 出处：`/docs/api/chat-completions-post` 对 `reasoning_effort` 的说明写的是
 * 「该字段适用于 Pro/deepseek-ai/DeepSeek-V4、deepseek-ai/DeepSeek-V4-Flash 以及
 * Pro/zai-org/GLM-5.2」，enum 只有 `high` / `max`（原文：low 与 medium 会映射为 high，
 * xhigh 映射为 max —— 与下面「向下取不超出的最强档」的映射规则正好一致）。
 *
 * **为什么这三条要盖过元数据**：models.dev 的 siliconflow 条目把 DeepSeek-V4-Flash
 * 记成了 `thinking_budget`，与厂商文档冲突。厂商文档钦定了字段，就以它为准 ——
 * 否则这个模型上深度旋钮会静默失效（网关不报错，只是不听）。
 *
 * **按 catalogId 分组**：这份文档只对硅基流动成立。同一个模型 id 接到别家时，
 * 别的供应商未必认 `reasoning_effort`，拿这份文档去覆盖它是错的。
 */
const DOC_EFFORT_MODELS: Record<string, Record<string, string[]>> = {
  siliconflow: {
    'Pro/deepseek-ai/DeepSeek-V4': ['high', 'max'],
    'deepseek-ai/DeepSeek-V4-Flash': ['high', 'max'],
    'Pro/zai-org/GLM-5.2': ['high', 'max'],
  },
  'siliconflow-cn': {
    'Pro/deepseek-ai/DeepSeek-V4': ['high', 'max'],
    'deepseek-ai/DeepSeek-V4-Flash': ['high', 'max'],
    'Pro/zai-org/GLM-5.2': ['high', 'max'],
  },
};

/**
 * 滑块上的 6 档，由弱到强；**第一档是不思考**。
 *
 * 放在 API 层而不是组件里，是因为这 6 档是「思考深度」这个功能的**契约**（档位数、
 * 次序、第一档的含义），不是渲染细节 —— 放这儿才能被 `scripts/test-thinking-depth.mjs`
 * 这类纯逻辑测试钉住（那个测试不碰 DOM，跑不进组件）。组件只负责画。
 *
 * 刻度取 OpenAI `reasoning_effort` 的那一套（none / minimal / low / medium / high / xhigh）：
 * 它是目前事实上的业界标准刻度，Anthropic 的 budget 阶梯、Kimi / GLM 的 low/high/max
 * 都能落在这条刻度上（见 `toEffortValue` 的映射规则）。
 */
export const THINKING_LEVELS: readonly { value: ThinkingLevel; label: string }[] = [
  { value: 'none', label: '不思考' },
  { value: 'minimal', label: '极简' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
];

/**
 * 旧的档位名 → 现在的一套。**只认名字，不猜语义**。
 *
 * `max` 是旧刻度（low / high / max）的最高档，与现在的 `xhigh` 同义 —— 两家对「最高」
 * 的叫法不同（OpenAI 系叫 xhigh，Kimi / GLM 系叫 max），不是两档。
 */
const LEGACY_EFFORT: Record<string, ReasoningEffort> = { max: 'xhigh' };

/**
 * 把任意来源的值收敛成一个合法档位；认不出来返回 null（= 当没设过）。
 *
 * 要挡的是**跨版本 / 跨设备的值**：localStorage 里的旧设置、旧版本导出的迁移包、
 * 将来的同步载荷，都可能带一个现在不存在的档位名。放任它进 store 的后果不是「显示不对」
 * 那么轻 —— 预算型模型的折算会算出 `NaN`，`JSON.stringify` 把它变成 `null` 发出去，
 * 网关回一句和界面现象毫无关系的 400。所以入口处一律收敛。
 *
 * `'none'` 也返回 null：它是滑块第一档，由 `thinkingEnabled` 表达，**不该出现在这个字段里**。
 */
export function normalizeThinkingEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== 'string') return null;
  const legacy = LEGACY_EFFORT[value];
  if (legacy) return legacy;
  const known = THINKING_LEVELS.find((l) => l.value === value);
  return known && known.value !== 'none' ? known.value : null;
}

/**
 * 深度档位 → 预算占声明上限的比例。
 *
 * **逐级对半**（1/16 → 1），不是把区间均匀切五份：思考预算的代价对数量级敏感
 * （Anthropic 给的推荐阶梯就是 1k/2k/4k/8k/16k/32k 这样一路翻倍），均匀切分会让
 * 「极简」和「低」的差别小到看不出来，而「高」与「极高」又差得太远。顶档固定拉满
 * 声明上限 —— 用户选「极高」就是要它把额度用光。
 *
 * 与旧的三档刻度相比，同名字义整体下移了一档（旧的 low=1/4，现在是 1/8）：
 * 刻度从 3 档变 6 档，只能整体重排，不能只往两头加。旧落库值仍然合法（见 settings 的归一化），
 * 只是同一句话现在代表更弱的预算 —— 方向是「更省」，不会撞上限。
 */
const BUDGET_RATIO: Record<ReasoningEffort, number> = {
  minimal: 1 / 16,
  low: 1 / 8,
  medium: 1 / 4,
  high: 1 / 2,
  xhigh: 1,
};

/** 声明里可能出现的档位名，由弱到强（与 modelMeta 的白名单一致） */
const EFFORT_ORDER: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 档位名 → 强弱次序。**`xhigh` 与 `max` 并列最高**：两家对「最高档」的叫法不同
 * （OpenAI 系叫 xhigh，Kimi / GLM 系叫 max），语义都是「拉到最满」。并列之后，
 * 我们最高那一档（`xhigh`）才能落到只声明了 `max` 的模型上 —— 否则会退成 `high`，
 * 用户把滑块拉到最右却拿不到最强档（硅基流动文档原文也是「xhigh 映射为 max」）。
 */
const EFFORT_RANK: Record<string, number> = {
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 5,
};
const rankOf = (lane: string) => EFFORT_RANK[lane] ?? 0;
/** 同档并列时的次序（`max` 排在 `xhigh` 之后，故并列时取 `max`）：两个都声明了的模型极罕见，
 *  定死只是为了结果可复现，而不是让「谁排前面」影响发出去的参数。 */
const tieBreakOf = (lane: string) => EFFORT_ORDER.indexOf(lane);

/**
 * 把我们的档位映射到模型声明的档位名。
 *
 * 声明的档位集逐模型不同（GLM-5.2 只有 high/max），所以不能把自己的档位名硬塞进去 ——
 * 取**不超过目标的最强档**；若声明的全都比目标强（在 GLM-5.2 上选「极简」），
 * 退到其中最弱的那档，即「用户要更弱，但模型最弱也就这样」。
 *
 * 映射是**单调不减**的（档位只升不降），所以「只声明 2 档的模型上中间几档落到同一档」
 * 是必然结果而不是 bug —— 那是模型真没有那么多档，不是我们没听指令。
 */
function toEffortValue(lanes: readonly string[], effort: ReasoningEffort): string {
  const sorted = [...lanes].sort((a, b) => rankOf(a) - rankOf(b) || tieBreakOf(a) - tieBreakOf(b));
  if (sorted.length === 0) return effort;
  const want = rankOf(effort);
  const notStronger = sorted.filter((lane) => rankOf(lane) <= want);
  return notStronger.length > 0 ? notStronger[notStronger.length - 1] : sorted[0];
}

/**
 * 模型声明的思考控制方式：用户覆盖 > 厂商文档纠错 > models.dev。
 * 都没有就是 null（= 不知道，不猜）。
 */
export function thinkingControlOf(catalogId: string, id: string, overrides?: ModelOverrides): ThinkingControl | null {
  if (overrides?.reasoningEffort !== undefined) return getModelMeta(catalogId, id, overrides)?.thinking ?? null;
  const lanes = DOC_EFFORT_MODELS[catalogId]?.[id];
  if (lanes) return { toggle: true, effort: lanes };
  return getModelMeta(catalogId, id)?.thinking ?? null;
}

/** 这个模型能不能调思考深度：只有它声明了 effort 档位或 budget 区间才算 */
export function hasThinkingDepth(catalogId: string, id: string, overrides?: ModelOverrides): boolean {
  const control = thinkingControlOf(catalogId, id, overrides);
  return !!control && (!!control.effort?.length || !!control.budget);
}

/**
 * 按模型生成思考参数。**参数形状由模型自己声明的旋钮决定，不由我们挑**：
 *
 * | 传入档位 / 模型声明 | 发什么 |
 * |---|---|
 * | `none`（滑块第一档） | `enable_thinking: false` |
 * | `effort` 档位 | `reasoning_effort`，取值映射到它声明的档位名 |
 * | `budget_tokens` 区间 | `thinking_budget`，按区间上限的比例算 |
 * | 只有开关 / 元数据缺失 | **只发 `enable_thinking`**，深度参数一律不发 |
 *
 * 第一行是「6 档」这次加的：**「不思考」不是把深度调到最小，而是关掉思考**，所以发
 * `enable_thinking: false` 而不是 `reasoning_effort: 'none'` —— 后者不在硅基流动的 enum
 * 里（只有 high/max），发出去会被拒或静默忽略。它必须排在查声明之前：即便元数据完全缺失
 * （`thinkingControlOf` 返回 null），用户选的「不思考」也应当明确发出去 ——
 * 混合思考模型（Qwen3 系）默认可能是开着的，**什么都不发等于没关掉**。
 *
 * 最后一行是重点：以前这里是 `/(deepseek-v4|glm-5\.2)/` 猜模型名 + 写死 2048/8192/32768，
 * 猜错就等于把一个模型不认的参数发出去（旋钮静默失效，或直接被网关拒）。
 * 现在没声明就没有深度参数 —— 深度控件也跟着不显示（见 `hasThinkingDepth`）。
 */
export function thinkingParams(catalogId: string, model: string, level: ThinkingLevel, overrides?: ModelOverrides) {
  if (level === 'none') return { enable_thinking: false };
  const control = thinkingControlOf(catalogId, model, overrides);
  if (control?.effort?.length) {
    return { enable_thinking: true, reasoning_effort: toEffortValue(control.effort, level) };
  }
  const ceiling = control?.budget?.max;
  // `ratio != null` 在类型上恒真（level 就是 ReasoningEffort），但它挡的是**运行时**的
  // 旧档位名：算不出比例就退到「只发 enable_thinking」，绝不让 NaN 混进请求体
  // （NaN 序列化成 null，网关只会回一句跟界面现象毫无关系的 400）。
  const ratio = BUDGET_RATIO[level];
  if (ceiling != null && ratio != null) {
    const floor = control?.budget?.min ?? 0;
    const budget = Math.min(Math.max(Math.round(ceiling * ratio), floor), ceiling);
    return { enable_thinking: true, thinking_budget: budget };
  }
  // 只声明了开关（或压根没有元数据）：开着思考，不编深度参数
  return { enable_thinking: true };
}

/**
 * 模型单次输出的上限（tokens），即 `max_tokens` 的天花板；元数据缺失时回退到 8192。
 *
 * 与 `contextWindow` 不是一回事：这个只管**输出**那一半，窗口是输入+输出的总容量。
 * 超了它网关直接拒，所以每轮算输出预算时拿它当上限。
 *
 * 实测在架模型（models.dev）：DeepSeek-V4-Pro 384k、Kimi-K3 / GLM-5.2 262k、
 * Qwen3.5-122B 64k，但也有 Qwen2.5-72B 只有 4k —— **所以必须逐模型取，不能取全局最大**。
 */
export function outputLimitOf(catalogId: string, id: string, overrides?: ModelOverrides): number {
  return getModelMeta(catalogId, id, overrides)?.output ?? 8192;
}

/**
 * 算输出预算时该用的窗口：**取设置值与模型真实窗口里更大的那个**。
 *
 * 为什么不用设置值：`contextWindow` 是给历史裁剪用的**保守估值**（默认 131072），
 * 用户不一定改过，而模型真实窗口可能是 1M（DeepSeek-V4-Pro / Kimi-K3 / GLM-5.2）。
 * 拿估值当上限会让 `max_tokens` 被压到几万，白白浪费模型能力 ——
 * 而 `max_tokens` 是天花板不是预留，给足不花钱。
 *
 * 取 max 而不是无条件信元数据：设置值可能被用户**调大**过（换过窗口更大的服务），
 * 那是显式意图，不能被元数据拉回去。两者都缺时返回 null，交给调用方按未知处理。
 * 模型编辑器中的显式窗口覆盖优先于上述估值，无论它调大还是调小。
 */
export function effectiveContextWindow(
  catalogId: string,
  id: string,
  configured?: number | null,
  overrides?: ModelOverrides,
): number | null {
  if (overrides?.contextWindow !== undefined) return overrides.contextWindow;
  const meta = getModelMeta(catalogId, id)?.context ?? null;
  const conf = configured != null && configured > 0 ? configured : null;
  if (meta == null && conf == null) return null;
  return Math.max(meta ?? 0, conf ?? 0);
}

/** 启发式上下文窗口对照表（tokens），仅作元数据缺失时的兜底，未知 131072 */
const WINDOW_TABLE: [RegExp, number][] = [
  [/deepseek-v4/i, 1000000],
  [/deepseek/i, 131072],
  [/qwen3-vl/i, 262144],
  [/qwen3/i, 131072],
  [/qwen2\.5/i, 131072],
  [/glm/i, 131072],
  [/kimi|moonshot/i, 131072],
  [/gpt-4o|gpt-5/i, 128000],
  [/claude/i, 200000],
  [/gemini/i, 1048576],
];

export function guessContextWindow(catalogId: string, id: string, overrides?: ModelOverrides): number {
  const meta = getModelMeta(catalogId, id, overrides);
  if (meta) return meta.context;
  for (const [re, win] of WINDOW_TABLE) if (re.test(id)) return win;
  return 131072;
}
