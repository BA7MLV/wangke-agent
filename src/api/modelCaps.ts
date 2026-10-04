/**
 * 模型能力查询：优先用 models.dev 实时元数据（见 modelMeta.ts），
 * 未拉取/未收录时回退到按模型名的启发式推断，可能误判。
 *
 * **例外是思考参数**（`thinkingParams`）：它不靠猜模型名，而是查模型自己声明的
 * 旋钮 —— 厂商 API 参考点名的走文档，其余走元数据，两处都没有就不发深度参数。
 */

import type { ReasoningEffort } from './siliconflow';
import { getModelMeta, type ThinkingControl } from './modelMeta';

const VISION_RE = /([-_/]vl|vision|gpt-4o|gpt-5|gemini|claude|qwen3-vl|internvl|minicpm-v|glm-4v|step-1v|kimi-latest|moonshot-v1-.*-vision)/i;
const THINK_RE = /(r1|qwen3|qwq|glm-z1|glm-5|glm-4\.[56]|hunyuan-t1|thinking|reasoner|deepseek-v3\.2|deepseek-v4|k2-thinking)/i;

export function isVisionModel(id: string): boolean {
  return getModelMeta(id)?.vision ?? VISION_RE.test(id);
}

export function supportsThinking(id: string): boolean {
  return getModelMeta(id)?.reasoning ?? THINK_RE.test(id);
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
 */
const DOC_EFFORT_MODELS: Record<string, string[]> = {
  'Pro/deepseek-ai/DeepSeek-V4': ['high', 'max'],
  'deepseek-ai/DeepSeek-V4-Flash': ['high', 'max'],
  'Pro/zai-org/GLM-5.2': ['high', 'max'],
};

/** 档位 → 预算占声明上限的比例。低=1/4 够快，高=1/2，最大=拉满 */
const BUDGET_RATIO: Record<ReasoningEffort, number> = { low: 0.25, high: 0.5, max: 1 };

/** effort 档位的强弱次序（与 modelMeta 的白名单一致）：模型声明的值都是它的子集 */
const EFFORT_ORDER: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 把我们的三档映射到模型声明的档位名。
 *
 * 声明的档位集逐模型不同（GLM-5.2 只有 high/max），所以不能把自己的档位名硬塞进去 ——
 * 取**不超过目标的最强档**；若声明的全都比目标强（在 GLM-5.2 上选「低」），
 * 退到其中最弱的那档，即「用户要更弱，但模型最弱也就这样」。
 */
function toEffortValue(model: string, effort: ReasoningEffort): string {
  const lanes = (thinkingControlOf(model)?.effort ?? [])
    .filter((lane) => EFFORT_ORDER.includes(lane))
    .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  if (lanes.length === 0) return effort;
  const want = EFFORT_ORDER.indexOf(effort);
  const notStronger = lanes.filter((lane) => EFFORT_ORDER.indexOf(lane) <= want);
  return notStronger.length > 0 ? notStronger[notStronger.length - 1] : lanes[0];
}

/**
 * 模型声明的思考控制方式。**厂商文档点名的走文档，其余走 models.dev 元数据**，
 * 两处都没有就是 null（= 不知道，不猜）。
 */
export function thinkingControlOf(id: string): ThinkingControl | null {
  const lanes = DOC_EFFORT_MODELS[id];
  if (lanes) return { toggle: true, effort: lanes };
  return getModelMeta(id)?.thinking ?? null;
}

/** 这个模型能不能调思考深度：只有它声明了 effort 档位或 budget 区间才算 */
export function hasThinkingDepth(id: string): boolean {
  const control = thinkingControlOf(id);
  return !!control && (!!control.effort?.length || !!control.budget);
}

/**
 * 按模型生成思考参数。**参数形状由模型自己声明的旋钮决定，不由我们挑**：
 *
 * | 模型声明 | 发什么 |
 * |---|---|
 * | `effort` 档位 | `reasoning_effort`，取值映射到它声明的档位名 |
 * | `budget_tokens` 区间 | `thinking_budget`，按区间上限的比例算 |
 * | 只有开关 / 元数据缺失 | **只发 `enable_thinking`**，深度参数一律不发 |
 *
 * 第三行是重点：以前这里是 `/(deepseek-v4|glm-5\.2)/` 猜模型名 + 写死 2048/8192/32768，
 * 猜错就等于把一个模型不认的参数发出去（旋钮静默失效，或直接被网关拒）。
 * 现在没声明就没有深度参数 —— 深度控件也跟着不显示（见 `hasThinkingDepth`）。
 */
export function thinkingParams(model: string, effort: ReasoningEffort) {
  const control = thinkingControlOf(model);
  if (control?.effort?.length) {
    return { enable_thinking: true, reasoning_effort: toEffortValue(model, effort) };
  }
  const ceiling = control?.budget?.max;
  if (ceiling != null) {
    const floor = control?.budget?.min ?? 0;
    const budget = Math.min(Math.max(Math.round(ceiling * BUDGET_RATIO[effort]), floor), ceiling);
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
export function outputLimitOf(id: string): number {
  return getModelMeta(id)?.output ?? 8192;
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
 */
export function effectiveContextWindow(id: string, configured?: number | null): number | null {
  const meta = getModelMeta(id)?.context ?? null;
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

export function guessContextWindow(id: string): number {
  const meta = getModelMeta(id);
  if (meta) return meta.context;
  for (const [re, win] of WINDOW_TABLE) if (re.test(id)) return win;
  return 131072;
}
